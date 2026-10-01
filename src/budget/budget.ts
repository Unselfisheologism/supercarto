import type { SpatialGraph, GraphNode, GraphEdge } from '../compile/graph.js';
import { estimateTokens } from '../emit/yaml.js';
import { oppositeCompass, type Compass } from '../geo/geometry.js';

/**
 * Token budgeting.
 *
 * The problem: an agent's context has a fixed price per token, and a dense city
 * centre produces a graph far larger than any useful prompt. The naive fix is
 * to truncate, which produces a confident agent reasoning over a map that lies
 * to it by omission.
 *
 * The approach here: rank what matters, keep the subgraph that preserves
 * connectivity and named landmarks, and report exactly what was dropped.
 */

export interface BudgetOptions {
  /** Target token count for the emitted YAML. */
  readonly budget: number;
  /** Fraction of budget reserved for the header, omissions, and tools. */
  readonly overheadFraction?: number;
  /**
   * How far a node may sit from the map centre and still be kept, as a fraction
   * of the graph's radius. Default 1.0 (keep everything, then rank).
   */
  readonly radiusFraction?: number;
  /** Keep at least this many named landmarks, whatever the budget. Default 8. */
  readonly minLandmarks?: number;
  /** Emit the `omitted:` block even when nothing was dropped. Default true. */
  readonly alwaysReportOmissions?: boolean;
}

export interface BudgetResult {
  graph: SpatialGraph;
  tokens: number;
  /** Nodes dropped to fit the budget. */
  droppedNodes: number;
  /** Edges dropped to fit the budget. */
  droppedEdges: number;
  /** True when the budget forced any change. */
  applied: boolean;
}

const DEFAULT_OVERHEAD = 0.12;
/**
 * Landmarks guaranteed per 100 tokens of budget.
 *
 * A named place costs roughly 12 tokens in the emitted graph, so this ratio
 * keeps landmarks at about a third of the output: enough that "where is a cafe
 * near here" has a real answer, without starving the network they hang off.
 */
const DEFAULT_LANDMARKS_PER_TOKEN = 100;

/**
 * Fit a graph to a token budget.
 *
 * Drop order is deliberate, and each step is chosen for what an agent would
 * least miss:
 *  1. Anonymous intersection nodes on long chains (the agent needs routes, not
 *     every bend) - these are collapsed, not deleted, so edges stay connected.
 *  2. Edges to already-disconnected, unnamed, non-navigational nodes.
 *  3. Nodes with no name, no kind significance, and low degree.
 *  4. As a last resort, landmarks furthest from the centre.
 */
export function fitToBudget(graph: SpatialGraph, opts: BudgetOptions): BudgetResult {
  const budget = Math.max(64, opts.budget);
  const overhead = Math.floor(budget * (opts.overheadFraction ?? DEFAULT_OVERHEAD));
  const target = budget - overhead;
  // The landmark floor scales with the budget. A flat floor of 8 is right for a
  // 256-token query and wrong for a 2048-token one: at larger budgets the caller
  // is explicitly paying for more map, and a map of eight places is a worse
  // answer than a map of forty.
  const minLandmarks = opts.minLandmarks ?? Math.max(
    4,
    Math.round(budget / DEFAULT_LANDMARKS_PER_TOKEN),
  );

  const nodes = [...graph.nodes];
  const edges = [...graph.edges];
  const omissions: SpatialGraph['omitted'] = [...graph.omitted];
  // Landmarks the budgeter is allowed to keep even under heavy pressure. The
  // compiler pins the landmarks it attached to the network, because an
  // unattached name is useless; the budgeter does not need to re-protect
  // their junctions, since removing a landmark removes its access edge with it
  // and the pair stays coherent either way.
  const landmarks = new Set<string>(graph.pinned);

  let droppedNodes = 0;
  let droppedEdges = 0;

  const recordOmission = (layer: string, count: number) => {
    const existing = omissions.find((o) => o.layer === layer);
    if (existing) existing.count += count;
    else omissions.push({ layer, count, near: 'unspecified' });
  };

  // --- Pass 1: chain contraction -----------------------------------------
  // A node with exactly two edges and no name contributes nothing an agent can
  // reference. Contract it and join its neighbours, preserving reachability.
  contractAnonymousChains(nodes, edges, (removed) => {
    droppedNodes += removed;
    recordOmission('waypoint', removed);
  });

  // --- Pass 2: iterative pruning by rank ----------------------------------
  const ranked = rankNodes(nodes, edges);
  const keep = new Set<string>();

  for (const node of ranked) keep.add(node.id);

  // Prune by rank until the estimate fits.
  //
  // Removal is batched and cut vertices are computed once per batch rather than
  // once per node. Recomputing articulation points is O(V+E), so doing it for
  // each of ~900 removals made this stage take tens of seconds on a real
  // extract. A batch can overshoot into a vertex that is a cut point at that
  // moment, which is why the batch is halved whenever it stalls, converging on
  // the same graph at a fraction of the cost.
  let current = estimateGraphTokens(nodes, edges, graph);
  let guard = 0;
  let batch = Math.max(1, Math.floor(nodes.length / 8));
  let stalls = 0;

  while (current > target && guard++ < 2000) {
    const cuts = articulationPoints(nodes, edges, keep);
    const liveNamed = nodes.filter((n) => keep.has(n.id) && n.name !== undefined).length;

    // Walk the ranking from the bottom, taking removable nodes until the batch
    // is full. `ranked` is ordered best-first, so iterating in reverse drops the
    // least important nodes first, which is the whole point of ranking them.
    // A node is removable when it is anonymous or the landmark floor permits,
    // is not a cut vertex, and does not orphan a landmark.
    const remove = new Set<string>();
    let namedLeft = liveNamed;
    // Count the edges that survive the current keep set, so the "keep the last
    // connection" rule below is judged against what is actually left rather
    // than the original edge list, which never shrinks in place.
    let liveEdgeCount = 0;
    for (const e of edges) if (keep.has(e.from) && keep.has(e.to)) liveEdgeCount++;

    for (let i = ranked.length - 1; i >= 0; i--) {
      const n = ranked[i]!;
      if (remove.size >= batch) break;
      if (!keep.has(n.id) || remove.has(n.id)) continue;
      if (cuts.has(n.id)) continue;
      // Never take the last connections. A map with no edges advertises places
      // the agent cannot reach, which is worse than a smaller map it can
      // navigate, so the last edge pair is always retained.
      if (liveEdgeCount - incidentCount(edges, n.id) < 2) continue;
      if (n.name !== undefined) {
        if (namedLeft <= minLandmarks) continue;
        namedLeft--;
      }
      if (wouldOrphanLandmark(edges, n.id, landmarks, keep)) continue;
      remove.add(n.id);
    }

    if (remove.size === 0) {
      // Nothing safe at this batch size. Halve and retry, which reaches
      // protected nodes individually instead of stalling outright.
      if (batch > 1) {
        batch = Math.floor(batch / 2);
        if (++stalls > 8) break;
        continue;
      }
      break;
    }

    for (const id of remove) keep.delete(id);
    droppedNodes += remove.size;
    recordOmission('feature', remove.size);

    const live = nodes.filter((n) => keep.has(n.id));
    const liveEdges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
    droppedEdges = Math.max(droppedEdges, edges.length - liveEdges.length);
    current = estimateGraphTokens(live, liveEdges, graph);

    nodes.length = 0;
    nodes.push(...live);
    edges.length = 0;
    edges.push(...liveEdges);

    // Adapt the batch to how much the graph actually gives up. As the mesh
    // thins, fewer nodes are removable per pass, so a batch that was full
    // earlier starts returning short. Growing on a short batch would ratchet
    // the loop straight into the stall counter and stop far above the target;
    // shrinking instead lets it keep making progress at the achievable rate.
    if (remove.size >= batch) {
      batch = Math.min(live.length, batch + Math.max(1, Math.floor(batch / 4)));
      stalls = 0;
    } else {
      batch = Math.max(1, Math.min(batch, remove.size * 2));
      stalls = 0;
    }
  }

  // Pruning can turn a dense mesh into a long thin chain of anonymous
  // intersections. Those are exactly the vertices the first pass removed, so
  // re-run contraction afterwards: the chain collapses to a single long edge
  // and the budget is spent on structure rather than on every bend.
  //
  // Junctions that a landmark hangs off are excluded, because contracting one
  // would delete the landmark's access edge along with it and leave the name
  // stranded with no route.
  if (droppedNodes > 0) {
    const holders = new Set<string>();
    for (const e of edges) {
      if (landmarks.has(e.to)) holders.add(e.from);
      if (landmarks.has(e.from)) holders.add(e.to);
    }
    contractAnonymousChains(nodes, edges, (removed) => {
      droppedNodes += removed;
      recordOmission('waypoint', removed);
    }, holders);
  }

  const finalGraph: SpatialGraph = {
    ...graph,
    nodes,
    edges,
    omitted: omissions,
    pinned: [...landmarks],
    partial: graph.partial || droppedNodes > 0 || droppedEdges > 0,
  };

  const applied = droppedNodes > 0 || droppedEdges > 0;
  if (opts.alwaysReportOmissions !== false && !applied) {
    finalGraph.omitted = omissions;
  }

  return { graph: finalGraph, tokens: current, droppedNodes, droppedEdges, applied };
}

/**
 * Importance score. Higher survives longer.
 *
 * The weights encode what an agent needs: a named cafe matters more than an
 * unnamed bend, high connectivity matters more than a dead end, and being near
 * the centre matters more than being at the fringe.
 */
export function scoreNode(node: GraphNode, degree: number, maxDegree: number): number {
  let score = 0;
  if (node.name) score += 100;
  if (node.kind === 'transit') score += 40;
  if (node.kind === 'poi') score += 30;
  if (node.kind === 'building') score += 20;
  if (node.kind === 'entrance') score += 20;
  if (node.tags && node.tags.length > 0) score += 10;
  if (node.heightM !== undefined) score += 5;
  // Connectivity, normalized so a hub outranks a leaf without dominating.
  score += maxDegree > 0 ? (degree / maxDegree) * 25 : 0;
  return score;
}

/**
 * Rank nodes for survival, worst first.
 *
 * The ordering is not purely by semantic value. A named cafe wedged onto the
 * street network is worth far more to an agent than the same cafe stranded on
 * an island with no edges, because the agent can only act on a landmark it can
 * reach. So a node that is not part of the connected network is demoted below
 * every node that is, regardless of how important its name sounds.
 */
function rankNodes(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  const degrees = degreeMap(nodes, edges);
  const inNetwork = nodesInMainComponent(nodes, edges);
  // The road network is what an agent navigates by, so it must not be
  // outranked by landmarks no matter how well-connected they are. A map whose
  // largest component is a shop is not a map.
  const networkKinds = new Set(['intersection']);
  let maxDegree = 0;
  for (const d of degrees.values()) if (d > maxDegree) maxDegree = d;

  return [...nodes].sort((a, b) => {
    const sa = scoreNode(a, degrees.get(a.id) ?? 0, maxDegree);
    const sb = scoreNode(b, degrees.get(b.id) ?? 0, maxDegree);
    const na = inNetwork.has(a.id) ? 1 : 0;
    const nb = inNetwork.has(b.id) ? 1 : 0;
    if (na !== nb) return na - nb;
    // Streets outrank anonymous junctions, and landmarks outrank both: an
    // agent asked "where is a cafe" needs the cafe, and the junction it hangs
    // off is retained automatically because it is pinned.
    const tier = (n: GraphNode): number => {
      if (networkKinds.has(n.kind)) return 1;
      if (n.name !== undefined) return 2;
      return 0;
    };
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    return sb - sa;
  });
}

/**
 * Node ids in the largest connected component, weighted toward the road network.
 *
 * A plain largest-component search is wrong when landmarks outnumber streets,
 * which is common in a real city extract: a cluster of shops can be the biggest
 * component by node count even though it is not a navigable network. Street
 * nodes are counted with extra weight so the component that wins is the one
 * that carries the map.
 */
function nodesInMainComponent(nodes: GraphNode[], edges: GraphEdge[]): Set<string> {
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n.id, new Set());
  for (const e of edges) {
    if (e.from === e.to) continue;
    adj.get(e.from)?.add(e.to);
    adj.get(e.to)?.add(e.from);
  }

  // Street nodes dominate the size of a component; landmarks contribute, but
  // cannot form one on their own.
  const weight = (id: string): number => {
    const node = nodes.find((n) => n.id === id);
    return node?.kind === 'intersection' ? 10 : 1;
  };

  let best: string[] = [];
  let bestScore = -1;
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    const component: string[] = [];
    const stack = [n.id];
    seen.add(n.id);
    let score = 0;
    while (stack.length > 0) {
      const id = stack.pop()!;
      component.push(id);
      score += weight(id);
      for (const nb of adj.get(id) ?? []) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        stack.push(nb);
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = component;
    }
  }
  return new Set(best);
}

function degreeMap(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const n of nodes) degrees.set(n.id, 0);
  for (const e of edges) {
    degrees.set(e.from, (degrees.get(e.from) ?? 0) + 1);
    degrees.set(e.to, (degrees.get(e.to) ?? 0) + 1);
  }
  return degrees;
}

/** How many edges touch `id`. */
function incidentCount(edges: GraphEdge[], id: string): number {
  let n = 0;
  for (const e of edges) {
    if (e.from === id || e.to === id) n++;
  }
  return n;
}

/**
 * Whether removing `id` would leave a surviving named landmark with no route.
 *
 * The compiler attaches each landmark to exactly one junction, so a landmark's
 * degree is 2 and losing that junction strands it. This is the invariant that
 * keeps the map usable: a name the agent can see but cannot walk to is worse
 * than an absent one, because the agent will try.
 */
function wouldOrphanLandmark(
  edges: GraphEdge[],
  id: string,
  landmarks: ReadonlySet<string>,
  keep: ReadonlySet<string>,
): boolean {
  const neighbours = touchingIds(edges, id).filter((o) => keep.has(o));
  return neighbours.some((other) => {
    if (!landmarks.has(other)) return false;
    const surviving = touchingIds(edges, other).filter(
      (o) => o !== id && keep.has(o),
    ).length;
    return surviving === 0;
  });
}

/** The ids on the other end of every edge touching `id`, in either direction. */
function touchingIds(edges: GraphEdge[], id: string): string[] {
  const out: string[] = [];
  for (const e of edges) {
    if (e.from === id) out.push(e.to);
    else if (e.to === id) out.push(e.from);
  }
  return out;
}

/**
 * Cut vertices of the graph, ignoring nodes outside `keep`.
 *
 * Iterative Tarjan, because a 50,000-node extract would overflow the stack on
 * the recursive form. Undirected, deduplicated adjacency: the graph carries
 * mirrored directed edges, so `n1<->n2` is one link, not two.
 */
function articulationPoints(
  nodes: GraphNode[],
  edges: GraphEdge[],
  keep: Set<string>,
): Set<string> {
  const live = nodes.filter((n) => keep.has(n.id));

  // Build an undirected adjacency list over the live subgraph.
  const adj = new Map<string, Set<string>>();
  for (const n of live) adj.set(n.id, new Set());
  for (const e of edges) {
    if (!keep.has(e.from) || !keep.has(e.to)) continue;
    if (e.from === e.to) continue;
    adj.get(e.from)?.add(e.to);
    adj.get(e.to)?.add(e.from);
  }

  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string | undefined>();
  const cuts = new Set<string>();
  let clock = 0;

  for (const root of live) {
    if (disc.has(root.id)) continue;
    // Explicit stack of [node, neighbourIterator].
    const stack: { id: string; iter: Iterator<string> }[] = [
      { id: root.id, iter: adj.get(root.id)![Symbol.iterator]() },
    ];
    disc.set(root.id, clock);
    low.set(root.id, clock);
    clock++;
    parent.set(root.id, undefined);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const next = frame.iter.next();
      if (next.done) {
        stack.pop();
        const p = parent.get(frame.id);
        if (p !== undefined) {
          // Propagate the low point upward, then test for a cut.
          const childLow = low.get(frame.id)!;
          const parentLow = low.get(p)!;
          if (childLow < parentLow) low.set(p, childLow);
          if (parentLow >= disc.get(p)!) cuts.add(p);
        }
        continue;
      }
      const v = next.value;
      if (v === parent.get(frame.id)) continue;
      if (disc.has(v)) {
        const dv = disc.get(v)!;
        if (dv < low.get(frame.id)!) low.set(frame.id, dv);
        continue;
      }
      parent.set(v, frame.id);
      disc.set(v, clock);
      low.set(v, clock);
      clock++;
      stack.push({ id: v, iter: adj.get(v)![Symbol.iterator]() });
    }
  }

  return cuts;
}

/**
 * Remove degree-2 unnamed nodes by joining their neighbours.
 * Returns the number of nodes contracted.
 */
export function contractAnonymousChains(
  nodes: GraphNode[],
  edges: GraphEdge[],
  onRemove?: (count: number) => void,
  /** Node ids that must not be contracted, whatever their degree. */
  protectedIds?: ReadonlySet<string>,
): number {
  let removed = 0;
  for (;;) {
    // Judge by *distinct neighbours*, not edge count. Every line contributes
    // two opposite directed edges, so an interior chain node has four incident
    // edges but only two neighbours. Counting edges would report every
    // vertex as a degree-2 candidate and contract the wrong ones.
    const neighbourCount = distinctNeighbourMap(nodes, edges);
    const victim = nodes.find(
      (n) =>
        !n.name &&
        n.kind === 'intersection' &&
        !protectedIds?.has(n.id) &&
        (neighbourCount.get(n.id) ?? 0) === 2,
    );
    if (victim === undefined) break;

    // A bidirectional chain gives an interior node two inbound and two
    // outbound edges: one leg toward each neighbour, mirrored in both
    // directions. So the collapsible shape is exactly two distinct
    // neighbours, each reachable both ways. Three or more neighbours is a real
    // junction and must be kept.
    const inbound = edges.filter((e) => e.to === victim.id);
    const outbound = edges.filter((e) => e.from === victim.id);
    if (inbound.length !== 2 || outbound.length !== 2) break;

    // A neighbour is "before" the victim when an edge runs neighbour -> victim,
    // and "after" when an edge runs victim -> neighbour. Both sets must contain
    // the same two nodes; otherwise the passage is one-way or asymmetric, and
    // collapsing it would invent or destroy a restriction.
    const before = new Set(inbound.map((e) => e.from));
    const after = new Set(outbound.map((e) => e.to));
    if (before.size !== 2 || after.size !== 2) break;
    for (const n of before) if (!after.has(n)) break;
    for (const n of after) if (!before.has(n)) break;

    const neighbours = [...before];
    const beforeId = neighbours[0]!;
    const afterId = neighbours[1]!;
    if (beforeId === afterId) break;

    // The through passage is before -> victim -> after. Pairing the inbound leg
    // with the outbound leg to the *same* neighbour would be a backtrack.
    const inLeg = inbound.find((e) => e.from === beforeId)!;
    const outLeg = outbound.find((e) => e.to === afterId)!;

    // Sum the axis deltas so the emitter's per-axis scaling stays correct
    // across a contraction; a straight-line distance would not survive it.
    const dir = outLeg.dir;
    const dx = inLeg.dx + outLeg.dx;
    const dy = inLeg.dy + outLeg.dy;
    const dist = Math.hypot(dx, dy);
    const features = dedupe([...inLeg.features, ...outLeg.features]);

    // The through passage, forward: before -> after.
    const forward: GraphEdge = {
      from: beforeId,
      to: afterId,
      dist,
      dx,
      dy,
      dir: outLeg.dir,
      features,
    };
    // The mirror: after -> before, with the axis deltas negated so the reverse
    // traversal is geometrically correct rather than merely relabelled.
    const reverse: GraphEdge = {
      from: afterId,
      to: beforeId,
      dist,
      dx: -dx,
      dy: -dy,
      dir: oppositeCompass(outLeg.dir),
      features,
    };
    const p = inLeg.path ?? outLeg.path;
    if (p) {
      forward.path = p;
      reverse.path = p;
    }
    if (inLeg.crosswalk) {
      forward.crosswalk = true;
      reverse.crosswalk = true;
    }
    if (inLeg.blocked) {
      forward.blocked = true;
      reverse.blocked = true;
    }

    // Drop all four incident edges and insert the join in both directions. The
    // reverse is mandatory: an agent reading a directed graph assumes one-way
    // semantics, so a one-way join would invent a restriction that is not in
    // the source data.
    for (let i = edges.length - 1; i >= 0; i--) {
      const e = edges[i]!;
      if (e.from === victim.id || e.to === victim.id) edges.splice(i, 1);
    }
    edges.push(forward, reverse);

    const ni = nodes.findIndex((n) => n.id === victim.id);
    nodes.splice(ni, 1);
    removed++;
  }
  if (removed > 0) onRemove?.(removed);
  return removed;
}

/** Map each node id to the number of distinct nodes it connects to. */
function distinctNeighbourMap(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const sets = new Map<string, Set<string>>();
  for (const n of nodes) sets.set(n.id, new Set());
  for (const e of edges) {
    sets.get(e.from)?.add(e.to);
    sets.get(e.to)?.add(e.from);
  }
  const out = new Map<string, number>();
  for (const [id, s] of sets) out.set(id, s.size);
  return out;
}

/** Cheap token estimate for a graph, without building the YAML string. */
export function estimateGraphTokens(
  nodes: GraphNode[],
  edges: GraphEdge[],
  graph: SpatialGraph,
): number {
  // Empirically a node line averages ~28 chars and an edge line ~46 in flow
  // style. Using a constant is far cheaper than serializing on every iteration.
  const nodeChars = nodes.length * 28;
  const edgeChars = edges.length * 46;
  const overheadChars =
    120 + graph.obstacles.length * 40 + graph.omitted.length * 40 + graph.heat.length * 60;
  return Math.ceil((nodeChars + edgeChars + overheadChars) / 4);
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export { estimateTokens };

import type { Envelope, ScrDocument } from './wire/types.js';
import { encodeDocument } from './wire/encode.js';
import { decodeDocument } from './wire/decode.js';
import { fromGeoJson, type IngestOptions } from './ingest/geojson.js';
import { compile, type CompileOptions } from './compile/compiler.js';
import { fitToBudget, articulationPoints, contractAnonymousChains, applyRemovalsValidated, type BudgetOptions, type BudgetResult } from './budget/budget.js';
import { emitGraph, type EmitOptions, type EmitResult } from './emit/yaml.js';
import { gridScaleFor, type GridScale } from './geo/scale.js';
import type { GeoJsonFeature, GeoJsonFeatureCollection } from './ingest/geojson.js';
import type { GraphNode, SpatialGraph } from './compile/graph.js';
import type { Capabilities } from './toolcatalog.js';

/** One encoder for the process; `TextEncoder` runs everywhere `Buffer` does not. */
const wireTextEncoder = new TextEncoder();

export interface MapletRequest {
  /** Slippy tile envelope, or a bbox. */
  readonly envelope?: Envelope;
  /** Build the envelope from these bounds instead. */
  readonly bbox?: { west: number; south: number; east: number; north: number };
  /** Which layers to include. `null` or omitted means everything. */
  readonly layers?: readonly string[] | null;
  /** Target token budget for the reasoning output. */
  readonly budget?: number;
  /** Human-readable radius, echoed into the graph metadata. */
  readonly radiusLabel?: string;
  /**
   * Whether the caller has an elevation source.
   *
   * Only affects which tools the graph advertises, so a maplet never points an
   * agent at `get_terrain` unless the deployment can answer it.
   */
  readonly hasElevation?: boolean;
  /** Full capability set. Overrides `hasElevation` for tool advertisement. */
  readonly capabilities?: Capabilities;
  readonly ingest?: IngestOptions;
  readonly compile?: CompileOptions;
  readonly emit?: EmitOptions;
  readonly budgetOpts?: Omit<BudgetOptions, 'budget'>;
  /**
   * Compile this document instead of ingesting `input`.
   *
   * For callers that already hold an `ScrDocument` and have enriched it - the
   * live path attaches derived heat layers to the fetched document. Feeding
   * that back in as GeoJSON would silently drop them, because heat lives on the
   * document and not on any feature: the round trip through features rebuilds a
   * document with an empty heat list. Passing the document through is the only
   * way to keep what was derived.
   */
  readonly doc?: ScrDocument;
}

export interface MapletResult {
  /** The wire document, before compilation. */
  doc: ScrDocument;
  /** SCR text, useful for debugging and for a machine-side cache. */
  scr: string;
  /** The compiled graph, after budget fitting. */
  graph: BudgetResult['graph'];
  /** LLM-native YAML. */
  yaml: string;
  /** Token accounting, so a caller can log the cost of a map request. */
  metrics: {
    budget: number;
    tokens: number;
    wireBytes: number;
    wireTokens: number;
    yamlTokens: number;
    nodes: number;
    edges: number;
    droppedNodes: number;
    droppedEdges: number;
  };
}

/**
 * The one-call path: GeoJSON in, token-budgeted YAML out.
 *
 * Every stage is also exported individually, but this is what a server should
 * call, because the stages have a required order and one meaningful set of
 * defaults.
 */
export function toMaplet(
  input: GeoJsonFeatureCollection | GeoJsonFeature[],
  req: MapletRequest = {},
): MapletResult {  const envelope = req.envelope ??
    (req.bbox
      ? ({ type: 'bbox', ...req.bbox } satisfies Envelope)
      : undefined);

  let doc =
    req.doc ??
    fromGeoJson(input, { ...req.ingest, ...(envelope ? { envelope } : {}) });

  if (req.layers && req.layers.length > 0) {
    doc = filterLayers(doc, new Set(req.layers));
  }

  const scr = encodeDocument(doc, { group: false });
  const graph = compile(doc, {
    ...req.compile,
    ...(req.radiusLabel ? { radiusLabel: req.radiusLabel } : {}),
    capabilities:
      req.capabilities ??
      { elevation: req.hasElevation ?? false, weather: false, traffic: false },
  });

  const budget = req.budget ?? 1024;
  const fitted = fitToBudget(graph, { ...req.budgetOpts, budget });

  // Distances become metres only once the document's real-world scale is
  // known. This is what turns `dist: 47u` into `dist: 47m`.
  const scale = gridScaleFor(doc);
  // Orphan names survive only on explicit POI-only requests. Everywhere
  // else the safety net stands: a name without a street misleads. Bench
  // fixtures compile without layers, so their behavior is unchanged.
  const layers = req.layers ?? [];
  const poiOnly =
    layers.length > 0 && !layers.some((l) => l === 'road' || l === 'highway');
  const emitted = emitAndVerify(
    fitted,
    poiOnly ? { ...req.emit, keepOrphans: true } : req.emit,
    scale,
    budget,
  );

  return {
    doc,
    scr,
    graph: emitted.graph,
    yaml: emitted.result.yaml,
    metrics: {
      budget,
      tokens: emitted.result.tokens,
      wireBytes: wireTextEncoder.encode(scr).length,
      wireTokens: Math.ceil(wireTextEncoder.encode(scr).length / 4),
      yamlTokens: emitted.result.tokens,
      nodes: emitted.graph.nodes.length,
      edges: emitted.graph.edges.length,
      droppedNodes: emitted.dropped,
      droppedEdges: 0,
    },
  };
}

/**
 * Obstacles whose named edge is no longer in the graph. An obstacle names an
 * edge as `from->to`; when budget shrinking or chain contraction removes
 * either endpoint, the warning has nothing to warn about. Dropping it keeps
 * the emitted map coherent: every carrier line refers to something present.
 */
function pruneStaleObstacles(graph: BudgetResult['graph']): BudgetResult['graph'] {
  const alive = new Set(graph.edges.map((e) => `${e.from}->${e.to}`));
  if (graph.obstacles.every((o) => alive.has(o.edge))) return graph;
  return { ...graph, obstacles: graph.obstacles.filter((o) => alive.has(o.edge)) };
}

/**
 * Emit, then verify against the real serializer and shrink if needed.
 *
 * `fitToBudget` works from a cheap linear estimate so it can iterate fast, but
 * an estimate is not a guarantee: a graph full of long street names can
 * overshoot. This closes the loop by measuring the actual output and, if it is
 * over budget, dropping the weakest landmarks until it fits. Without this the
 * caller gets a promise the library does not keep.
 */
function emitAndVerify(
  fitted: BudgetResult,
  emitOpts: EmitOptions | undefined,
  scale: GridScale | undefined,
  budget: number,
): { graph: BudgetResult['graph']; result: EmitResult; dropped: number } {
  const render = (g: BudgetResult['graph']): EmitResult =>
    emitGraph(g, { ...emitOpts, scale: emitOpts?.scale ?? scale });

  // An obstacle that names an edge the budget removed is a warning about
  // nothing, and an agent that sees it will avoid a route that no longer
  // exists in the map it holds. Cut them wherever the graph thins, so every
  // render sees a coherent graph.
  let graph = pruneStaleObstacles(fitted.graph);
  let result = render(graph);
  let dropped = fitted.droppedNodes;

  // Shrink until the real output fits.
  //
  // Two properties keep this cheap enough to be worth doing at all:
  //
  // 1. Removals are batched. Re-serializing the whole document after every
  //    single node is O(V) per node and O(V^2) overall, which took minutes on a
  //    950-node extract. A batch is removed on a cheap heuristic, then the real
  //    render decides whether the batch was enough.
  // 2. The omission list is aggregated, not appended per node. One line per
  //    dropped landmark costs more than the map it describes and can consume
  //    the whole budget on bookkeeping. "137 landmarks omitted" is both cheaper
  //    and more useful than 137 separate lines.
  let batch = Math.max(1, Math.min(8, Math.floor(graph.nodes.length / 40)));
  let stalls = 0;
  // Pressure valve, mirroring fitToBudget: cut vertices join the candidate
  // pool only after connected pruning is exhausted, so the graph fragments
  // only when staying whole cannot reach the budget.
  let allowCuts = false;

  for (let guard = 0; guard < 3000 && result.tokens > budget; guard++) {
    // Keep a minimal but *navigable* skeleton. A map with no nodes answers no
    // question; a map with no edges is worse, because it advertises places the
    // agent cannot reach and it will try. The floor is small on purpose -
    // honouring the caller's budget outranks retaining a shape they did not ask
    // for - but it must leave at least one connected pair.
    // A connected pair is worth protecting; edgelessness is not a shape.
    // With no edges there is nothing to keep navigable, so the loop may
    // thin unnamed nodes until the output fits. Anonymous candidates fill the
    // batch first; a named node is picked only when its whole access dies with
    // the batch (the validator couples it to its holder) or nothing anonymous
    // remains at hard pressure. The safety net still owns edgeless orphans.
    if (graph.nodes.length <= 2) break;
    if (graph.edges.length === 2) break; // one pair left: the floor
    const holding = junctionsHoldingLandmarks(graph);
    const cap =
      graph.edges.length < 2
        ? batch
        : Math.max(1, Math.min(batch, graph.nodes.length - 3, graph.edges.length - 2));
    const named = new Set(
      graph.nodes.filter((n) => n.name !== undefined).map((n) => n.id),
    );
    const victims = pickBatch(graph, holding, cap, allowCuts).filter(
      (id) => graph.edges.length >= 2 || !named.has(id),
    );
    if (victims.length === 0) {
      // No connected candidate at all: connected pruning is exhausted. Admit
      // cut vertices rather than spend names - mirroring the pressure valve in
      // fitToBudget. With the valve open this doubles as the halve-and-retry
      // path, which reaches the protected nodes one at a time.
      if (batch > 1) {
        batch = Math.floor(batch / 2);
        stalls++;
        if (stalls > 6) break;
        if (batch === 1 && !allowCuts) {
          // True exhaustion: empty even one at a time, so connected pruning
          // cannot reach the budget. Open the pressure valve rather than
          // spend names - mirroring fitToBudget.
          allowCuts = true;
          stalls = 0;
        }
        continue;
      }
      if (!allowCuts) {
        // Batch is already 1, so "halve and retry" has nothing to halve, yet
        // cut vertices were never admitted. Open the valve here and give the
        // escape route its attempt; previously the valve was unreachable
        // exactly in the small-graph case, and the loop broke out silently
        // over budget.
        allowCuts = true;
        stalls = 0;
        continue;
      }
      break;
    }

    const remove = new Set(victims);
    graph = {
      ...graph,
      nodes: graph.nodes.filter((n) => !remove.has(n.id)),
      edges: graph.edges.filter((e) => !remove.has(e.from) && !remove.has(e.to)),
      omitted: bumpOmission(graph.omitted, 'landmark', victims.length),
      partial: true,
    };
    dropped += victims.length;
    // Safe leaf pruning exposes anonymous chains. Collapse those paths rather
    // than spending the remaining budget on their intermediate junctions.
    contractAnonymousChains(graph.nodes, graph.edges, (count) => {
      dropped += count;
      graph = { ...graph, omitted: bumpOmission(graph.omitted, 'waypoint', count), partial: true };
    }, junctionsHoldingLandmarks(graph));
    graph = pruneStaleObstacles(graph);
    result = render(graph);

    // Adapt the batch: grow while a full batch is removable, shrink when the
    // graph stops yielding nodes.
    if (victims.length >= batch) {
      batch = Math.min(graph.nodes.length, batch + Math.max(1, Math.floor(batch / 4)));
      stalls = 0;
    } else {
      batch = Math.max(1, victims.length);
      stalls = 0;
    }
  }

  // Safety net: a named node with no edges is a name the agent can see but
  // cannot route to. It is worse than an absent one, because the agent will
  // confidently try to walk to it. Remove any that survived, and record the loss
  // so the map still reports itself as partial. Skipped for explicitly
  // POI-only requests (keepOrphans): edgelessness there is the answer,
  // not a defect, and stripping it would return an empty map for a
  // question the data does answer.
  if (!emitOpts?.keepOrphans) {
    const touched = new Set<string>();
    for (const e of graph.edges) {
      touched.add(e.from);
      touched.add(e.to);
    }
    const orphans = graph.nodes.filter(
      (n) => n.name !== undefined && !touched.has(n.id),
    );
    if (orphans.length > 0) {
      const remove = new Set(orphans.map((n) => n.id));
      graph = {
        ...graph,
        nodes: graph.nodes.filter((n) => !remove.has(n.id)),
        edges: graph.edges.filter((e) => !remove.has(e.from) && !remove.has(e.to)),
        omitted: bumpOmission(graph.omitted, 'landmark', orphans.length),
        partial: true,
      };
      dropped += orphans.length;
      result = render(graph);
    }
  }
  return { graph, result, dropped };
}

/**
 * Up to `limit` node ids to drop, worst-first, never orphaning a named
 * landmark and never taking the last connections.
 *
 * Two rules order the suffering, both about what an agent loses first:
 * anonymous junctions go before names, whatever their degrees say - the
 * stage that owns this call has already thinned the network, and after it
 * a name is the only thing on the map worth more than a bend. And the
 * batch is validated as one unit rather than per candidate: recomputing
 * cuts after every candidate is O(V+E) each and measured in tens of
 * seconds on a dense extract, while a batch-level validation with
 * rollback-and-bisection costs a handful of the same passes per batch and
 * enforces the identical invariant - no removal, and no combination of
 * removals in the batch, may split a surviving component.
 */
function pickBatch(
  graph: BudgetResult['graph'],
  skip: Set<string>,
  limit: number,
  allowCuts = false,
): string[] {
  const incident = new Map<string, number>();
  for (const e of graph.edges) {
    incident.set(e.from, (incident.get(e.from) ?? 0) + 1);
    incident.set(e.to, (incident.get(e.to) ?? 0) + 1);
  }

  const keep = new Set(graph.nodes.map((n) => n.id));
  const cuts = articulationPoints(graph.nodes, graph.edges, keep);
  let edgesLeft = graph.edges.length;
  // Harm tiers, lowest first: anonymous junctions before names, connected
  // candidates before cut vertices. The sort makes the escalation explicit -
  // fragmentation is cheaper than name death, name death is cheaper than
  // stranding, and the validator owns stranding outright.
  const scored = graph.nodes.map((n) => ({
    id: n.id,
    tier: (n.name !== undefined ? 2 : 0) + (cuts.has(n.id) ? 1 : 0),
    score: (n.name !== undefined ? 1000 : 0) + landmarkScore(n),
  }));
  scored.sort((a, b) => a.tier - b.tier || a.score - b.score);

  const candidates: string[] = [];
  for (const { id, tier } of scored) {
    if (candidates.length >= limit) break;
    // Sorted by tier, so with fragmentation withheld the first cut vertex ends
    // the connected supply.
    if (!allowCuts && tier >= 1) break;
    if (skip.has(id)) continue;
    // Keep at least two edges so the map stays navigable. Vacant on edgeless
    // graphs: with nothing to keep connected, unnamed nodes thin freely and
    // named ones are filtered by the caller, never here.
    const cost = incident.get(id) ?? 0;
    if (edgesLeft >= 2 && edgesLeft - cost < 2) continue;
    candidates.push(id);
    keep.delete(id);
    edgesLeft -= cost;
  }

  // Validate the batch on scratch copies of the graph. Every named node is a
  // landmark here, and the name floor does not apply - this stage is the last
  // resort, so a landmark whose whole access dies with the batch may go with
  // it rather than strand. No batch among the candidates may strand a name
  // either way.
  const namedIds = new Set(graph.nodes.filter((n) => n.name !== undefined).map((n) => n.id));
  const scratchNodes = [...graph.nodes];
  const scratchEdges = [...graph.edges];
  const scratchKeep = new Set(graph.nodes.map((n) => n.id));
  const applied = applyRemovalsValidated(candidates, scratchNodes, scratchEdges, scratchKeep, namedIds, namedIds, !allowCuts);
  return candidates.filter((id) => applied.has(id));
}

/** Increment an aggregated omission count, keeping one entry per layer. */
function bumpOmission(
  omitted: SpatialGraph['omitted'],
  layer: string,
  count = 1,
): SpatialGraph['omitted'] {
  const existing = omitted.find((o) => o.layer === layer);
  if (existing) {
    return omitted.map((o) => (o === existing ? { ...o, count: o.count + count } : o));
  }
  return [...omitted, { layer, count, near: 'unspecified' }];
}

/**
 * Junctions that are the only remaining access to a named landmark.
 *
 * A landmark is reachable only through its neighbours, so any junction on the
 * path from a landmark to the rest of the network is load-bearing. The cheap
 * approximation is to protect every direct neighbour of a landmark: cheap
 * enough to run per iteration, and correct for the access edges the compiler
 * creates, which attach each landmark to exactly one junction.
 */
function junctionsHoldingLandmarks(graph: BudgetResult['graph']): Set<string> {
  const degree = new Map<string, number>();
  for (const n of graph.nodes) degree.set(n.id, 0);
  for (const e of graph.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const named = new Set(
    graph.nodes.filter((n) => n.name !== undefined).map((n) => n.id),
  );

  // A junction is load-bearing when a named landmark depends on it for all but
  // a trivial share of its connections. Protecting only junctions whose
  // landmark has degree 1 is not enough: as the graph thins, a landmark whose
  // degree has fallen to 2 can still lose its last real route when its second
  // neighbour is cut.
  const holding = new Set<string>();
  for (const e of graph.edges) {
    if (named.has(e.to) && (degree.get(e.to) ?? 0) <= 2) holding.add(e.from);
    if (named.has(e.from) && (degree.get(e.from) ?? 0) <= 2) holding.add(e.to);
  }
  return holding;
}
/** Value of keeping a landmark. Higher survives longer. */
function landmarkScore(n: GraphNode): number {
  let score = 0;
  if (n.heightM !== undefined) score += 2;
  score += (n.tags?.length ?? 0) * 3;
  if (n.kind === 'transit') score += 10;
  else if (n.kind === 'poi') score += 5;
  else if (n.kind === 'building') score += 3;
  return score;
}

/** Keep only the named layers, recording the rest as omissions. */
export function filterLayers(doc: ScrDocument, keep: Set<string>): ScrDocument {
  const layerIds = new Set<number>();
  for (const [id, layer] of doc.layers) {
    if (keep.has(layer.name)) layerIds.add(id);
  }

  // Count what is about to be dropped, per layer. This must happen before the
  // layer table is narrowed, otherwise the omission records lose the layer
  // names and the agent is told a count for "layer2" instead of "building".
  const dropped = new Map<number, number>();
  for (const f of doc.features) {
    if (!layerIds.has(f.layerId)) {
      dropped.set(f.layerId, (dropped.get(f.layerId) ?? 0) + 1);
    }
  }

  const next: ScrDocument = {
    ...doc,
    // The layer table is narrowed to what survived, but the dropped layers are
    // retained so their omission records still resolve to a human-readable
    // name at compile time.
    layers: doc.layers,
    classes: new Map([...doc.classes].filter(([, c]) => layerIds.has(c.layerId))),
    features: doc.features.filter((f) => layerIds.has(f.layerId)),
  };

  for (const [layerId, count] of dropped) {
    next.omissions.push({ layerId, count });
  }
  if (dropped.size > 0) {
    const total = [...dropped.values()].reduce((a, b) => a + b, 0);
    next.meta.omitted_total = String(total);
  }
  return next;
}

/** Compile an already-encoded SCR document, without re-ingesting. */
export function fromScr(
  scr: string,
  opts: { budget?: number; compile?: CompileOptions; emit?: EmitOptions; budgetOpts?: Omit<BudgetOptions, 'budget'> } = {},
): MapletResult {
  const doc = decodeDocument(scr);
  const graph = compile(doc, opts.compile);
  const budget = opts.budget ?? 1024;
  const fitted = fitToBudget(graph, { ...opts.budgetOpts, budget });
  const emitted = emitAndVerify(fitted, opts.emit, gridScaleFor(doc), budget);
  return {
    doc,
    scr,
    graph: emitted.graph,
    yaml: emitted.result.yaml,
    metrics: {
      budget,
      tokens: emitted.result.tokens,
      wireBytes: wireTextEncoder.encode(scr).length,
      wireTokens: Math.ceil(wireTextEncoder.encode(scr).length / 4),
      yamlTokens: emitted.result.tokens,
      nodes: emitted.graph.nodes.length,
      edges: emitted.graph.edges.length,
      droppedNodes: emitted.dropped,
      droppedEdges: 0,
    },
  };
}

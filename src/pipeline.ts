import type { Envelope, ScrDocument } from './wire/types.js';
import { encodeDocument } from './wire/encode.js';
import { decodeDocument } from './wire/decode.js';
import { fromGeoJson, type IngestOptions } from './ingest/geojson.js';
import { compile, type CompileOptions } from './compile/compiler.js';
import { fitToBudget, type BudgetOptions, type BudgetResult } from './budget/budget.js';
import { emitGraph, type EmitOptions, type EmitResult } from './emit/yaml.js';
import { gridScaleFor, type GridScale } from './geo/scale.js';
import type { GeoJsonFeature, GeoJsonFeatureCollection } from './ingest/geojson.js';
import type { GraphNode, SpatialGraph } from './compile/graph.js';
import type { Capabilities } from './toolcatalog.js';

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
): MapletResult {
  const envelope = req.envelope ??
    (req.bbox
      ? ({ type: 'bbox', ...req.bbox } satisfies Envelope)
      : undefined);

  let doc = fromGeoJson(input, { ...req.ingest, ...(envelope ? { envelope } : {}) });

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
  const emitted = emitAndVerify(fitted, req.emit, scale, budget);

  return {
    doc,
    scr,
    graph: emitted.graph,
    yaml: emitted.result.yaml,
    metrics: {
      budget,
      tokens: emitted.result.tokens,
      wireBytes: Buffer.byteLength(scr, 'utf8'),
      wireTokens: Math.ceil(Buffer.byteLength(scr, 'utf8') / 4),
      yamlTokens: emitted.result.tokens,
      nodes: emitted.graph.nodes.length,
      edges: emitted.graph.edges.length,
      droppedNodes: emitted.dropped,
      droppedEdges: 0,
    },
  };
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

  let graph = fitted.graph;
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

  for (let guard = 0; guard < 3000 && result.tokens > budget; guard++) {
    // Keep a minimal but *navigable* skeleton. A map with no nodes answers no
    // question; a map with no edges is worse, because it advertises places the
    // agent cannot reach and it will try. The floor is small on purpose -
    // honouring the caller's budget outranks retaining a shape they did not ask
    // for - but it must leave at least one connected pair.
    if (graph.nodes.length <= 2 || graph.edges.length <= 2) break;

    const holding = junctionsHoldingLandmarks(graph);
    const cap = Math.max(1, Math.min(batch, graph.nodes.length - 3, graph.edges.length - 2));
    const victims = pickBatch(graph, holding, cap);
    if (victims.length === 0) {
      // Nothing safe left at this batch size. Shrink the batch and retry, which
      // reaches the protected nodes one at a time instead of stalling.
      if (batch > 1) {
        batch = Math.floor(batch / 2);
        stalls++;
        if (stalls > 6) break;
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
    result = render(graph);

    // Adapt the batch: grow while a full batch is removable, shrink when the
    // graph stops yielding nodes.
    if (victims.length >= batch) {
      batch = Math.min(graph.nodes.length, batch + Math.max(1, Math.floor(batch / 4)));
      stalls = 0;
    } else {
      stalls++;
      if (stalls > 6) break;
    }
  }

  // Safety net: a named node with no edges is a name the agent can see but
  // cannot route to. It is worse than an absent one, because the agent will
  // confidently try to walk to it. Remove any that survived, and record the loss
  // so the map still reports itself as partial.
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

  return { graph, result, dropped };
}

/**
 * Up to `limit` node ids to drop, worst-first, never orphaning a named
 * landmark and never taking the last connections.
 *
 * Each node takes its incident edges with it, so the surviving edge count is
 * tracked while the batch is built rather than checked afterwards. Sizing the
 * batch by node count alone is what previously let one batch delete the whole
 * network, leaving a map of names with no routes.
 */
function pickBatch(
  graph: BudgetResult['graph'],
  skip: Set<string>,
  limit: number,
): string[] {
  const scored = graph.nodes.map((n) => ({
    id: n.id,
    // Higher is more important; sort ascending so the batch takes the worst.
    score: (n.name !== undefined ? 1000 : 0) + landmarkScore(n),
  }));
  scored.sort((a, b) => a.score - b.score);

  const incident = new Map<string, number>();
  for (const e of graph.edges) {
    incident.set(e.from, (incident.get(e.from) ?? 0) + 1);
    incident.set(e.to, (incident.get(e.to) ?? 0) + 1);
  }

  const out: string[] = [];
  let edgesLeft = graph.edges.length;
  for (const { id } of scored) {
    if (out.length >= limit) break;
    if (skip.has(id)) continue;
    // Keep at least two edges so the map stays navigable.
    const cost = incident.get(id) ?? 0;
    if (edgesLeft - cost < 2) continue;
    out.push(id);
    edgesLeft -= cost;
  }
  return out;
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
      wireBytes: Buffer.byteLength(scr, 'utf8'),
      wireTokens: Math.ceil(Buffer.byteLength(scr, 'utf8') / 4),
      yamlTokens: emitted.result.tokens,
      nodes: emitted.graph.nodes.length,
      edges: emitted.graph.edges.length,
      droppedNodes: emitted.dropped,
      droppedEdges: 0,
    },
  };
}

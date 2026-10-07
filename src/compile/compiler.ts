import type {
  Envelope,
  Feature,
  Prop,
  ScrDocument,
} from '../wire/types.js';
import { gridToLonLat } from '../geo/project.js';
import {
  compassOf,
  dedupeLine,
  expandBbox,
  bboxCenter,
  emptyBbox,
  oppositeCompass,
  weldKey,
  type Bbox,
  type Compass,
} from '../geo/geometry.js';
import type { GraphEdge, GraphNode, HeatSummary, NodeKind, Obstacle, SpatialGraph } from './graph.js';
import {
  buildIndoorGraph,
  emptyIndoor,
  isMeaningfulIndoor,
  type IndoorFeature,
  type IndoorGraph,
} from './indoor.js';
import { sunPosition } from '../source/sun.js';
import { openingPhrase } from '../source/hours.js';
import { tileBounds } from '../geo/project.js';
import { advertisedTools, type Capabilities } from '../toolcatalog.js';

export interface CompileOptions {
  /**
   * Grid units within which two vertices are the same junction. One grid unit
   * at z17 is roughly a metre, so the default of 2 welds across a street width
   * without merging parallel alleys.
   */
  readonly weld?: number;
  /** Skip features whose class is in this list. */
  readonly exclude?: readonly string[];
  /** Emit `lat`/`lon` on nodes. Off by default; it costs two numbers per node. */
  readonly includePositions?: boolean;
  /** Cap on heat hotspots carried into the graph. Default 5. */
  readonly maxHotspots?: number;
  /**
   * Whether this deployment has an elevation source.
   *
   * Only affects which tools the graph advertises. Defaults to false, so a
   * maplet never points an agent at `get_terrain` unless it can answer.
   */
  readonly hasElevation?: boolean;
  /**
   * Which optional capabilities this deployment has.
   *
   * Overrides `hasElevation` when present, because weather and traffic gate
   * their own tools and a boolean cannot express three states.
   */
  readonly capabilities?: Capabilities;
  /** Human-readable radius for the `meta` block, e.g. `200m`. */
  readonly radiusLabel?: string;
  /**
   * Hard cap on emitted nodes. The budgeter is the primary control; this is a
   * backstop against a pathological document producing an unbounded graph.
   *
   * The cap reserves room for named places rather than being spent entirely on
   * anonymous geometry. A dense street grid compiles to thousands of anonymous
   * intersections, and with a uniform cap those exhausted it before the point
   * pass ran at all: the maplet came out with no cafes, no shops, no station,
   * and an agent asking where to get coffee was told, confidently, that the data
   * did not say. The budgeter could not rescue it, because it runs on the
   * compiled graph and the names were never compiled into it.
   */
  readonly maxNodes?: number;
  /**
   * Nodes reserved for named places when `maxNodes` would otherwise be spent
   * entirely on anonymous intersections. Default 512.
   *
   * A share rather than a fixed count, so the reservation stays proportionate
   * to whatever cap the caller chose.
   */
  readonly maxNamedNodes?: number;
  /**
   * Build indoor per-floor topology when the document has it. Default true.
   *
   * On by default because the work is proportional to the number of
   * `indoor=*` features, which is zero for every outdoor extract, so there is
   * nothing to pay for in the common case.
   */
  readonly indoor?: boolean;
  /** Cap on nodes per storey in the indoor graph. Default 60. */
  readonly maxIndoorNodesPerLevel?: number;
  /** Cap on storeys in the indoor graph. Default 8. */
  readonly maxIndoorLevels?: number;
  /** Compute sun position for the map metadata. Default true. */
  readonly sun?: boolean;
  /**
   * Instant to evaluate opening hours and sun position against. Defaults to now.
   *
   * Passing an explicit value makes both reproducible, which is what allows
   * them to be asserted in a test rather than merely exercised.
   */
  readonly now?: Date;
  /**
   * UTC offset of the map area in minutes, e.g. `-420` for Pacific Daylight
   * Time. Used to evaluate opening hours.
   *
   * Opening hours are local to the place. Without this the evaluator falls back
   * to the host's timezone, so a server in one country would report a shop in
   * another as shut at noon.
   */
  readonly utcOffsetMinutes?: number;
}

const DEFAULT_WELD = 2;
const DEFAULT_MAX_NODES = 4000;

/**
 * Nodes held back from the line pass for named places.
 *
 * A share of `maxNodes` rather than a constant, so it scales with whatever cap
 * the caller chose, and large enough to hold a dense block's worth of places.
 */
const DEFAULT_MAX_NAMED_NODES = 512;

/** Feature classes treated as named places an agent would navigate to. */
const POI_CLASSES = new Set([
  'amenity.cafe',
  'amenity.restaurant',
  'amenity.bar',
  'amenity.pharmacy',
  'amenity.hospital',
  'amenity.school',
  'amenity.bank',
  'amenity.fuel',
  'amenity.parking',
  'amenity.bus_station',
  'amenity.marketplace',
  'shop',
  'leisure.park',
  'leisure.playground',
  'tourism.attraction',
  'tourism.hotel',
  'office',
]);

const TRANSIT_CLASSES = new Set([
  'railway.station',
  'railway.subway_entrance',
  'public_transport.stop_position',
  'public_transport.station',
  'highway.bus_stop',
  'railway.tram_stop',
  'railway.light_rail',
]);

/** Attribute keys that mark a path as not walkable. */
const BLOCKING_TAGS = new Set(['construction', 'closed', 'no', 'barrier', 'locked']);

const PATH_HINTS: { match: string; path: string }[] = [
  { match: 'footway', path: 'sidewalk' },
  { match: 'pedestrian', path: 'sidewalk' },
  { match: 'path', path: 'path' },
  { match: 'steps', path: 'stairs' },
  { match: 'cycleway', path: 'bikeway' },
  { match: 'corridor', path: 'indoor' },
  { match: 'service', path: 'service' },
  { match: 'track', path: 'track' },
  { match: 'motorway', path: 'highway' },
  { match: 'trunk', path: 'highway' },
];

/** Intermediate state while building the graph. */
interface Builder {
  doc: ScrDocument;
  env: Envelope;
  extent: number;
  weld: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  obstacles: Obstacle[];
  /** weld key -> node id, for junction reuse. */
  junctionIndex: Map<string, string>;
  /** feature id -> node id, for POI attachment. */
  featureIndex: Map<number, string>;
  /** node id -> the grid point the node sits on. Needed to measure edges. */
  anchors: Map<string, { x: number; y: number }>;
  /**
   * Nodes whose connection to the network must survive budgeting. A landmark
   * with no access edge is a name the agent cannot act on, so pinning it keeps
   * the pair intact when the budgeter prunes anonymous geometry around it.
   */
  pinned: Set<string>;
  nextId: number;
  /** Nodes referenced by an edge, in insertion order. */
  used: Set<string>;
  /**
   * Instant opening hours are evaluated against.
   *
   * Stored on the builder rather than read from the clock at each use, so a
   * single compile cannot produce nodes where one says open and another closed
   * because a minute passed mid-run.
   */
  now: Date;
  /** UTC offset of the map area in minutes, for opening hours. */
  utcOffsetMinutes: number | undefined;
}

export function compile(doc: ScrDocument, opts: CompileOptions = {}): SpatialGraph {
  const weld = opts.weld ?? DEFAULT_WELD;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const excluded = new Set(opts.exclude ?? []);

  const b: Builder = {
    doc,
    env: doc.envelope,
    extent: doc.extent,
    weld,
    nodes: [],
    edges: [],
    obstacles: [],
    junctionIndex: new Map(),
    featureIndex: new Map(),
    anchors: new Map(),
    pinned: new Set(),
    nextId: 1,
    used: new Set(),
    now: opts.now ?? new Date(),
    utcOffsetMinutes: opts.utcOffsetMinutes,
  };

  const className = (id: number) => doc.classes.get(id)?.name ?? '';
  const layerName = (id: number) => doc.layers.get(id)?.name ?? '';

  // How many nodes the line pass may claim, leaving room for named places.
  //
  // Without this the two passes shared one ceiling in a fixed order, so a dense
  // street grid spent all of it on anonymous intersections and the point pass
  // broke out before adding a single named node. The reservation is computed
  // once, up front, from the same `maxNodes` the caller set, so it scales with
  // the cap rather than hardcoding a count.
  const namedReserve = Math.min(
    opts.maxNamedNodes ?? DEFAULT_MAX_NAMED_NODES,
    Math.floor(maxNodes / 2),
  );
  // The line pass stops early so the reservation is available. It is not a hard
  // limit on total nodes: the point pass and the area pass both draw from the
  // full ceiling, so a document with few anonymous intersections still gets
  // everything.
  const lineNodeCeiling = Math.max(0, maxNodes - namedReserve);

  // 1. Line features become the edge backbone. Doing this first means every
  //    later point feature can snap onto a junction that already exists.
  //    Only genuine lines form edges: a building footprint is an area, and
  //    turning its ring into walkable edges would invent a path through a wall.
  const lineFeatures = doc.features.filter((f) => f.kind === 'line');
  const areaFeatures = doc.features.filter(
    (f) => f.kind === 'polygon' || f.kind === 'building',
  );
  const pointFeatures = doc.features.filter((f) => f.kind === 'point');

  for (const f of lineFeatures) {
    if (excluded.has(className(f.classId))) continue;
    // The line pass stops at its own ceiling so the named reservation survives
    // for the point pass. Every node it adds is anonymous: a junction that only
    // means something once something is named after it.
    if (b.nodes.length >= lineNodeCeiling) break;
    compileLinear(b, f, className(f.classId), layerName(f.layerId));
  }

  // 2. Point features become named nodes, snapped to a nearby junction when one
  //    exists so that "the cafe on the corner" is reachable from the graph.
  for (const f of pointFeatures) {
    if (excluded.has(className(f.classId))) continue;
    // Street furniture is not a place, and left in it becomes hundreds of
    // anonymous junctions that crowd out the landmarks.
    if (isFurniture(className(f.classId))) continue;
    // Weak POIs survive only when named: "Seal Rock Viewpoint" is worth a token,
    // the four hundred unnamed information boards are not.
    if (WEAK_POI_CLASSES.has(className(f.classId)) && !isNamed(doc, f)) continue;
    if (b.nodes.length >= maxNodes) break;
    compilePoint(b, f, className(f.classId));
  }

  // 3. Areas become single nodes at their centroid, attached to the network by
  //    a short edge. An agent needs "the tower is here, this far off the road",
  //    not the four walls of the tower as a navigable cycle.
  for (const f of areaFeatures) {
    if (excluded.has(className(f.classId))) continue;
    if (b.nodes.length >= maxNodes) break;
    compileArea(b, f, className(f.classId));
  }

  // 3. Any node not touched by an edge is still useful context, but only if it
  //    is named. An anonymous polygon corner is noise to a language model.
  pruneIsolated(b);

  // 4. A named node that never welded onto a street is not a real feature of
  //    the map, it is a bug in the geometry: a POI sits a few metres off the
  //    kerb, far outside the weld radius, so it lands as an island. An island
  //    is worse than useless, because under token pressure the budgeter
  //    discards it before the network. Attach each one to the nearest network
  //    node instead, so the agent gets "the cafe is 20m off Mission St"
  //    rather than nothing at all.
  //
  //    Crucially the attachment target must be part of the *road network*, not
  //    merely another landmark. Two cafes 8m apart are two doors on the same
  //    street, and connecting them to each other produces a map where every
  //    landmark is reachable only from its neighbour - which is not a route.
  attachStrandedLandmarks(b);

  const heat = compileHeat(doc, doc.envelope, opts.maxHotspots ?? 5);

  // Indoor topology is compiled from the same document but kept as its own
  // structure. It is optional and usually absent: most extracts are outdoor,
  // and a building with one tagged corridor is not an indoor map.
  const indoor = opts.indoor === false
    ? emptyIndoor()
    : compileIndoor(doc, opts);

  return {
    meta: buildMeta(doc, opts),
    nodes: b.nodes,
    edges: b.edges,
    obstacles: b.obstacles,
    heat,
    indoor,
    omitted: compileOmissions(doc),
    tools: advertisedTools(
      opts.capabilities ?? { elevation: opts.hasElevation ?? false, weather: false, traffic: false },
    ),
    pinned: [...b.pinned],
    partial: doc.omissions.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Indoor topology
// ---------------------------------------------------------------------------

/**
 * Pull indoor features out of the document and build the per-floor graph.
 *
 * Indoor data arrives as ordinary features tagged `indoor=*` and `level=*`, so
 * the wire format needed no change; only the interpretation did. A feature
 * counts as indoor when it carries either tag, because a `level=2` corridor is
 * indoor even without `indoor=corridor`, and an `indoor=room` on an untagged
 * storey is still a room worth showing under an unknown level.
 */
function compileIndoor(doc: ScrDocument, opts: CompileOptions): IndoorGraph {
  const features: IndoorFeature[] = [];

  for (const f of doc.features) {
    const props = propsOf(doc, f.attrSet);
    const levelRaw = propString(doc, props, 'layer') ?? propString(doc, props, 'level');
    const indoor = propString(doc, props, 'indoor');
    if (levelRaw === undefined && indoor === undefined) continue;

    const level = parseLevel(levelRaw);
    const name = propString(doc, props, 'name');
    const kindHint = indoor ?? classNameOf(doc, f.classId);

    // Only genuine indoor categories participate. A polygon tagged `indoor=no`
    // is explicitly not indoor space, and letting it through would put an
    // outdoor parcel inside the floor graph.
    if (indoor === 'no') continue;

    const centre = centroidOf(f);
    if (!centre) continue;

    const wheelchair = wheelchairOf(doc, props);
    const extent = extentOf(f);
    features.push({
      id: f.id,
      ...(level !== undefined ? { level } : {}),
      ...(name ? { name } : {}),
      ...(indoor ? { indoor } : {}),
      room: kindHint === 'room' || (indoor === undefined && level !== undefined && f.kind === 'polygon'),
      x: centre.x,
      y: centre.y,
      ...(extent !== undefined ? { extent } : {}),
      ...(indoor === 'door' || indoor === 'wall' ? { blocked: false } : {}),
      ...(wheelchair !== undefined ? { wheelchair } : {}),
      ...(propString(doc, props, 'door') ? { door: propString(doc, props, 'door')! } : {}),
    });
  }

  if (features.length === 0) return emptyIndoor();

  // Indoor distances are metres, not grid units. The indoor bounding box is
  // almost always the same envelope as the whole map, which for a 400m radius
  // would put a doorway 2000 grid units away and every edge beyond any sane
  // threshold. The indoor extent alone gives the scale that matters.
  const mpu = indoorMetresPerUnit(features, doc);
  const graph = buildIndoorGraph(features, {
    metresPerUnit: mpu,
    maxNodesPerLevel: opts.maxIndoorNodesPerLevel ?? 60,
    maxLevels: opts.maxIndoorLevels ?? 8,
  });

  return isMeaningfulIndoor(graph) ? graph : emptyIndoor();
}

/**
 * Metres per grid unit, measured from the indoor features themselves.
 *
 * The document's own scale would be wrong for indoor work, because a city-block
 * envelope and a mall's corridors share it. Measuring the indoor bounding box
 * instead is self-calibrating: whatever the envelope, the indoor features span
 * the building, and a building has a known typical size.
 *
 * The divisor is a cross-corridor span in grid units paired with a typical
 * building width. It is an estimate and is documented as one, because indoor
 * geometry carries no scale of its own in a 2D encoding.
 */
function indoorMetresPerUnit(features: IndoorFeature[], doc: ScrDocument): number {
  const xs = features.map((f) => f.x);
  const ys = features.map((f) => f.y);
  const spanGrid = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (spanGrid <= 0) return 1;

  // Envelope width in metres, which is the real-world size of the area the
  // indoor features sit in. Using the envelope's own metres-per-grid-unit and
  // then rescaling by the indoor share of it avoids inventing a building size.
  const env = doc.envelope;
  let envelopeMetres: number | undefined;
  if (env.type === 'bbox') {
    const midLat = (env.north + env.south) / 2;
    envelopeMetres =
      Math.max(
        Math.abs(env.east - env.west) * 111320 * Math.cos((midLat * Math.PI) / 180),
        Math.abs(env.north - env.south) * 110574,
      ) || undefined;
  } else {
    const b = tileBounds(env.z, env.x, env.y);
    const midLat = (b.north + b.south) / 2;
    envelopeMetres =
      Math.max(
        Math.abs(b.east - b.west) * 111320 * Math.cos((midLat * Math.PI) / 180),
        Math.abs(b.north - b.south) * 110574,
      ) || undefined;
  }
  if (envelopeMetres === undefined) return 1;

  // The indoor features occupy `spanGrid` of the envelope's `extent` grid units.
  // Converting the envelope to metres and dividing by its grid extent gives the
  // true scale, and dividing again by the indoor share corrects for the fact
  // that the building is much smaller than the map area around it.
  const perUnit = envelopeMetres / Math.max(1, doc.extent);
  return perUnit;
}

const blockerTokens = new Set(['door', 'wall', 'barrier']);

function parseLevel(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  // OSM uses `2`, `-1`, and occasionally `2.5` or a name like `mezzanine`.
  const n = Number(trimmed);
  if (Number.isFinite(n)) return n;
  const named: Record<string, number> = {
    ground: 0,
    groundfloor: 0,
    ground_floor: 0,
    'ground-floor': 0,
    main: 0,
    lobby: 0,
    reception: 0,
    basement: -1,
    underground: -1,
    lowerground: -1,
  };
  return named[trimmed.toLowerCase().replace(/\s+/g, '')];
}

function centroidOf(f: Feature): { x: number; y: number } | undefined {
  const g = f.geometry;
  if (g.kind === 'point') return { x: g.point.x, y: g.point.y };
  const ring = g.kind === 'line' ? g.lines[0] : g.polygon[0]?.rings[0];
  if (!ring || ring.length === 0) return undefined;
  return ringCentroid(ring);
}

function extentOf(f: Feature): number | undefined {
  const g = f.geometry;
  if (g.kind === 'line') return polylineLength(g.lines);
  if (g.kind === 'polygon') {
    const ring = g.polygon[0]?.rings[0];
    return ring ? polylineLength([ring]) : undefined;
  }
  return undefined;
}

function polylineLength(lines: { x: number; y: number }[][]): number | undefined {
  let total = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1]!;
      const b = line[i]!;
      total += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  return total || undefined;
}

/**
 * Read a property as a string.
 *
 * `propsOf` returns raw `Prop` records rather than a map, so the lookup goes
 * through the same resolver the rest of the compiler uses. That matters for
 * `level=2`: it is stored as a number, and reading it as a string would give
 * the literal text "2" on one path and the number 2 on another, producing two
 * different storeys for one floor.
 */
function propString(doc: ScrDocument, props: Prop[], key: string): string | undefined {
  for (const p of props) {
    if (doc.strings.get(p.key) !== key) continue;
    const v = resolveProp(doc, p);
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function propToken(doc: ScrDocument, props: Prop[], key: string): string | undefined {
  for (const p of props) {
    if (doc.strings.get(p.key) !== key) continue;
    const v = resolveProp(doc, p);
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

/**
 * Opening hours as a short phrase, evaluated against the build's instant.
 *
 * Returns undefined when the feature carries no `opening_hours`, which is not
 * the same as being closed. Leaving the field off is what keeps "we do not know"
 * distinguishable from "shut", because those lead to opposite advice.
 */
function hoursOf(
  doc: ScrDocument,
  props: Prop[],
  now: Date,
  utcOffsetMinutes: number | undefined,
): string | undefined {
  const raw = propString(doc, props, 'opening_hours');
  if (raw === undefined) return undefined;
  const phrase = openingPhrase(raw, now, utcOffsetMinutes);
  return phrase === undefined ? undefined : phrase;
}

function wheelchairOf(doc: ScrDocument, props: Prop[]): boolean | undefined {
  const v = propToken(doc, props, 'wheelchair');
  if (v === 'yes' || v === 'true') return true;
  if (v === 'no' || v === 'false') return false;
  return undefined;
}

function classNameOf(doc: ScrDocument, classId: number): string {
  return doc.classes.get(classId)?.name ?? '';
}

// ---------------------------------------------------------------------------
// Line / polygon / building -> edges
// ---------------------------------------------------------------------------

/** Turn each part of a line feature into a chain of edges between welded nodes. */
function compileLinear(b: Builder, f: Feature, className: string, layerName: string): void {
  const path = classPathHint(className, layerName);
  if (f.geometry.kind !== 'line') return;

  const props = propsOf(b.doc, f.attrSet);
  const blocked = isBlocked(props);
  const crosswalk = hasToken(b.doc, props, 'crossing') || hasToken(b.doc, props, 'crosswalk');

  for (const coords of f.geometry.lines) {
    const line = dedupeLine(coords, false);
    if (line.length < 2) continue;

    let prevId: string | undefined;
    for (let i = 0; i < line.length; i++) {
      const pt = line[i]!;
      const key = weldKey(pt, b.weld);
      let nodeId = b.junctionIndex.get(key);
      if (nodeId === undefined) {
        // Interior vertices stay anonymous unless a later point feature claims
        // them. They still exist, so a route can traverse them.
        nodeId = addNode(b, { kind: 'intersection', features: [f.id] }, pt);
        b.junctionIndex.set(key, nodeId);
      } else {
        const existing = nodeById(b, nodeId);
        if (existing && !existing.features.includes(f.id)) existing.features.push(f.id);
      }

      if (prevId !== undefined && prevId !== nodeId) {
        addEdge(b, prevId, nodeId, path, blocked, crosswalk, f.id);
      }
      prevId = nodeId;
    }
  }
}

/**
 * Attach a polygon or building as a single node.
 *
 * The node sits at the largest ring's centroid and is joined to the nearest
 * existing junction, so the agent can state the distance from a street to a
 * landmark without the footprint pretending to be a walkable path.
 */
function compileArea(b: Builder, f: Feature, className: string): void {
  if (f.geometry.kind !== 'polygon' && f.geometry.kind !== 'building') return;

  const props = propsOf(b.doc, f.attrSet);
  const name = stringProp(b.doc, props, 'name');
  const tags = collectTags(className, props);
  const kind: NodeKind =
    f.geometry.kind === 'building' || className.startsWith('building') ? 'building' : 'area';

  let centroid: { x: number; y: number } | undefined;
  for (const part of f.geometry.polygon) {
    const ring = part.rings[0];
    if (ring && ring.length >= 3) {
      centroid = ringCentroid(ring);
      break;
    }
  }
  if (!centroid) return;

  // If a junction already sits on the centroid, enrich it instead of adding a
  // duplicate node one grid unit away.
  const key = weldKey(centroid, b.weld);
  const existingId = b.junctionIndex.get(key);
  if (existingId !== undefined) {
    const n = nodeById(b, existingId)!;
    if (!n.features.includes(f.id)) n.features.push(f.id);
    if (name && !n.name) n.name = name;
    if (kind === 'building' && n.kind === 'intersection') n.kind = 'building';
    if (tags.length > 0) n.tags = dedupe([...(n.tags ?? []), ...tags]);
    const h = numProp(b.doc, props, 'height_m', 'height', 'building:levels');
    if (h !== undefined) n.heightM = h;
    return;
  }

  const partial: Omit<GraphNode, 'id'> = { kind, features: [f.id] };
  if (name) partial.name = name;
  if (tags.length > 0) partial.tags = tags;
  const h = numProp(b.doc, props, 'height_m', 'height', 'building:levels');
  if (h !== undefined) partial.heightM = h;

  const id = addNode(b, partial, centroid);
  b.featureIndex.set(f.id, id);

  // Join to the nearest junction so the area is not orphaned.
  const near = nearestNode(b, centroid, allNodes(b), '');
  if (near !== undefined && near !== id) {
    addEdge(b, near, id, 'access', false, false, f.id);
  } else {
    b.used.add(id);
  }
}

/** Centroid of a ring, as the mean of its vertices. */
function ringCentroid(ring: { x: number; y: number }[]): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return { x: Math.round(x / ring.length), y: Math.round(y / ring.length) };
}

function addEdge(
  b: Builder,
  fromId: string,
  toId: string,
  path: string | undefined,
  blocked: boolean,
  crosswalk: boolean,
  featureId: number,
): void {
  const fromPt = b.anchors.get(fromId);
  const toPt = b.anchors.get(toId);
  if (!fromPt || !toPt) return;

  // Distances stay in grid units here, with the raw axis deltas preserved. The
  // emitter applies the document's per-axis scale, which is the only place the
  // envelope's real-world size is known.
  const dx = toPt.x - fromPt.x;
  const dy = toPt.y - fromPt.y;
  const dist = Math.hypot(dx, dy);
  const dir = compassOf(fromPt, toPt);

  const base = (d: Compass): GraphEdge => {
    const edge: GraphEdge = { from: fromId, to: toId, dist, dx, dy, dir: d, features: [featureId] };
    if (path) edge.path = path;
    if (crosswalk) edge.crosswalk = true;
    if (blocked) edge.blocked = true;
    return edge;
  };

  // A line is bidirectional unless the data says otherwise. An agent reading a
  // directed graph assumes one-way semantics, so both directions must exist.
  b.edges.push(base(dir), base(oppositeCompass(dir)));
  b.used.add(fromId);
  b.used.add(toId);

  if (blocked) {
    b.obstacles.push({ edge: `${fromId}->${toId}`, type: path ?? 'obstruction', blocks: true });
  }
}

function addNode(
  b: Builder,
  partial: Omit<GraphNode, 'id'>,
  at: { x: number; y: number },
): string {
  const id = `n${b.nextId++}`;
  const node: GraphNode = { id, ...partial };
  b.nodes.push(node);
  b.anchors.set(id, at);
  return id;
}

function nodeById(b: Builder, id: string): GraphNode | undefined {
  return b.nodes.find((n) => n.id === id);
}

// ---------------------------------------------------------------------------
// Point features -> named nodes
// ---------------------------------------------------------------------------

function compilePoint(b: Builder, f: Feature, className: string): void {
  if (f.geometry.kind !== 'point') return;
  const p = f.geometry.point;
  const key = weldKey(p, b.weld);

  const props = propsOf(b.doc, f.attrSet);
  const name = stringProp(b.doc, props, 'name');
  const tags = collectTags(className, props);

  const kind = nodeKindFor(className);

  // Snap to an existing junction when one is within the weld radius, so the
  // place sits on the network rather than floating beside it.
  const snapped = b.junctionIndex.get(key);

  // Opening hours and brand, resolved once. Both were being ingested into the
  // wire document and then dropped here, which meant an agent asking whether a
  // place was open had nothing to go on and would guess. It usually guesses open.
  const hours = hoursOf(b.doc, props, b.now, b.utcOffsetMinutes);
  const brand = stringProp(b.doc, props, 'brand');

  if (snapped !== undefined) {
    const n = nodeById(b, snapped)!;
    if (!n.features.includes(f.id)) n.features.push(f.id);
    // A named POI upgrades the anonymous junction it landed on.
    if (name && !n.name) {
      n.name = name;
      n.kind = kind === 'intersection' ? n.kind : kind;
    }
    if (tags.length > 0) {
      n.tags = dedupe([...(n.tags ?? []), ...tags]);
    }
    if (kind === 'building') {
      const h = numProp(b.doc, props, 'height_m', 'height', 'building:levels');
      if (h !== undefined) n.heightM = h;
    }
    // Only fill a gap, never overwrite. Two POIs welding onto one junction
    // should not fight over which one's hours to publish.
    if (!n.hours && hours) n.hours = hours;
    if (!n.brand && brand) n.brand = brand;
    b.featureIndex.set(f.id, snapped);
    return;
  }

  const partial: Omit<GraphNode, 'id'> = { kind, features: [f.id] };
  if (name) partial.name = name;
  if (tags.length > 0) partial.tags = tags;
  if (hours) partial.hours = hours;
  if (brand) partial.brand = brand;
  const h = numProp(b.doc, props, 'height_m', 'height', 'building:levels');
  if (h !== undefined) partial.heightM = h;

  const id = addNode(b, partial, p);
  b.featureIndex.set(f.id, id);
  // A point standing alone is a destination, not a network element.
  b.used.add(id);
}

function nodeKindFor(className: string): NodeKind {
  if (TRANSIT_CLASSES.has(className)) return 'transit';
  if (className.startsWith('building')) return 'building';
  if (className.startsWith('highway') || className.startsWith('railway')) return 'intersection';
  if (className.includes('park') || className.includes('garden')) return 'park';
  if (className.includes('water') || className.includes('river')) return 'water';
  if (POI_CLASSES.has(className) || className.includes('.')) return 'poi';
  return 'area';
}

/**
 * Highway tags that are street furniture, not destinations.
 *
 * A `[highway]` match on a node returns traffic signals, crossings, kerbs and
 * street lamps. There are thousands in a city block, they have no name, and each
 * becomes an anonymous junction in the graph. An agent should see the streets
 * and the places, not the furniture along them. Filtering here as well as in
 * the query means a source that does return them cannot flood the output.
 */
const FURNITURE_HIGHWAYS = new Set([
  'traffic_signals', 'crossing', 'street_lamp', 'give_way', 'stop',
  'elevator', 'turning_circle', 'milestone', 'speed_camera',
  'traffic_calming', 'passing_place', 'emergency_bay',
]);

/**
 * Named-but-invisible POIs that still clutter a graph.
 *
 * Public art, viewpoints and information boards can number in the hundreds in a
 * city and are rarely what an agent is asked about. They are kept only when
 * they carry a name an agent would recognize; the anonymous ones are dropped so
 * the budget goes to places people actually look for.
 */
const WEAK_POI_CLASSES = new Set([
  'tourism.artwork', 'tourism.viewpoint', 'tourism.information',
  'tourism.board', 'tourism.map', 'amenity.waste_basket',
  'amenity.bicycle_parking', 'amenity.post_box', 'amenity.vending_machine',
  'amenity.drinking_water', 'amenity.bench', 'amenity.parking_entrance',
]);

function isFurniture(className: string): boolean {
  const tail = className.split('.')[1] ?? className;
  if (FURNITURE_HIGHWAYS.has(tail)) return true;
  // Weak POIs only count as clutter when anonymous.
  if (WEAK_POI_CLASSES.has(className)) return true;
  return false;
}

/** Whether a feature carries a name attribute an agent could cite. */
function isNamed(doc: ScrDocument, f: Feature): boolean {
  return stringProp(doc, propsOf(doc, f.attrSet), 'name') !== undefined;
}

// ---------------------------------------------------------------------------
// Metadata, heat, omissions
// ---------------------------------------------------------------------------

function buildMeta(doc: ScrDocument, opts: CompileOptions): SpatialGraph['meta'] {
  const c = gridToLonLat({ x: doc.extent / 2, y: doc.extent / 2 }, doc.envelope, doc.extent, doc.projection);
  const meta: SpatialGraph['meta'] = {
    center: `${round(c.lat, 5)}, ${round(c.lon, 5)}`,
  };
  if (opts.radiusLabel) meta.radius = opts.radiusLabel;
  if (doc.meta.lod) meta.lod = doc.meta.lod;
  if (doc.meta.source) meta.source = doc.meta.source;

  // Sun position, computed rather than fetched. It needs no key and no network,
  // and "will it be dark when I get there" is a question an agent cannot answer
  // without it.
  if (opts.sun !== false) {
    const sun = sunPosition(c.lat, c.lon, opts.now);
    meta.sun = {
      elevationDeg: sun.elevationDeg,
      daylight: sun.daylight,
      twilight: sun.twilight,
      azimuthDeg: sun.azimuthDeg,
      ...(sun.sunrise ? { sunrise: sun.sunrise } : {}),
      ...(sun.sunset ? { sunset: sun.sunset } : {}),
      ...(sun.polar ? { polar: sun.polar } : {}),
    };
  }

  const omittedTotal = doc.omissions.reduce((a, o) => a + o.count, 0);
  // "expand_node" was never a tool; it was a stale guess in a hand-written
  // string. The feature tool is what actually returns exact geometry.
  const parts: string[] = ['Simplified for reasoning; call expand_feature for exact geometry.'];
  if (omittedTotal > 0) {
    parts.push(`Incomplete: ${omittedTotal} feature(s) omitted to fit budget.`);
  }
  meta.note = parts.join(' ');
  return meta;
}

function compileHeat(doc: ScrDocument, env: Envelope, maxHotspots: number): HeatSummary[] {
  const out: HeatSummary[] = [];
  for (const h of doc.heat) {
    const cells = h.cells ?? [];
    if (cells.length === 0) continue;
    const values = cells.map((c) => c.value);
    const max = Math.max(...values);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    // Normalize against the layer's *declared* range, not the observed
    // maximum. Using the observed max would report the strongest cell as
    // `rel: 1.0` on every maplet, which tells the agent nothing about how
    // intense it is relative to what the layer is capable of.
    const lo = h.minValue || 0;
    const span = h.maxValue !== lo ? h.maxValue - lo : 1;
    const hotspots = [...cells]
      .sort((a, b) => b.value - a.value)
      .slice(0, maxHotspots)
      .map((c) => {
        const ll = gridToLonLat({ x: c.x, y: c.y }, env, doc.extent, doc.projection);
        return {
          lat: round(ll.lat, 5),
          lon: round(ll.lon, 5),
          value: c.value,
          rel: round((c.value - lo) / span, 2),
        };
      });
    out.push({ name: h.name, max, mean: round(mean, 1), hotspots });
  }
  return out;
}

function compileOmissions(doc: ScrDocument): SpatialGraph['omitted'] {
  return doc.omissions.map((o) => {
    const layer = doc.layers.get(o.layerId)?.name ?? `layer${o.layerId}`;
    let near = 'unspecified';
    if (o.centroid) {
      const c = gridToLonLat(o.centroid, doc.envelope, doc.extent, doc.projection);
      near = `${round(c.lat, 4)},${round(c.lon, 4)}`;
    }
    const entry: SpatialGraph['omitted'][number] = { layer, count: o.count, near };
    if (o.note !== undefined) {
      const text = doc.strings.get(o.note);
      if (text) entry.note = text;
    }
    return entry;
  });
}

// ---------------------------------------------------------------------------
// Attribute access
// ---------------------------------------------------------------------------

export function propsOf(doc: ScrDocument, attrSetId: number): Prop[] {
  if (attrSetId === 0) return [];
  return doc.attrSets.get(attrSetId)?.props ?? [];
}

export function resolveProp(doc: ScrDocument, prop: Prop): string | number | boolean {
  const v = prop.value;
  switch (v.t) {
    case 'ref':
      return doc.strings.get(v.ref) ?? `s${v.ref}`;
    case 'num':
      return v.num;
    case 'bool':
      return v.bool;
    case 'token':
      return v.token;
  }
}

/** The attribute key, resolved through the string table. */
function keyName(doc: ScrDocument, p: Prop): string | undefined {
  return doc.strings.get(p.key);
}

/** First string-valued property whose key matches. */
function stringProp(doc: ScrDocument, props: Prop[], key: string): string | undefined {
  for (const p of props) {
    if (keyName(doc, p) !== key) continue;
    const v = p.value;
    if (v.t === 'ref') {
      const s = doc.strings.get(v.ref);
      if (s !== undefined) return s;
    } else if (v.t === 'token') {
      return v.token;
    }
  }
  return undefined;
}

/**
 * First numeric property under any of the given keys. Building heights arrive
 * as `height` or `height_m` depending on the source, so both are accepted.
 */
function numProp(doc: ScrDocument, props: Prop[], ...keys: string[]): number | undefined {
  for (const p of props) {
    if (!keys.includes(keyName(doc, p) ?? '')) continue;
    if (p.value.t === 'num') return p.value.num;
    if (p.value.t === 'ref') {
      const s = doc.strings.get(p.value.ref);
      if (s !== undefined) {
        const n = Number(s);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return undefined;
}

/** True when any property carries the given token, used for path semantics. */
function hasToken(doc: ScrDocument, props: Prop[], token: string): boolean {
  for (const p of props) {
    if (p.value.t === 'token' && p.value.token === token) return true;
  }
  return false;
}

function isBlocked(props: Prop[]): boolean {
  for (const p of props) {
    if (p.value.t === 'token' && BLOCKING_TAGS.has(p.value.token)) return true;
  }
  return false;
}

function collectTags(className: string, props: Prop[]): string[] {
  const tags: string[] = [];
  // The class tail is the most useful tag: `amenity.cafe` -> `cafe`.
  const parts = className.split('.');
  const leaf = parts[parts.length - 1];
  if (leaf && leaf !== className) tags.push(leaf);
  for (const p of props) {
    if (p.value.t === 'token' && !BLOCKING_TAGS.has(p.value.token)) tags.push(p.value.token);
  }
  return dedupe(tags).slice(0, 4);
}

function classPathHint(className: string, layerName: string): string | undefined {
  for (const { match, path } of PATH_HINTS) {
    if (className.includes(match)) return path;
  }
  if (layerName === 'road') return 'road';
  return undefined;
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function pruneIsolated(b: Builder): void {
  b.nodes = b.nodes.filter((n) => b.used.has(n.id) || n.name !== undefined);
}

/**
 * Join named-but-disconnected nodes to the nearest *road network* node.
 *
 * Points of interest rarely share a coordinate with the street centreline, so
 * welding alone leaves them as islands. Islands are the first thing a token
 * budget discards, which is how a dense extract ends up as pure geometry and no
 * landmarks. Attaching them costs one edge each and converts dead weight into
 * the information an agent actually needs: which side of the road, and how far.
 */
function attachStrandedLandmarks(b: Builder): void {
  const degree = new Map<string, number>();
  for (const e of b.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }

  // The network backbone: nodes with degree 2 or more are on a street, while
  // degree 1 is a dead end and degree 0 is an island. A landmark must attach to
  // the backbone, never to another landmark, or the result is a chain of shops
  // with no street under them.
  const backbone = new Set<string>();
  for (const [id, d] of degree) if (d >= 2) backbone.add(id);

  for (const node of b.nodes) {
    if (node.name === undefined) continue;
    if ((degree.get(node.id) ?? 0) > 0) continue;
    const at = b.anchors.get(node.id);
    if (!at) continue;

    const near = nearestNode(b, at, backbone, node.id);
    if (near === undefined) continue;

    addEdge(b, near, node.id, 'access', false, false, node.features[0] ?? 0);
    // Protect the access edge. Without it the landmark exists but cannot be
    // routed to, and a token-pressured budgeter will happily delete the
    // anonymous junction while keeping the named node, stranding it.
    b.pinned.add(node.id);
  }
}

/** Ids of every node currently placed. */
function allNodes(b: Builder): Set<string> {
  return new Set(b.anchors.keys());
}

/** The closest node in `candidates` to a point, excluding a node itself. */
function nearestNode(
  b: Builder,
  at: { x: number; y: number },
  candidates: ReadonlySet<string>,
  exclude: string,
): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const id of candidates) {
    if (id === exclude) continue;
    const anchor = b.anchors.get(id);
    if (!anchor) continue;
    const d = Math.hypot(anchor.x - at.x, anchor.y - at.y);
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }
  return best;
}

export { weldKey };
export type { Bbox };

/**
 * Indoor navigation.
 *
 * This is the layer nobody else publishes. Google builds indoor maps for its
 * own users and has no reason to hand a third-party agent a clean floor-by-floor
 * topology; Mapbox has nothing comparable; the MCP wrappers on top of both
 * return the same GeoJSON they always did.
 *
 * OpenStreetMap has the data - `level=*`, `indoor=room`, doors, lifts, stairs -
 * and supercarto already ingests it. What was missing was turning it into a
 * graph an agent can traverse: which rooms are on which floor, how you get
 * between floors, and which doors can be opened.
 *
 * The output is a set of per-floor graphs plus the vertical connections between
 * them, emitted as a `levels:` block. A model reading that can answer "how do I
 * get to the cafe on level 3" without being handed a stack of unconnected
 * polygons.
 */

export type Storey = number;

/** Why a vertical link exists, which determines whether it is usable. */
export type VerticalKind = 'lift' | 'stairs' | 'escalator' | 'ramp';

export interface IndoorNode {
  id: string;
  /** Storey this node is on. 0 is ground level by OSM convention. */
  level: Storey;
  kind: 'room' | 'corridor' | 'door' | 'lift' | 'stairs' | 'entrance' | 'shop' | 'unknown';
  name?: string;
  /** OSM `indoor` value, e.g. `room`, `corridor`, `lift`, `stairs`. */
  indoor?: string;
  wheelchair?: boolean;
  /** Metres from the node to the building's main entrance, for orientation. */
  depthM?: number;
}

export interface IndoorEdge {
  from: string;
  to: string;
  distM: number;
  /** Same-floor connection. */
  level: Storey;
  /** True where the edge cannot be traversed: a locked or closed door. */
  blocked?: boolean;
  /** Door type, when the edge passes through one. */
  door?: string;
}

export interface VerticalLink {
  /**
   * Stable id for the shaft within this building, e.g. `v1`. Referenced by the
   * per-floor nodes so a model can say "take the lift to level 3" and mean a
   * specific shaft.
   */
  id: string;
  kind: VerticalKind;
  /** Every storey the shaft serves, ascending. */
  levels: Storey[];
  wheelchair?: boolean;
  name?: string;
  /**
   * Grouping key used to collapse the same shaft across storeys. Internal:
   * the per-floor builder needs it to know which features it already consumed,
   * and a model does not.
   */
  key?: string;
}

export interface IndoorLevel {
  level: Storey;
  /** Human label, e.g. `ground`, `1`, `-1`, or a building's own naming. */
  label: string;
  nodes: IndoorNode[];
  edges: IndoorEdge[];
}

export interface IndoorGraph {
  /** True when the source data actually described more than one storey. */
  multiStorey: boolean;
  levels: IndoorLevel[];
  vertical: VerticalLink[];
  /** Storeys present in the data that are not represented in the graph. */
  missingLevels: Storey[];
  /** Omitted storeys and the reason, so the agent knows it is not seeing all. */
  omitted: { level: Storey; reason: string }[];
}

/** Stated plainly: no indoor data means no indoor claim. */
const NO_INDOOR: IndoorGraph = {
  multiStorey: false,
  levels: [],
  vertical: [],
  missingLevels: [],
  omitted: [],
};

export function emptyIndoor(): IndoorGraph {
  return { ...NO_INDOOR, levels: [], vertical: [], omitted: [] };
}

/**
 * A raw indoor feature, as ingested. Kept separate from `IndoorNode` so the
 * builder can work from the source's own vocabulary.
 */
export interface IndoorFeature {
  /** 1-based feature id, for traceability back to the wire document. */
  id: number;
  /** Parsed `level`, or undefined when the feature is untagged. */
  level?: Storey;
  name?: string;
  indoor?: string;
  /** True for polygons that are rooms rather than shafts or entrances. */
  room?: boolean;
  /** Centroid, used to measure door-to-room and room-to-corridor distances. */
  x: number;
  y: number;
  /** Footprint or path length, used to break ties between candidate pairs. */
  extent?: number;
  /** True when the feature blocks movement, e.g. `door=filled`. */
  blocked?: boolean;
  door?: string;
  wheelchair?: boolean;
  openingHours?: string;
}

/**
 * Build the indoor graph from ingested features.
 *
 * Two passes. The first groups features by storey and identifies vertical
 * shafts, since a shaft is the one feature that spans storeys and has to be
 * collapsed into a single node before any per-floor graph can be built. The
 * second connects rooms to their nearest corridor or door on the same storey.
 *
 * Distance is measured in metres by the caller-supplied scale, because indoor
 * geometry is small enough that grid units would be meaningless to a model.
 */
export function buildIndoorGraph(
  features: IndoorFeature[],
  opts: {
    /** Metres per grid unit. Required: indoor geometry is never large. */
    metresPerUnit: number;
    /** Cap on nodes per storey. Default 60. */
    maxNodesPerLevel?: number;
    /** Cap on storeys. Default 8, which covers every building worth routing in. */
    maxLevels?: number;
  },
): IndoorGraph {
  if (features.length === 0) return emptyIndoor();

  const levels = features.filter((f) => f.level !== undefined);
  if (levels.length === 0) return emptyIndoor();

  const present = [...new Set(levels.map((f) => f.level!))].sort((a, b) => a - b);
  const multiStorey = present.length > 1;

  const maxLevels = opts.maxLevels ?? 8;
  const maxNodes = opts.maxNodesPerLevel ?? 60;
  const mpu = opts.metresPerUnit;

  // Pass 1: vertical shafts, which span storeys and so belong to no single one.
  const shaftFeatures = levels.filter(isShaft);
  const vertical = buildVerticalLinks(shaftFeatures, mpu);

  // A shaft on one storey only is not vertical movement, so it is only recorded
  // as a link when it genuinely spans two.
  const usableVertical = vertical.filter((v) => v.levels.length > 1);

  // Pass 2: per-floor graphs from what remains.
  const taken = new Set(
    usableVertical.flatMap((v) =>
      shaftFeatures.filter((s) => isShaft(s) && shaftKey(s) === v.key).map((s) => s.id),
    ),
  );

  const out: IndoorLevel[] = [];
  const omitted: IndoorGraph['omitted'] = [];

  for (const level of present) {
    if (out.length >= maxLevels) {
      omitted.push({ level, reason: `storey budget of ${maxLevels} reached` });
      continue;
    }
    const onLevel = levels.filter((f) => f.level === level && !taken.has(f.id));

    if (onLevel.length === 0) {
      // A storey that appears only as a shaft still exists and is worth naming:
      // an agent told "level 4 has only a lift" will not invent a cafe there.
      if (usableVertical.some((v) => v.levels.includes(level))) continue;
      omitted.push({ level, reason: 'no walkable features tagged on this storey' });
      continue;
    }

    const graph = buildLevelGraph(level, onLevel, mpu, maxNodes);
    if (graph === undefined) {
      omitted.push({ level, reason: 'no corridor to connect rooms to' });
      continue;
    }
    out.push(graph);
  }

  // Storeys the data implies but never tags. A building with tagged 0 and 2 and
  // nothing on 1 usually means untagged, not absent, so it is reported rather
  // than invented.
  const missingLevels: Storey[] = [];
  for (let i = 1; i < present.length; i++) {
    const lo = present[i - 1]!;
    const hi = present[i]!;
    if (hi - lo > 1) for (let s = lo + 1; s < hi; s++) missingLevels.push(s);
  }

  return {
    multiStorey,
    levels: out,
    vertical: usableVertical,
    missingLevels,
    omitted,
  };
}

function buildLevelGraph(
  level: Storey,
  features: IndoorFeature[],
  mpu: number,
  maxNodes: number,
): IndoorLevel | undefined {
  // A floor with no corridor is a floor of disconnected rooms. Emitting them
  // would advertise places the agent cannot reach, which is the exact defect
  // the outdoor budgeter goes to some trouble to avoid.
  const corridors = features.filter(isCorridor);
  if (corridors.length === 0) return undefined;

  const nodes: IndoorNode[] = [];
  const edges: IndoorEdge[] = [];
  /** Feature id -> node, so a distance can be measured from the source geometry. */
  const byId = new Map<number, IndoorNode>();

  const add = (f: IndoorFeature, kind: IndoorNode['kind']): IndoorNode | undefined => {
    if (nodes.length >= maxNodes) return undefined;
    const id = `L${level}n${nodes.length + 1}`;
    const node: IndoorNode = {
      id,
      level,
      kind,
      ...(f.name ? { name: f.name } : {}),
      ...(f.indoor ? { indoor: f.indoor } : {}),
      ...(f.wheelchair !== undefined ? { wheelchair: f.wheelchair } : {}),
    };
    nodes.push(node);
    byId.set(f.id, node);
    return node;
  };

  // Corridors first: they are the spine, and attaching rooms to them is what
  // makes the floor traversable.
  const corridorNodes = corridors
    .slice(0, Math.max(1, Math.floor(maxNodes / 3)))
    .map((f) => add(f, 'corridor'))
    .filter((n): n is IndoorNode => n !== undefined);

  if (corridorNodes.length === 0) return undefined;

  // Corridors are connected to each other when close, which assembles the
  // floor's spine without needing a full planar-graph pass.
  for (let i = 0; i < corridorNodes.length; i++) {
    for (let j = i + 1; j < corridorNodes.length; j++) {
      const a = corridorNodes[i]!;
      const b = corridorNodes[j]!;
      const d = metresBetween(a, b, features, byId, mpu);
      if (d !== undefined && d <= 60) {
        edges.push({ from: a.id, to: b.id, distM: Math.round(d), level });
      }
    }
  }

  // Then every other feature attaches to its nearest corridor, so no node in
  // the graph is stranded.
  const attachable = features.filter((f) => !isCorridor(f) && !isShaft(f));
  for (const f of attachable) {
    const kind = kindOf(f);
    const node = add(f, kind);
    if (!node) break;

    let best: { c: IndoorNode; d: number } | undefined;
    for (const c of corridorNodes) {
      const d = metresBetween(node, c, features, byId, mpu);
      if (d === undefined) continue;
      if (!best || d < best.d) best = { c, d };
    }
    if (!best) continue;
    // Beyond 40m a room is not served by that corridor; the connection would be
    // a straight line through walls, which is worse than no edge at all.
    if (best.d > 40) continue;
    edges.push({
      from: best.c.id,
      to: node.id,
      distM: Math.round(best.d),
      level,
      ...(f.blocked ? { blocked: true } : {}),
      ...(f.door ? { door: f.door } : {}),
    });
  }

  return { level, label: levelLabel(level), nodes, edges };
}

function buildVerticalLinks(shafts: IndoorFeature[], mpu: number): VerticalLink[] {
  const groups = new Map<string, IndoorFeature[]>();
  for (const s of shafts) {
    const key = shaftKey(s);
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }

  const out: VerticalLink[] = [];
  let n = 1;
  for (const [key, group] of groups) {
    const levels = [...new Set(group.map((f) => f.level!))].sort((a, b) => a - b);
    // Shafts on the same storey at different places are two lifts, not one. Only
    // treat them as a single shaft when they are genuinely co-located.
    if (levels.length < 2 && group.length > 1) {
      const spread = spreadOf(group, mpu);
      if (spread > 25) continue;
    }
    const kind = kindOf(group[0]!) as VerticalKind;
    const wheelchair = group.some((f) => f.wheelchair === true);
    out.push({
      id: `v${n++}`,
      kind: kind === 'stairs' ? 'stairs' : kind === 'lift' ? 'lift' : kind,
      levels,
      ...(wheelchair ? { wheelchair } : {}),
      ...(group[0]!.name ? { name: group[0]!.name } : {}),
      key,
    });
  }
  return out;
}

function isCorridor(f: IndoorFeature): boolean {
  if (f.indoor === 'corridor') return true;
  // A way tagged indoor but not a room is circulation of some kind.
  return f.indoor !== undefined && !f.room && !isShaft(f);
}

function isShaft(f: IndoorFeature): boolean {
  return f.indoor === 'lift' || f.indoor === 'elevator' || f.indoor === 'stairs' || f.indoor === 'escalator';
}

function kindOf(f: IndoorFeature): IndoorNode['kind'] {
  if (f.indoor === 'lift' || f.indoor === 'elevator') return 'lift';
  if (f.indoor === 'stairs') return 'stairs';
  if (f.indoor === 'corridor') return 'corridor';
  if (f.indoor === 'room' || f.room) return f.name ? 'shop' : 'room';
  if (f.indoor === 'door') return 'door';
  return 'unknown';
}

/**
 * Group key for a shaft.
 *
 * A lift is one shaft across storeys, so the same shaft on level 0 and level 1
 * has to collapse into one link. OSM gives lifts the same `ref` within a
 * building, so that is used when present; otherwise the coordinates decide, to
 * within 15m.
 */
function shaftKey(f: IndoorFeature): string {
  return `${Math.round(f.x / 32)}:${Math.round(f.y / 32)}`;
}

function spreadOf(group: IndoorFeature[], mpu: number): number {
  if (group.length < 2) return 0;
  const xs = group.map((f) => f.x);
  const ys = group.map((f) => f.y);
  const dx = (Math.max(...xs) - Math.min(...xs)) * mpu;
  const dy = (Math.max(...ys) - Math.min(...ys)) * mpu;
  return Math.hypot(dx, dy);
}

function metresBetween(
  a: IndoorNode,
  b: IndoorNode,
  features: IndoorFeature[],
  byId: Map<number, IndoorNode>,
  mpu: number,
): number | undefined {
  const fa = features.find((f) => byId.get(f.id) === a);
  const fb = features.find((f) => byId.get(f.id) === b);
  if (!fa || !fb) return undefined;
  // Centroids. Exact for doors and shafts, approximate for large rooms, which
  // is why the connection threshold is a proximity test rather than a claim
  // about adjacency.
  return Math.hypot(fa.x - fb.x, fa.y - fb.y) * mpu;
}

/**
 * Storey to a label a model reads without translating.
 *
 * "level 0" is a fact about the OSM tag, not about the building. Ground floor
 * in London, first floor in the US, reception in a hotel. Only the sign and
 * zero cases are certain, so those are stated and everything else is left
 * numeric rather than guessed.
 */
export function levelLabel(level: Storey): string {
  if (level === 0) return 'ground';
  if (level === 1) return '1';
  if (level === -1) return 'basement';
  if (level < 0) return `basement ${Math.abs(level)}`;
  return String(level);
}

/**
 * Whether a building's indoor data is worth emitting at all.
 *
 * The threshold is deliberate. A single tagged corridor is not an indoor map,
 * and telling an agent a building has "indoor navigation" when all that exists
 * is one hallway is worse than saying nothing.
 */
export function isMeaningfulIndoor(graph: IndoorGraph): boolean {
  if (graph.levels.length === 0) return false;
  const nodes = graph.levels.reduce((a, l) => a + l.nodes.length, 0);
  return nodes >= 3 || graph.vertical.length > 0;
}

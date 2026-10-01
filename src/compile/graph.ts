/**
 * The reasoning graph.
 *
 * This is the shape the LLM actually sees. The central claim of supercarto is
 * that a model reasons well over a topological graph of named places joined by
 * directed, measured edges, and badly over a cloud of raw coordinates. So the
 * compiler's job is to destroy the geometry and keep the connectivity.
 */

import type { Compass } from '../geo/geometry.js';
import type { IndoorGraph } from './indoor.js';

/** Semantic kind of a node. Ordered roughly by how much an agent cares. */
export type NodeKind =
  | 'intersection'
  | 'poi'
  | 'building'
  | 'transit'
  | 'entrance'
  | 'park'
  | 'water'
  | 'area'
  | 'anchor';

export interface GraphNode {
  /** Short stable id, `n1`, `n2`, ... Cheap to reference repeatedly. */
  id: string;
  kind: NodeKind;
  name?: string;
  /** Free-form semantic tags, e.g. `['cafe', 'food']`. */
  tags?: string[];
  /** Metres, for buildings. */
  heightM?: number;
  /**
   * Opening hours as a short phrase, e.g. `09:00-17:00` or `closed`.
   *
   * Present because it is ingested anyway and an agent asked whether a place is
   * open will otherwise guess. Absent means no hours were recorded, which is
   * not the same as closed.
   */
  hours?: string;
  /** Chain or brand, e.g. `Blue Bottle`. Distinct from the local name. */
  brand?: string;
  /** WGS84, only on anchor nodes, so the agent can report a position. */
  lat?: number;
  lon?: number;
  /**
   * Underlying feature ids. Kept so `expand_node(id)` can retrieve the precise
   * geometry the agent asked to see, without the emitter carrying it.
   */
  features: number[];
}

export interface GraphEdge {
  from: string;
  to: string;
  /**
   * Edge length in grid units. The emitter converts this to metres using the
   * document's per-axis scale, because a single isotropic factor is wrong for
   * a non-square envelope.
   */
  dist: number;
  /** Grid-space displacement, kept so the emitter can scale each axis correctly. */
  dx: number;
  dy: number;
  /** Compass direction of travel, from `from` to `this`. */
  dir: Compass;
  /** Path class: sidewalk, road, stairs, indoor, etc. */
  path?: string;
  crosswalk?: boolean;
  /** True where movement is blocked: construction, wall, closed gate. */
  blocked?: boolean;
  /** Underlying feature ids for the line this edge came from. */
  features: number[];
}

export interface HeatSummary {
  name: string;
  max: number;
  mean: number;
  /** Hotspots, most intense first, truncated by the budgeter. */
  hotspots: { lat: number; lon: number; value: number; /** 0..1 intensity. */ rel: number }[];
}

export interface Obstacle {
  /** `from->to`, the edge it affects. */
  edge: string;
  type: string;
  blocks: boolean;
}

export interface GraphMeta {
  center: string;
  radius?: string;
  /** One line telling the agent what it is holding and what is missing. */
  note?: string;
  /** Semantic zoom band, e.g. `z17-addr`. */
  lod?: string;
  source?: string;
  /**
   * Light conditions at the map centre, so the agent does not have to call out
   * to find out whether it is dark.
   *
   * Three states rather than two: `day`, `civil` twilight, and `night`. A
   * person can walk at 6am in June, and an agent that only knew "not daylight"
   * would wrongly warn them.
   */
  sun?: SunSummary;
}

/** What the emitter needs from the sun, and no more. */
export interface SunSummary {
  elevationDeg: number;
  daylight: boolean;
  twilight: 'day' | 'civil' | 'nautical' | 'night';
  /** Compass bearing. Useful for "the sun will be behind that building". */
  azimuthDeg: number;
  sunrise?: string;
  sunset?: string;
  /** Set when the sun does not rise or set today: polar day or polar night. */
  polar?: 'day' | 'night';
}

export interface SpatialGraph {
  meta: GraphMeta;
  nodes: GraphNode[];
  edges: GraphEdge[];
  obstacles: Obstacle[];
  heat: HeatSummary[];
  /**
   * Per-floor indoor topology, when the source data describes one.
   *
   * Kept separate from `nodes`/`edges` because indoor space is not part of the
   * outdoor network: a lift shaft is not a street, and merging them produces a
   * graph in which the agent believes it can walk from the pavement to level 3.
   */
  indoor: IndoorGraph;
  /** What was dropped to fit the budget, in the agent's own vocabulary. */
  omitted: { layer: string; count: number; near: string; note?: string }[];
  /** Verbs the agent can call to get more. Present so it never has to guess. */
  tools: string[];
  /**
   * Nodes whose connection to the network the budgeter must not break. A
   * landmark with no access edge is a name the agent cannot act on, so these
   * are kept paired with their network neighbour under any budget.
   */
  pinned: string[];
  /** True when the graph was cut to fit a budget. */
  partial: boolean;
}

/**
 * Benchmark types shared across the harness.
 */

import type { SpatialGraph } from '../compile/graph.js';

export interface LatLon {
  lat: number;
  lon: number;
}

export interface ModelRequest {
  system: string;
  user: string;
  model: string;
  temperature: number;
  seed: number;
  /** Local model endpoint, for self-hosted evaluation. */
  baseUrl?: string;
  /**
   * What this call is, for archiving and resuming.
   *
   * Carried on the request because the runner is the only party that knows it.
   * A driver that had to reconstruct the task from the prompt text would break
   * the moment a question was reworded, and the failure would be silent: the
   * archive would fill with rows that no longer join to anything.
   */
  run?: RunIdentity;
}

/** The configuration a single model call was made under. */
export interface RunIdentity {
  taskId: string;
  representation: 'supercarto' | 'geojson' | 'none';
  budget: number;
  seed: number;
}

export interface ModelResponse {
  text: string;
  /** As reported by the provider, or estimated from character count. */
  inputTokens: number;
  outputTokens: number;
  /**
   * Tools the subject called that the harness permitted.
   *
   * Populated only by drivers with an allowlist (the expansion track). A
   * non-allowlisted tool still voids the run rather than appearing here: a
   * subject that reached for live data has the ground truth available to it,
   * so its answer cannot be attributed to the maplet.
   */
  toolsUsed?: string[];
}

export interface GroundTruth {
  /** Exact distance in metres along the network. */
  distanceM?: number;
  /** Duration in seconds. */
  durationS?: number;
  /** Street names on the route, in order. */
  streets?: string[];
  /**
   * The graph the model was shown, for self-consistent connectivity scoring.
   *
   * Carried rather than just a component count because judging connectivity
   * needs the graph to judge against: "the map says two parts are separate" and
   * "the real world has two parts" are different questions, and only the first
   * is answerable here.
   */
  graph?: SpatialGraph;
  /** Named places present in the source data. */
  names?: string[];
  /**
   * Other names the same places go by, from `alt_name`, `old_name`,
   * `official_name`, `short_name` and `loc_name`.
   *
   * A model that answers with a plaza's former name has not invented it. Without
   * these, a real answer was reported as inventing two plazas that are in the
   * fixture under `old_name` and `alt_name`.
   */
  aliases?: string[];
  /**
   * Named places present in what this arm was actually shown.
   *
   * The recall pass condition is measured against this, not against `names`. A
   * budget-fitted maplet at 1024 tokens carries a small fraction of the names in
   * the source, so scoring recall against the full list sets a pass condition no
   * budgeted arm can reach, and a run in which every arm scores zero is
   * indistinguishable from a run in which the task is impossible. The full-list
   * recall is still reported, because it is the number that quantifies what the
   * budget cost.
   */
  shownNames?: string[];
  /** Weakly-connected component count in the emitted graph. */
  components?: number;
  /**
   * What the maplet admitted to leaving out.
   *
   * Per layer, as emitted. This is the ground truth for the `omission` task: the
   * question is whether the model reports the gap rather than concluding the area
   * holds only what it can see.
   */
  omitted?: { layer: string; count: number }[];
  /** Total features present in the source, before budget fitting. */
  sourceFeatures?: number;
  /** Features that survived into the emitted graph. */
  emittedNodes?: number;
  /**
   * Footprint area in square metres, for the `expand` task.
   *
   * Shoelace over the source ring, equirectangular about its own latitude.
   * Replaces the earlier inside/outside formulation, which proved guessable
   * without the tool (a 1-in-3 name pick scores a third of the time by
   * chance). An area has no guessable answer: the space is every positive
   * number.
   */
  areaM2?: number;
  /** Peak scalar value, for the `heat` task. */
  peak?: number;
  /** Where the peak is, for the `heat` task. */
  peakAt?: { lat: number; lon: number };
}

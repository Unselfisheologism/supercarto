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
}

export interface ModelResponse {
  text: string;
  /** As reported by the provider, or estimated from character count. */
  inputTokens: number;
  outputTokens: number;
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
  /** Weakly-connected component count in the emitted graph. */
  components?: number;
}

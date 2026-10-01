/**
 * Benchmark types shared across the harness.
 */

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
  /** Named places present in the source data. */
  names?: string[];
  /** Weakly-connected component count in the emitted graph. */
  components?: number;
}

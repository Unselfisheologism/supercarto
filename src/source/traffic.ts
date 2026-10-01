/**
 * Traffic conditions.
 *
 * An agent that tells a person how long their drive will take is answering a
 * question whose answer changes minute to minute. A free-flow estimate of 22
 * minutes when the truth is 45 is worse than no answer: the person leaves on
 * the schedule the agent gave them.
 *
 * So traffic is treated as a first-class layer with an explicit absence. When
 * no flow source is configured the tool says so and falls back to free-flow
 * duration, labelled as free-flow. It never presents a free-flow number as if
 * it were live.
 */

import { OsrmRouter, OSRM_PROFILES, type RoutingSource, type TravelMode } from './routing.js';

/** How congested a road segment is, as a judgement rather than a speed. */
export type FlowLevel = 'free' | 'light' | 'moderate' | 'heavy' | 'severe' | 'unknown';

export interface FlowSegment {
  /** Road name, when the source has one. */
  road?: string;
  /** Congestion class. */
  level: FlowLevel;
  /** Current speed, km/h. */
  speedKmh?: number;
  /** Free-flow speed for the same segment, km/h. */
  freeFlowKmh?: number;
  /**
   * Speed as a fraction of free-flow, 0..1. This is the number that compares
   * segments with different speed limits; a 40km/h road at 40 and a 100km/h
   * road at 40 are not equally congested.
   */
  ratio?: number;
  /** Seconds of delay against free flow. */
  delayS?: number;
  /** True when the data is older than it should be for a live decision. */
  stale?: boolean;
}

export interface TrafficResult {
  level: FlowLevel;
  /** Worst level on the route. What a person cares about. */
  worstLevel: FlowLevel;
  /** Seconds. Equals free-flow when no flow source is configured. */
  durationS: number;
  /** Seconds at free-flow speed, for comparison. */
  freeFlowS: number;
  /** durationS minus freeFlowS. Zero when there is no flow data. */
  delayS: number;
  segments: FlowSegment[];
  /** Which source produced the flow figures, or `none`. */
  source: string;
  /**
   * Why there is no live flow, when there is none. Present so the agent can
   * tell the user the number is free-flow rather than silently trusting it.
   */
  unavailable?: string;
  /** True when every figure here is free-flow and ignores congestion. */
  freeFlowOnly: boolean;
}

export interface TrafficRequest {
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  mode?: TravelMode;
  signal?: AbortSignal;
}

export interface TrafficSource {
  readonly name: string;
  /** Whether a credential is present. False means the tool is not advertised. */
  configured(): boolean;
  /**
   * Congestion for a route, given the free-flow route from the router.
   *
   * Taking the route as input rather than recomputing it is deliberate: the
   * flow provider reports congestion per road, the router knows the geometry,
   * and joining them is the only way to produce a duration that is both
   * congestion-aware and consistent with the turn-by-turn instructions.
   */
  flow(
    req: TrafficRequest,
    freeFlow: RouteSummary,
  ): Promise<{ segments: FlowSegment[]; source: string } | undefined>;
}

export interface RouteSummary {
  durationS: number;
  /** Road names in order, used to match flow segments to legs. */
  roads: string[];
  geometry: [number, number][];
}

/**
 * TomTom traffic flow.
 *
 * Chosen as the default because it reports congestion per road segment, which
 * is the granularity an agent needs to say "the A406 is the slow part" rather
 * than a single average for the whole journey. Requires a key.
 */
export class TomTomFlow implements TrafficSource {
  readonly name = 'tomtom';

  private readonly key: string | undefined;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: {
    apiKey?: string;
    base?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {}) {
    this.key = opts.apiKey ?? process.env.TOMTOM_API_KEY ?? process.env.TRAFFIC_API_KEY;
    this.base = opts.base ?? 'https://api.tomtom.com';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  configured(): boolean {
    return typeof this.key === 'string' && this.key !== '';
  }

  async flow(req: TrafficRequest, freeFlow: RouteSummary) {
    if (!this.configured()) return undefined;
    const points = waypoints(freeFlow.geometry, req).join(';');
    if (points.length < 3) return undefined;

    const url =
      `${this.base}/traffic/services/flowinformation` +
      `?key=${encodeURIComponent(this.key!)}` +
      `&points=${points}&unit=kmh&language=en&departureTime=now`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal });
      if (!res.ok) return undefined;
      const body = (await res.json()) as TomTomFlowResponse;
      const segments: FlowSegment[] = [];
      for (const road of body.flows ?? []) {
      for (const f of road.flows ?? []) {
        const speed = typeof f.currentSpeed === 'number' ? f.currentSpeed : undefined;
        const free = typeof f.freeFlowSpeed === 'number' ? f.freeFlowSpeed : undefined;
        // A ratio below 1 means slower than free flow. TomTom occasionally
        // reports current above free flow on a mis-tagged road; clamping keeps
        // a bad sample from reading as "faster than the limit".
        const ratio = speed !== undefined && free !== undefined && free > 0
          ? Math.min(1, speed / free)
          : undefined;
        const roadName = typeof f.roadName === 'string' ? f.roadName : undefined;
        const segment: FlowSegment = {
          ...(roadName ? { road: roadName } : {}),
          level: ratio === undefined ? 'unknown' : levelForRatio(ratio),
          ...(speed !== undefined ? { speedKmh: speed } : {}),
          ...(free !== undefined ? { freeFlowKmh: free } : {}),
          ...(ratio !== undefined ? { ratio: Math.round(ratio * 100) / 100 } : {}),
          ...(f.confidence === 'low' ? { stale: true } : {}),
        };
        segments.push(segment);
      }
      }
      if (segments.length === 0) return undefined;
      return { segments, source: this.name };
    } catch {
      // A flow provider that is slow or broken degrades to free-flow, which the
      // caller labels. Returning undefined rather than throwing keeps one dead
      // third party from failing a routing request that is otherwise fine.
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface TomTomFlowResponse {
  flows?: Array<{
    roadName?: string;
    flows?: Array<{
      currentSpeed?: number;
      freeFlowSpeed?: number;
      confidence?: string;
      roadName?: string;
    }>;
  }>;
}

/** HERE Traffic, the alternative provider. Same interface, different payload. */
export class HereFlow implements TrafficSource {
  readonly name = 'here';

  private readonly key: string | undefined;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: {
    apiKey?: string;
    base?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {}) {
    this.key = opts.apiKey ?? process.env.HERE_API_KEY;
    this.base = opts.base ?? 'https://traffic.ls.hereapi.com';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  configured(): boolean {
    return typeof this.key === 'string' && this.key !== '';
  }

  async flow(req: TrafficRequest, freeFlow: RouteSummary) {
    if (!this.configured()) return undefined;
    const points = waypoints(freeFlow.geometry, req);
    if (points.length < 2) return undefined;
    // HERE takes longitude,latitude ordered semicolon-separated points, one
    // group per road, with groups separated by `|`. TomTom takes the opposite
    // order, so the pairs are reversed here rather than at the call site.
    const path = points
      .map((p) => {
        const parts = p.split(',');
        return `${parts[1]};${parts[0]}`;
      })
      .join('|');

    const url =
      `${this.base}/traffic/v2/flow?apiKey=${encodeURIComponent(this.key!)}` +
      `&points=${path}&return=summary,polyline`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal });
      if (!res.ok) return undefined;
      const body = (await res.json()) as {
        currentFlow?: Array<{
          location?: { roadName?: string; freeFlowSpeed?: number; currentSpeed?: number };
          confidence?: string;
        }>;
      };
      const segments: FlowSegment[] = [];
      for (const f of body.currentFlow ?? []) {
        const loc = f.location ?? {};
        const ratio =
          typeof loc.currentSpeed === 'number' && typeof loc.freeFlowSpeed === 'number' && loc.freeFlowSpeed > 0
            ? Math.min(1, loc.currentSpeed / loc.freeFlowSpeed)
            : undefined;
        if (ratio === undefined) continue;
        segments.push({
          ...(loc.roadName ? { road: loc.roadName } : {}),
          level: levelForRatio(ratio),
          speedKmh: loc.currentSpeed,
          freeFlowKmh: loc.freeFlowSpeed,
          ratio: Math.round(ratio * 100) / 100,
          ...(f.confidence === 'low' ? { stale: true } : {}),
        });
      }
      if (segments.length === 0) return undefined;
      return { segments, source: this.name };
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Congestion from a speed ratio.
 *
 * Thresholds follow what road agencies use for level-of-service grading rather
 * than arbitrary round numbers, because those are the numbers a person's
 * intuition is already calibrated on: below 70% of free flow a road is
 * genuinely congested, not merely "a bit busy".
 */
export function levelForRatio(ratio: number): FlowLevel {
  if (ratio >= 0.9) return 'free';
  if (ratio >= 0.75) return 'light';
  if (ratio >= 0.6) return 'moderate';
  if (ratio >= 0.4) return 'heavy';
  return 'severe';
}

/**
 * Traffic-aware routing.
 *
 * Wraps a router and, when a flow source is configured, corrects the free-flow
 * duration by the congestion actually observed on the route. With no flow
 * source the answer is free-flow and says so in `freeFlowOnly` and in the text
 * the agent renders, because the alternative is a confidently wrong ETA.
 */
export class TrafficRouter {
  private readonly router: RoutingSource;
  private readonly flows: TrafficSource[];

  constructor(router: RoutingSource, flows: TrafficSource[] = []) {
    this.router = router;
    this.flows = flows;
  }

  /** Whether any flow provider has a credential. Gates advertising the tool. */
  get hasFlow(): boolean {
    return this.flows.some((f) => f.configured());
  }

  async route(req: TrafficRequest): Promise<TrafficResult> {
    const mode = req.mode ?? 'drive';
    const routed = await this.router.route({ ...req, mode });
    const freeFlow = routeSummary(routed);

    for (const provider of this.flows) {
      if (!provider.configured()) continue;
      // The guard belongs here as well as inside each provider. A third-party
      // implementation that throws must not take down a routing request that
      // is otherwise fine, and only the caller can guarantee that for providers
      // it did not write.
      let got: { segments: FlowSegment[]; source: string } | undefined;
      try {
        got = await provider.flow(req, freeFlow);
      } catch {
        continue;
      }
      if (!got || got.segments.length === 0) continue;

      const ratios = got.segments
        .map((s) => s.ratio)
        .filter((r): r is number => typeof r === 'number');
      const worstLevel = got.segments.reduce<FlowLevel>(
        (worst, s) => (severity(s.level) > severity(worst) ? s.level : worst),
        'free',
      );

      // Overall level uses the mean ratio, because a single slow junction is
      // not a congested journey. The worst segment is reported separately as
      // `worstLevel`, which is the actionable part.
      const mean = ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 1;
      const overall: FlowLevel = ratios.length > 0 ? levelForRatio(mean) : 'unknown';

      // Duration scales by the congestion actually observed. A delay figure from
      // the provider is preferred when present, because it comes from the
      // provider's own historical model rather than a single current sample.
      const statedDelay = got.segments.reduce((a, s) => a + (s.delayS ?? 0), 0);
      const delayS =
        statedDelay > 0 ? statedDelay : Math.round(freeFlow.durationS * (1 / Math.max(0.2, mean) - 1));

      return {
        level: overall,
        worstLevel,
        durationS: freeFlow.durationS + delayS,
        freeFlowS: freeFlow.durationS,
        delayS,
        segments: got.segments,
        source: got.source,
        freeFlowOnly: false,
      };
    }

    return {
      level: 'unknown',
      worstLevel: 'unknown',
      durationS: freeFlow.durationS,
      freeFlowS: freeFlow.durationS,
      delayS: 0,
      segments: [],
      source: 'none',
      unavailable:
        'no traffic flow source configured; duration is free-flow and ignores ' +
        'congestion. Set TOMTOM_API_KEY or HERE_API_KEY for live conditions.',
      freeFlowOnly: true,
    };
  }
}

function severity(level: FlowLevel): number {
  switch (level) {
    case 'severe':
      return 5;
    case 'heavy':
      return 4;
    case 'moderate':
      return 3;
    case 'light':
      return 2;
    case 'free':
      return 1;
    default:
      return 0;
  }
}

function routeSummary(routed: { route: { time?: number; steps: RouteStepLike[] }; geometry: [number, number][]; source: string }): RouteSummary {
  return {
    // `time` is absent on a straight-line fallback, in which case the caller's
    // own estimate is already an approximation and doubling it would be noise.
    durationS: routed.route.time ?? 0,
    roads: routed.route.steps
      .map((s) => s.turn)
      .filter((t): t is string => typeof t === 'string' && t !== ''),
    geometry: routed.geometry,
  };
}

interface RouteStepLike {
  turn?: string;
}

/** TomTom and HERE both cap the number of sampled points, so thin the path. */
function waypoints(geometry: [number, number][], req: TrafficRequest): string[] {
  const pts: string[] = [];
  const push = (lon: number, lat: number) => {
    const s = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (pts[pts.length - 1] !== s) pts.push(s);
  };
  push(req.from.lon, req.from.lat);
  const stride = Math.max(1, Math.floor(geometry.length / 100));
  for (let i = 0; i < geometry.length; i += stride) {
    const p = geometry[i]!;
    push(p[0], p[1]);
  }
  push(req.to.lon, req.to.lat);
  return pts;
}

export { OsrmRouter, OSRM_PROFILES };
export type { TravelMode };

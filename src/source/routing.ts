import type { Route, RouteStep } from '../wire/types.js';
import { gridToLonLat } from '../geo/project.js';
import type { Envelope } from '../wire/types.js';

/**
 * Turn-by-turn routing.
 *
 * A language model gains nothing from four hundred route coordinates. It gains
 * everything from "turn left on 5th Street". So a route is produced as prose
 * steps, with the full geometry left behind for code.
 */

export type TravelMode = 'walk' | 'bike' | 'drive';

export interface RouteRequest {
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  mode?: TravelMode;
  signal?: AbortSignal;
}

export interface RouteResult {
  route: Route;
  /** Full geometry, for code that needs it. Not shown to the model. */
  geometry: [number, number][];
  source: string;
}

export interface RoutingSource {
  readonly name: string;
  route(req: RouteRequest): Promise<RouteResult>;
}

/** Profile names per engine: OSRM uses paths, Valhalla uses costing models. */
export const OSRM_PROFILES: Record<TravelMode, string> = {
  walk: 'foot',
  bike: 'bike',
  drive: 'driving',
};

export interface OsrmOptions {
  /** Public demo server. Point at your own OSRM for real use. */
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Bearing names for the instruction text. */
  readonly bearings?: string[];
}

const OSRM_DEFAULT = 'https://router.project-osrm.org';
const DEFAULT_BEARINGS = [
  'north', 'northeast', 'east', 'southeast',
  'south', 'southwest', 'west', 'northwest',
];

/**
 * OSRM, the reference routing engine.
 *
 * Its `/route/v1` response already contains what a model needs: per-leg
 * distance, duration, and a maneuver bearing with a type. That maps directly
 * onto SCR's `ROUTE` and `STEP` records without any geometry work.
 */
export class OsrmRouter implements RoutingSource {
  readonly name = 'osrm';

  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly bearings: string[];

  constructor(opts: OsrmOptions = {}) {
    this.endpoint = opts.endpoint ?? OSRM_DEFAULT;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.bearings = opts.bearings ?? DEFAULT_BEARINGS;
  }

  async route(req: RouteRequest): Promise<RouteResult> {
    const mode = req.mode ?? 'walk';
    const profile = OSRM_PROFILES[mode];

    const coords = `${req.from.lon},${req.from.lat};${req.to.lon},${req.to.lat}`;
    const url =
      `${this.endpoint}/route/v1/${profile}/${coords}` +
      `?overview=full&geometries=geojson&steps=true`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    req.signal?.addEventListener('abort', onAbort);

    try {
      const res = await this.fetchImpl(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`OSRM responded ${res.status} ${res.statusText}`);

      const body = (await res.json()) as {
        code?: string;
        routes?: Array<{
          distance: number;
          duration: number;
          geometry?: { coordinates: [number, number][] };
          legs?: Array<{
            distance: number;
            duration: number;
            steps?: Array<{
              distance: number;
              duration: number;
              maneuver?: {
                type: string;
                modifier?: string;
                bearing_after?: number;
                bearing_before?: number;
                location?: [number, number];
              };
              name?: string;
            }>;
          }>;
        }>;
      };

      if (body.code !== 'Ok' || !body.routes || body.routes.length === 0) {
        throw new Error(`no route found (OSRM code ${body.code ?? 'unknown'})`);
      }

      const r = body.routes[0]!;
      const steps: RouteStep[] = [];
      let n = 1;

      for (const leg of r.legs ?? []) {
        for (const s of leg.steps ?? []) {
          const instruction = this.instruction(s);
          if (instruction === null) continue;
          const step: RouteStep = { n: n++, instruction, dist: Math.round(s.distance) };
          if (s.name) step.turn = s.name;
          steps.push(step);
        }
      }

      const route: Route = {
        id: 1,
        mode,
        dist: Math.round(r.distance),
        time: Math.round(r.duration),
        steps,
      };

      return {
        route,
        geometry: r.geometry?.coordinates ?? [],
        source: this.name,
      };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Turn an OSRM maneuver into a sentence.
   *
   * Prose, because the consumer is a language model that was trained on prose
   * and reads it far more reliably than a structured enum. Returns null for
   * maneuvers that carry no information - the "continue straight" markers at
   * every vertex of a straight road would otherwise triple the step count.
   */
  private instruction(s: {
    distance: number;
    maneuver?: { type: string; modifier?: string; bearing_after?: number };
    name?: string;
  }): string | null {
    const m = s.maneuver;
    if (!m) return null;
    const road = s.name;

    switch (m.type) {
      case 'depart':
        return road ? `head onto ${road}` : 'head out';
      case 'arrive':
        return road ? `arrive on ${road}` : 'arrive at your destination';
      case 'turn':
      case 'end of road': {
        const dir = m.modifier ?? this.bearingWord(m.bearing_after);
        if (!dir) return null;
        return road ? `turn ${dir} onto ${road}` : `turn ${dir}`;
      }
      case 'continue':
      case 'new name':
        return road ? `continue on ${road}` : null;
      case 'merge':
      case 'on ramp':
      case 'off ramp':
        return road ? `take the ramp onto ${road}` : null;
      case 'roundabout':
      case 'rotary':
      case 'roundabout turn':
      case 'exit roundabout':
      case 'exit rotary': {
        const exit = m.modifier ? ` (${m.modifier} exit)` : '';
        return `roundabout${exit}${road ? ` onto ${road}` : ''}`;
      }
      case 'fork':
        return road ? `keep ${m.modifier ?? 'straight'} onto ${road}` : null;
      case 'uturn':
        return 'make a U-turn';
      default:
        return null;
    }
  }

  private bearingWord(bearing: number | undefined): string | undefined {
    if (bearing === undefined) return undefined;
    const idx = Math.round((bearing / 45) % 8);
    return this.bearings[((idx % 8) + 8) % 8];
  }
}

/**
 * Build a lightweight straight-line route for when no routing engine is
 * configured.
 *
 * It is explicitly not turn-by-turn, and the mode name says so, because an
 * agent that believes it has real turn instructions when it has two points and
 * a distance will confidently send someone the wrong way. The dist/time figures
 * are present; the instruction is honest about its own inadequacy.
 */
export function straightLineRoute(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  mode: TravelMode = 'walk',
): RouteResult {
  // Great-circle distance, then a flat-world conversion to metres.
  const R = 6371008.8;
  const dLat = ((to.lat - from.lat) * Math.PI) / 180;
  const dLon = ((to.lon - from.lon) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((from.lat * Math.PI) / 180) * Math.cos((to.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  const distance = Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(a))));

  // Rough speeds: walking 1.35 m/s, cycling 4.5, driving 11.
  const speed = mode === 'walk' ? 1.35 : mode === 'bike' ? 4.5 : 11;
  const duration = Math.round(distance / speed);

// Initial great-circle bearing, via the standard spherical formula.
  const toRad = Math.PI / 180;
  const phi1 = from.lat * toRad;
  const phi2 = to.lat * toRad;
  const lambda1 = from.lon * toRad;
  const lambda2 = to.lon * toRad;
  const y = Math.sin(lambda2 - lambda1) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(lambda2 - lambda1);
  const bearingDeg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  const dir = DEFAULT_BEARINGS[Math.round(bearingDeg / 45) % 8]!;

  return {
    route: {
      id: 1,
      mode: `${mode}-approx`,
      dist: distance,
      time: duration,
      steps: [
        {
          n: 1,
          instruction: `head ${dir} toward the destination (approx ${distance}m, no routing engine configured)`,
          dist: distance,
        },
      ],
    },
    geometry: [
      [from.lon, from.lat],
      [to.lon, to.lat],
    ],
    source: 'straight-line',
  };
}

export { gridToLonLat };
export type { Envelope };
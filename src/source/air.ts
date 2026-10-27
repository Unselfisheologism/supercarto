/**
 * Air quality.
 *
 * An agent that tells someone they can walk, run, or take the baby outside is
 * making an air claim. Particulate load changes that claim in ways a
 * temperature never will, so air quality joins weather as a decision input
 * rather than a dashboard statistic.
 *
 * The source is the Open-Meteo Air Quality API, jointly feeding CAMS global
 * data. Like the forecast source it needs no API key, no account, and no
 * billing, so an evaluation is never gated on a signup. It resolves a
 * coordinate onto a coarse model grid - the offset is carried in the result so
 * an agent quoting the number knows how far the sample was taken from where
 * the person is standing.
 */

import { plainFetch } from './types.js';

/** European AQI band for a raw 0-200+ index. */
export function describeEuropeanAqi(aqi: number): string {
  if (Number.isNaN(aqi)) return 'unknown';
  if (aqi <= 20) return 'good';
  if (aqi <= 40) return 'fair';
  if (aqi <= 60) return 'moderate';
  if (aqi <= 80) return 'poor';
  if (aqi <= 100) return 'very poor';
  return 'extremely poor';
}

/** US EPA band for a raw 0-500 index. */
export function describeUsAqi(aqi: number): string {
  if (Number.isNaN(aqi)) return 'unknown';
  if (aqi <= 50) return 'good';
  if (aqi <= 100) return 'moderate';
  if (aqi <= 150) return 'unhealthy for sensitive';
  if (aqi <= 200) return 'unhealthy';
  if (aqi <= 300) return 'very unhealthy';
  return 'hazardous';
}

export interface AirQualityNow {
  /** European AQI, 0-200+. Lower is cleaner. The band is what a model acts on. */
  europeanAqi: number;
  /** US EPA AQI, 0-500. Reported alongside because both appear in prompts. */
  usAqi: number;
  /** Fine particles, µg/m³. The pollutant regulators act on first. */
  pm25UgM3: number;
  /** Coarse particles, µg/m³. Drives dust and road pollution. */
  pm10UgM3: number;
  ozoneUgM3: number;
  no2UgM3: number;
  so2UgM3: number;
  coUgM3: number;
  /** Iso timestamp of the observation, or undefined when the source omits it. */
  at?: string;
}

export interface AirQualityHour {
  at: string;
  europeanAqi: number;
  usAqi: number;
  pm25UgM3: number;
  pm10UgM3: number;
}

export interface AirQualityResult {
  now: AirQualityNow;
  /** Hourly forecast, already trimmed to the requested window. */
  hourly: AirQualityHour[];
  /** Coordinate actually covered, which the source may snap to its grid. */
  lat: number;
  lon: number;
  /** Metres between the request and the grid point served. */
  gridOffsetM: number;
  source: string;
  /** Set when the source could not be reached; `now` is then best-effort. */
  degraded?: string;
}

export interface AirQualitySource {
  readonly name: string;
  fetch(lat: number, lon: number, forecastHours?: number, signal?: AbortSignal): Promise<AirQualityResult>;
}

export interface OpenMeteoAirOptions {
  /**
   * Default is the free public instance. Point at your own deployment for
   * production: the public one is shared and rate limited, and the terms of a
   * free tier are not a basis for a product.
   */
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const OPEN_METEO_AIR_DEFAULT = 'https://air-quality-api.open-meteo.com/v1/air-quality';

/**
 * Current fields requested.
 *
 * Deliberate selection again: two independent index scales (models act on
 * either), the two particulate fractions a person is generally told about,
 * and the regulated gases. Missing gases stay NaN and render as unknown; they
 * are never zero-filled, because a zero NO2 reading invented from a gap
 * would certify airspace as clean.
 */
const CURRENT_FIELDS = [
  'european_aqi',
  'us_aqi',
  'pm10',
  'pm2_5',
  'carbon_monoxide',
  'nitrogen_dioxide',
  'sulphur_dioxide',
  'ozone',
] as const;

const HOURLY_FIELDS = ['european_aqi', 'us_aqi', 'pm2_5', 'pm10'] as const;

export class OpenMeteoAir implements AirQualitySource {
  readonly name = 'open-meteo-air';

  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: OpenMeteoAirOptions = {}) {
    this.endpoint = opts.endpoint ?? OPEN_METEO_AIR_DEFAULT;
    this.fetchImpl = opts.fetchImpl ?? plainFetch;
    this.timeoutMs = opts.timeoutMs ?? 12_000;
  }

  async fetch(
    lat: number,
    lon: number,
    forecastHours = 12,
    signal?: AbortSignal,
  ): Promise<AirQualityResult> {
    const days = Math.max(1, Math.min(5, Math.ceil(forecastHours / 24) + 1));
    const params = new URLSearchParams({
      latitude: lat.toFixed(5),
      longitude: lon.toFixed(5),
      current: CURRENT_FIELDS.join(','),
      hourly: HOURLY_FIELDS.join(','),
      forecast_days: String(days),
      timezone: 'UTC',
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);

    try {
      const res = await this.fetchImpl(`${this.endpoint}?${params.toString()}`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`air source responded ${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as OpenMeteoAirBody;
      if (body.error) throw new Error(`air source error: ${body.reason ?? 'unknown'}`);

      return {
        now: readNow(body),
        hourly: readHourly(body, forecastHours),
        lat: typeof body.latitude === 'number' ? body.latitude : lat,
        lon: typeof body.longitude === 'number' ? body.longitude : lon,
        gridOffsetM: gridOffset(lat, lon, body.latitude, body.longitude),
        source: this.name,
      };
    } catch (err) {
      // Air is an input to a health-affecting decision. When the source is
      // unreachable the caller gets an explicitly-degraded result rather than
      // an exception, and the tool layer turns that into a refusal - the same
      // contract as weather, for the same reason.
      const degraded = err instanceof Error ? err.message : String(err);
      return {
        now: unknownConditions(),
        hourly: [],
        lat,
        lon,
        gridOffsetM: 0,
        source: this.name,
        degraded,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

interface OpenMeteoAirBody {
  latitude?: number;
  longitude?: number;
  error?: boolean;
  reason?: string;
  current?: Record<string, number | string>;
  hourly?: Record<string, Array<number | string | null>>;
}

/**
 * Coerce one cell of a forecast array to a number.
 *
 * A null in a gap arrives as null, and treating it as 0 would invent clean
 * air. Anything unusable becomes NaN, which the formatter renders as
 * `unknown` rather than a plausible value.
 */
function cell(v: number | string | null | undefined): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : Number.NaN;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : Number.NaN;
  }
  return Number.NaN;
}

function readNow(body: OpenMeteoAirBody): AirQualityNow {
  const c = body.current ?? {};
  const num = (k: string): number => cell(c[k]);
  return {
    europeanAqi: num('european_aqi'),
    usAqi: num('us_aqi'),
    pm25UgM3: num('pm2_5'),
    pm10UgM3: num('pm10'),
    ozoneUgM3: num('ozone'),
    no2UgM3: num('nitrogen_dioxide'),
    so2UgM3: num('sulphur_dioxide'),
    coUgM3: num('carbon_monoxide'),
    at: typeof c.time === 'string' ? `${c.time}:00Z` : undefined,
  };
}

function readHourly(body: OpenMeteoAirBody, hours: number): AirQualityHour[] {
  const h = body.hourly;
  if (!h) return [];
  const times = h.time;
  if (!Array.isArray(times)) return [];

  // The source returns the whole day from 00:00 local-to-the-grid. An agent
  // asking about "now" wants forward-looking hours, so the window is trimmed
  // to start at the current hour rather than replaying the night.
  const start = findNowIndex(times, body.current?.time);
  const out: AirQualityHour[] = [];
  for (let i = start; i < times.length && out.length < hours; i++) {
    const at = times[i];
    if (typeof at !== 'string') continue;
    out.push({
      at: `${at}:00Z`,
      europeanAqi: cell(h.european_aqi?.[i]),
      usAqi: cell(h.us_aqi?.[i]),
      pm25UgM3: cell(h.pm2_5?.[i]),
      pm10UgM3: cell(h.pm10?.[i]),
    });
  }
  return out;
}

function findNowIndex(times: Array<number | string | null>, currentTime: unknown): number {
  if (typeof currentTime !== 'string') return 0;
  const hour = currentTime.slice(0, 13);
  const idx = times.findIndex((t) => typeof t === 'string' && t.slice(0, 13) === hour);
  return idx >= 0 ? idx : 0;
}

/**
 * Where the European index is "good" per gas.
 *
 * A gas is only named in the answer when it clears its own good bound on the
 * European scale (NO2 > 50, O3 > 100, SO2 > 100, CO > 4000 µg/m³). Naming
 * every gas every time burns tokens on numbers nobody can act on; naming the
 * offender is the whole point.
 */
export function elevatedGases(n: AirQualityNow): string[] {
  const out: string[] = [];
  if (Number.isFinite(n.no2UgM3) && n.no2UgM3 > 50) out.push(`NO2 ${n.no2UgM3}`);
  if (Number.isFinite(n.ozoneUgM3) && n.ozoneUgM3 > 100) out.push(`O3 ${n.ozoneUgM3}`);
  if (Number.isFinite(n.so2UgM3) && n.so2UgM3 > 100) out.push(`SO2 ${n.so2UgM3}`);
  if (Number.isFinite(n.coUgM3) && n.coUgM3 > 4000) out.push(`CO ${n.coUgM3}`);
  return out;
}

/**
 * A place-holder for when the source could not be reached.
 *
 * NaN rather than 0 is deliberate. A model given `pm25UgM3: 0` will tell
 * someone with asthma the air is fine. Given NaN, it hedges.
 */
function unknownConditions(): AirQualityNow {
  return {
    europeanAqi: Number.NaN,
    usAqi: Number.NaN,
    pm25UgM3: Number.NaN,
    pm10UgM3: Number.NaN,
    ozoneUgM3: Number.NaN,
    no2UgM3: Number.NaN,
    so2UgM3: Number.NaN,
    coUgM3: Number.NaN,
  };
}

function gridOffset(lat: number, lon: number, glat?: number, glon?: number): number {
  if (typeof glat !== 'number' || typeof glon !== 'number') return 0;
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (glat - lat) * toRad;
  const dLon = (glon - lon) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat * toRad) * Math.cos(glat * toRad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(a))));
}

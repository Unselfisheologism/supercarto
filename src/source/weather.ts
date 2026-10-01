/**
 * Weather.
 *
 * An agent that books a ride, plans a walk, or tells someone when to leave is
 * working for a person who is standing outside. Rain and wind change whether
 * the trip is worth making and how long it will take, so weather is not a
 * cosmetic enrichment - it is an input to the decision the human is actually
 * making.
 *
 * The source is Open-Meteo, which needs no API key, no account, and no billing,
 * and returns a forecast at a coordinate. That matters: a paid weather key
 * would put a signup wall in front of every evaluation of this library.
 */

export type PrecipitationKind = 'none' | 'rain' | 'snow' | 'sleet' | 'hail' | 'drizzle';

export interface WeatherNow {
  /** Air temperature, °C. */
  tempC: number;
  /** Apparent temperature, °C. What a person actually feels. */
  feelsLikeC: number;
  precipitationMm: number;
  precipitation: PrecipitationKind;
  /** WMO weather code, kept because it is the vendor-neutral description. */
  code: number;
  /** One-line human description of the code. */
  summary: string;
  cloudCoverPct: number;
  /** Sustained wind, km/h. */
  windKmh: number;
  windDirDeg: number;
  /** Wind gusts, km/h. This is what closes a bridge or fells a tree. */
  gustKmh: number;
  /** Horizontal visibility, metres. Drops sharply in fog. */
  visibilityM: number;
  /** Relative humidity, %. */
  humidityPct: number;
  /** Iso timestamp of the observation, or undefined when the source omits it. */
  at?: string;
  /** True when the sun is below the horizon at the location. */
  night: boolean;
}

export interface WeatherHour {
  at: string;
  tempC: number;
  precipitationMm: number;
  precipitation: PrecipitationKind;
  windKmh: number;
  /** WMO code, for icon-level detail on the hour. */
  code: number;
}

export interface WeatherDay {
  date: string;
  tempMaxC: number;
  tempMinC: number;
  precipitationMm: number;
  precipitationProbPct: number;
  windKmh: number;
  code: number;
}

export interface WeatherResult {
  now: WeatherNow;
  /** Hourly forecast, already trimmed to the requested window. */
  hourly: WeatherHour[];
  daily: WeatherDay[];
  /** Coordinate actually covered, which the source may snap to its own grid. */
  lat: number;
  lon: number;
  /** Metres between the request and the grid point served. */
  gridOffsetM: number;
  source: string;
  /** Set when the source could not be reached; `now` is then best-effort. */
  degraded?: string;
}

export interface WeatherSource {
  readonly name: string;
  /**
   * Conditions at a point.
   *
   * @param forecastHours how many hours of forecast to return. Default 12.
   */
  fetch(
    lat: number,
    lon: number,
    forecastHours?: number,
    signal?: AbortSignal,
  ): Promise<WeatherResult>;
}

export interface OpenMeteoOptions {
  /**
   * Default is the free public instance. Point at your own deployment for
   * production: the public one is shared and rate limited, and the terms of a
   * free tier are not a basis for a product.
   */
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Units. Celsius and km/h, because that is what a person will be told. */
  readonly units?: 'metric';
}

const OPEN_METEO_DEFAULT = 'https://api.open-meteo.com/v1/forecast';

/**
 * Current fields requested.
 *
 * The list is deliberate rather than maximal. Every extra field is a token in
 * the agent's context and a claim it may act on, so each one here has to earn
 * its place: a temperature a person will feel, precipitation that changes
 * whether they go out, wind that changes whether an umbrella is enough, and
 * visibility that changes whether driving is safe.
 */
const CURRENT_FIELDS = [
  'temperature_2m',
  'apparent_temperature',
  'precipitation',
  'rain',
  'showers',
  'snowfall',
  'weather_code',
  'cloud_cover',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'visibility',
  'relative_humidity_2m',
  'is_day',
] as const;

const HOURLY_FIELDS = [
  'temperature_2m',
  'precipitation',
  'rain',
  'showers',
  'snowfall',
  'weather_code',
  'wind_speed_10m',
] as const;

const DAILY_FIELDS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_sum',
  'precipitation_probability_max',
  'wind_speed_10m_max',
] as const;

export class OpenMeteoWeather implements WeatherSource {
  readonly name = 'open-meteo';

  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: OpenMeteoOptions = {}) {
    this.endpoint = opts.endpoint ?? OPEN_METEO_DEFAULT;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 12_000;
  }

  async fetch(
    lat: number,
    lon: number,
    forecastHours = 12,
    signal?: AbortSignal,
  ): Promise<WeatherResult> {
    const days = Math.max(1, Math.min(7, Math.ceil(forecastHours / 24) + 1));
    const params = new URLSearchParams({
      latitude: lat.toFixed(5),
      longitude: lon.toFixed(5),
      current: CURRENT_FIELDS.join(','),
      hourly: HOURLY_FIELDS.join(','),
      daily: DAILY_FIELDS.join(','),
      forecast_days: String(days),
      timezone: 'UTC',
      wind_speed_unit: 'kmh',
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);

    let degraded: string | undefined;
    try {
      const res = await this.fetchImpl(`${this.endpoint}?${params.toString()}`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`weather source responded ${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as OpenMeteoBody;
      if (body.error) throw new Error(`weather source error: ${body.reason ?? 'unknown'}`);

      const now = readNow(body);
      return {
        now,
        hourly: readHourly(body, forecastHours),
        daily: readDaily(body),
        lat: typeof body.latitude === 'number' ? body.latitude : lat,
        lon: typeof body.longitude === 'number' ? body.longitude : lon,
        gridOffsetM: gridOffset(lat, lon, body.latitude, body.longitude),
        source: this.name,
        ...(degraded ? { degraded } : {}),
      };
    } catch (err) {
      // Weather is an input to a decision, not the decision. When the source is
      // unreachable the agent still needs a well-formed answer rather than an
      // exception, so an explicitly-labelled "unknown" is returned. The label
      // matters: an agent told "no data" will ask again or hedge, whereas one
      // handed fabricated sunshine will tell a person to leave their umbrella.
      degraded = err instanceof Error ? err.message : String(err);
      return {
        now: unknownConditions(),
        hourly: [],
        daily: [],
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

interface OpenMeteoBody {
  latitude?: number;
  longitude?: number;
  error?: boolean;
  reason?: string;
  current?: Record<string, number | string>;
  hourly?: Record<string, Array<number | string | null>>;
  daily?: Record<string, Array<number | string | null>>;
}

/**
 * Coerce one cell of a forecast array to a number.
 *
 * The API is typed as an array of numbers but a null in a gap arrives as null,
 * and treating a null as 0 would invent a comfortable 0 degrees in the middle
 * of the Sahara. Anything unusable becomes NaN, which the formatter renders as
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

/** Same, defaulting a gap to 0 for quantities where 0 is the honest value. */
function cellOrZero(v: number | string | null | undefined): number {
  const n = cell(v);
  return Number.isNaN(n) ? 0 : n;
}

function readNow(body: OpenMeteoBody): WeatherNow {
  const c = body.current ?? {};
  const num = (k: string): number => cell(c[k]);
  const code = cellOrZero(c.weather_code);
  const isDay = cellOrZero(c.is_day) === 1;
  const rain = cellOrZero(c.rain) + cellOrZero(c.showers);
  const snow = cellOrZero(c.snowfall);
  const visibility = cell(c.visibility);
  return {
    tempC: num('temperature_2m'),
    feelsLikeC: num('apparent_temperature'),
    precipitationMm: num('precipitation'),
    precipitation: classifyPrecipitation(rain, snow, code),
    code,
    summary: describeCode(code, isDay),
    cloudCoverPct: num('cloud_cover'),
    windKmh: num('wind_speed_10m'),
    windDirDeg: num('wind_direction_10m'),
    gustKmh: num('wind_gusts_10m'),
    // Visibility is absent in some regions; 10km is the standard "unlimited"
    // figure, but it is only used when the source actually omits the field, not
    // when it reports 0.
    visibilityM: Number.isNaN(visibility) ? 10_000 : visibility,
    humidityPct: num('relative_humidity_2m'),
    at: typeof c.time === 'string' ? `${c.time}:00Z` : undefined,
    night: !isDay,
  };
}

function readHourly(body: OpenMeteoBody, hours: number): WeatherHour[] {
  const h = body.hourly;
  if (!h) return [];
  const times = h.time;
  if (!Array.isArray(times)) return [];

  // The source returns the whole day from 00:00 local-to-the-grid. An agent
  // asking about "now" wants forward-looking hours, so the window is trimmed to
  // start at the current hour rather than replaying the morning.
  const start = findNowIndex(times, body.current?.time);
  const out: WeatherHour[] = [];
  for (let i = start; i < times.length && out.length < hours; i++) {
    const at = times[i];
    if (typeof at !== 'string') continue;
    const rain = cellOrZero(h.rain?.[i]) + cellOrZero(h.showers?.[i]);
    const snow = cellOrZero(h.snowfall?.[i]);
    out.push({
      at: `${at}:00Z`,
      tempC: cell(h.temperature_2m?.[i]),
      precipitationMm: cell(h.precipitation?.[i]),
      precipitation: classifyPrecipitation(rain, snow, cellOrZero(h.weather_code?.[i])),
      windKmh: cell(h.wind_speed_10m?.[i]),
      code: cellOrZero(h.weather_code?.[i]),
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

function readDaily(body: OpenMeteoBody): WeatherDay[] {
  const d = body.daily;
  if (!d) return [];
  const dates = d.time;
  if (!Array.isArray(dates)) return [];
  return dates.map((date, i) => ({
    date: String(date),
    tempMaxC: cell(d.temperature_2m_max?.[i]),
    tempMinC: cell(d.temperature_2m_min?.[i]),
    precipitationMm: cell(d.precipitation_sum?.[i]),
    precipitationProbPct: cell(d.precipitation_probability_max?.[i]),
    windKmh: cell(d.wind_speed_10m_max?.[i]),
    code: cellOrZero(d.weather_code?.[i]),
  }));
}

/**
 * Which kind of precipitation is falling.
 *
 * The distinction is not cosmetic. Rain means an umbrella, snow means a coated
 * jacket and a changed ETA, and sleet means both, so collapsing them into a
 * number would throw away the part a person acts on.
 */
function classifyPrecipitation(rain: number, snow: number, code: number): PrecipitationKind {
  if (snow > 0 && rain > 0) return 'sleet';
  if (snow > 0) return 'snow';
  // Codes 95-99 are thunderstorm, which is a convective event and can carry
  // hail even when the rain total is small; 85 and 86 are snow showers.
  if (code >= 95) return 'hail';
  if (code === 85 || code === 86) return 'snow';
  if (rain > 0) return code >= 51 && code <= 57 ? 'drizzle' : 'rain';
  return 'none';
}

/**
 * WMO code to a phrase a model can act on.
 *
 * The numeric code is preserved alongside because it is the stable identifier,
 * but a model reads "heavy rain" and does not read 50213.
 */
export function describeCode(code: number, isDay = true): string {
  switch (code) {
    case 0:
      return isDay ? 'clear' : 'clear night';
    case 1:
      return isDay ? 'mainly clear' : 'mainly clear night';
    case 2:
      return 'partly cloudy';
    case 3:
      return 'overcast';
    case 45:
    case 48:
      return 'fog';
    case 51:
    case 53:
      return 'light drizzle';
    case 55:
      return 'drizzle';
    case 56:
    case 57:
      return 'freezing drizzle';
    case 61:
      return 'light rain';
    case 63:
      return 'rain';
    case 65:
      return 'heavy rain';
    case 66:
    case 67:
      return 'freezing rain';
    case 71:
      return 'light snow';
    case 73:
      return 'snow';
    case 75:
      return 'heavy snow';
    case 77:
      return 'snow grains';
    case 80:
      return 'light showers';
    case 81:
      return 'showers';
    case 82:
      return 'violent showers';
    case 85:
    case 86:
      return 'snow showers';
    case 95:
      return 'thunderstorm';
    case 96:
    case 99:
      return 'thunderstorm with hail';
    default:
      return 'unknown';
  }
}

/**
 * A place-holder for when the source could not be reached.
 *
 * `NaN` rather than 0 is deliberate. A model asked "is it raining?" given
 * `precipitationMm: 0` answers "no, it is dry". Given a sentinel that reads as
 * missing data, it says it does not know. Getting this wrong is how a weather
 * tool talks someone into a walk in a storm.
 */
function unknownConditions(): WeatherNow {
  return {
    tempC: Number.NaN,
    feelsLikeC: Number.NaN,
    precipitationMm: Number.NaN,
    precipitation: 'none',
    code: -1,
    summary: 'unknown - weather source unavailable',
    cloudCoverPct: Number.NaN,
    windKmh: Number.NaN,
    windDirDeg: Number.NaN,
    gustKmh: Number.NaN,
    visibilityM: Number.NaN,
    humidityPct: Number.NaN,
    night: false,
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

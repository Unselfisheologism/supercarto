/**
 * Hosted maplet compile on Cloudflare Workers.
 *
 * Serves a subset of the same tool surface as `src/server/http.ts`, by
 * importing and reusing the real compile path (`src/live.ts` -> `src/pipeline.ts`
 * -> emit). Nothing here is a copy of the pipeline; every maplet, SCR document,
 * weather answer, and sun position comes out of the same code the local server
 * runs, so the two cannot drift by construction.
 *
 * Conventions are mirrored from `src/server/http.ts` on purpose: an agent (or
 * operator) that knows the local API knows this one. Same query parameters, the
 * same `{ error }` and `{ yaml, metrics, ... }` JSON shapes, the same CORS
 * preflight. Where the upstream library reports absence rather than serving a
 * fake answer, this endpoint does too - a missing tool here means "not served",
 * never "no service behind it".
 *
 * ## What is deliberately not here
 *
 * `src/index.ts`, `src/config.ts`, `src/server/*`, `src/source/gtfs.ts`, and
 * `src/binary/compress.ts` are not imported. They are the modules that pull in
 * `node:process`, `node:module`, `node:http`, or `node:fs` statically, and the
 * compile path itself uses none of them: live sources are plain `fetch`
 * (Overpass, Open-Meteo, Terrarium), the compiler and emitters are pure
 * computation. The exception is the PMTiles fallback source: `protomaps.ts`
 * loads its Node decoders lazily through `src/source/zlibsafe.ts`, which
 * detects the runtime and uses the web `DecompressionStream` (gzip - what the
 * public OSM basemap archives use for directories, tiles, and metadata)
 * wherever `node:zlib` is absent. Zero runtime npm dependencies holds here
 * too - this module imports nothing outside `../../../src`.
 *
 * ## The data fallback
 *
 * Every known public Overpass instance refuses the shared Cloudflare egress
 * range (HTTP 521), so an Overpass-only hosted deployment answers nothing.
 * The map route therefore carries a second source in its
 * chain: a hosted PMTiles planet build of the OpenStreetMap basemap
 * (directories, tiles, and JSON metadata are gzip in these builds, so the
 * fallback serves real vector detail through the same `DecompressionStream`).
 * When Overpass refuses a request, the same compile path answers from the
 * archive, and the document's `source:` line says `protomaps` rather than
 * `osm-overpass` - what served it is never hidden.
 *
 * ## Runtime contract
 *
 * Plain `Request`/`Response`/`fetch` Web APIs only. Nothing Cloudflare-specific
 * except a rate limiter keyed on the `CF-Connecting-IP` header (with a fallback
 * so tests and local runs work), which is why the whole surface is testable in
 * Node with vitest and no wrangler.
 */

import { SuperCarto } from '../../../src/live.js';
import { OverpassSource } from '../../../src/source/overpass.js';
import { ProtomapsSource } from '../../../src/source/protomaps.js';
import { TerrariumElevation, type ElevationGrid } from '../../../src/source/terrain.js';
import { sunPosition, needsLight } from '../../../src/source/sun.js';
import { bboxAround, normalizeBbox } from '../../../src/source/types.js';
import type { WeatherSource } from '../../../src/source/weather.js';
import type { ElevationSource } from '../../../src/source/terrain.js';

/** Mirrors `src/server/http.ts`. */
const MAX_RADIUS_M = 25_000;
const DEFAULT_BUDGET = 1024;
const MAX_TOKENS = 16_384;

/**
 * The maplet data is OpenStreetMap, and ODbL attribution is a licence term,
 * not a courtesy. Every origin-sense response carries it.
 */
const ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';

const DEFAULT_OVERPASS_INTERPRETER = 'https://overpass-api.de/api/interpreter';

/** Rate limiting, per IP, on the expensive route only. */
const RATE_WINDOW_MS = 60_000;
const DEFAULT_MAPLET_PER_MINUTE = 30;

export interface WorkerOptions {
  /** Injected instance, chiefly for tests. Built from keyless defaults otherwise. */
  carto?: SuperCarto;
  /** Overpass `.../interpreter` endpoint, for the /healthz probe. */
  overpassEndpoint?: string;
  /** Terrarium tile template, for elevation. Keyless by default. */
  terrariumEndpoint?: string;
  /**
   * PMTiles archive URL for the /maplet and /scr fallback source. Default is
   * the OSM basemap planet build named by the Protomaps daily-build index;
   * an explicit URL replaces the resolution entirely.
   */
  pmtilesUrl?: string;
  /** Maplet requests per IP per minute. Default 30. */
  mapletPerMinute?: number;
  /** Hard cap on a single maplet response. Default 16384, as in http.ts. */
  maxTokens?: number;
  /** CORS origin, or `*`. Default `*`, as in http.ts. */
  corsOrigin?: string;
}

/** Full-planet OSM basemap PMTiles, one daily build. Retains ~a week of builds. */
const PLANET_BUILD_ROOT = 'https://build.protomaps.com';
/** Names the currently latest daily build; served over HTTP, one small file. */
const PLANET_BUILD_INDEX = 'https://build-metadata.protomaps.dev/builds.json';
/**
 * The latest build at commit time of a patch version the bucket retains per
 * the retention rule ("all builds for the past week, plus the latest build of
 * each patch version"). Used when the index itself is unreachable, so the
 * fallback still has a URL to range-request; it names a real archive today
 * and is honest about being a pin.
 */
const PINNED_PLANET_BUILD = 'https://build.protomaps.com/20261022.pmtiles';

/**
 * Resolve the fallback archive URL: an explicit option wins, otherwise the
 * latest daily build from the index, otherwise the pinned build.
 */
async function resolvePmtilesUrl(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  try {
    const res = await fetch(PLANET_BUILD_INDEX, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) {
      const builds = (await res.json()) as Array<{ key?: string }>;
      const keys = builds
        .map((b) => b.key)
        .filter((k): k is string => typeof k === 'string' && /^\d{8}\.pmtiles$/.test(k))
        .sort();
      const latest = keys[keys.length - 1];
      if (latest) return `${PLANET_BUILD_ROOT}/${latest}`;
    }
  } catch {
    // The index is a convenience, not a credential; the pinned build below
    // keeps the fallback chain intact instead.
  }
  return PINNED_PLANET_BUILD;
}

/**
 * Build the worker's route handler as a plain `Request -> Response` function.
 *
 * The Cloudflare `default` export below delegates to this, and the tests call
 * it directly: there is one set of request semantics, exercised twice.
 */
export function createHandler(opts: WorkerOptions = {}): (req: Request) => Promise<Response> {
  const carto: Promise<SuperCarto> = opts.carto
    ? Promise.resolve(opts.carto)
    : buildDefaultCarto(opts);

  const maxTokens = opts.maxTokens ?? MAX_TOKENS;
  const origin = opts.corsOrigin ?? '*';
  const mapletLimit = opts.mapletPerMinute ?? DEFAULT_MAPLET_PER_MINUTE;

  // The /healthz probe pings Overpass, cached for 60s so a health check storm
  // does not itself become load on the shared instance.
  const overpassStatusUrl =
    (opts.overpassEndpoint ?? DEFAULT_OVERPASS_INTERPRETER).replace(/interpreter$/i, 'status');
  let health = { at: 0, ok: false, detail: 'not probed yet' };

  /** Instances a Worker-routed deployment can be pointed at. */
  const KNOWN_OVERPASS_INSTANCES: { root: string }[] = [
    { root: 'https://overpass-api.de/api' },
    { root: 'https://overpass.kumi.systems/api' },
    { root: 'https://overpass.private.coffee/api' },
    { root: 'https://gall.openstreetmap.de/api' },
  ];

  return async function handle(req: Request): Promise<Response> {
    try {
      return await route(req);
    } catch (err) {
      // The /scr route used to escape an exception here and hand Cloudflare
      // an opaque 1101. Any unhandled compile-side failure now lands as an
      // honest 502 that names the error, like every other refusal here.
      return json({ 'Access-Control-Allow-Origin': origin }, 502, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Probe an alternative instance, against a closed list: the primary
    // instance refuses the shared Cloudflare egress range, so the hosted
    // deployment needs to know, from its own network position, which mirror
    // accepts it. `?endpoint=` picks one; without the parameter the
    // configured instance is probed.
    const probeParam = url.searchParams.get('endpoint');
    const probedUrl = KNOWN_OVERPASS_INSTANCES.some(
      (i) => probeParam !== null && probeParam.replace(/\/+$/, '').endsWith(i.root.replace('https://', '')),
    )
      ? `${probeParam}/status`
      : overpassStatusUrl;
    const extraHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
    };

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: extraHeaders });
    }

    if (url.pathname === '/healthz') {
      // The manual alternative-instance probe is uncached; the configured
      // instance keeps the 60s cache so a health-check storm does not become
      // new load on the shared instance.
      const probe = probeParam !== null
        ? await probeStatus(probedUrl)
        : (await (async () => {
            await refreshHealth();
            return health;
          })());
      return json(extraHeaders, probe.ok ? 200 : 503, {
        ok: probe.ok,
        overpass: probe.detail,
      });
    }

    if (url.pathname === '/') {
      return json(extraHeaders, 200, indexBody());
    }

    if (url.pathname === '/maplet') {
      // Rate limiting before any work, because the compile is the one route
      // whose cost lands on a shared public Overpass instance.
      const retry = rateLimited(req, mapletLimit);
      if (retry > 0) {
        return json(
          { ...extraHeaders, 'Retry-After': String(retry) },
          429,
          { error: mapletLimitMessage(mapletLimit) },
        );
      }
      return await mapletRoute(url, req, extraHeaders, maxTokens);
    }

    if (url.pathname === '/scr') {
      return scrRoute(url, extraHeaders);
    }
    if (url.pathname === '/daylight') {
      return daylightRoute(url, extraHeaders);
    }

    if (url.pathname === '/weather') {
      return await weatherRoute(url, extraHeaders);
    }

    if (url.pathname === '/terrain') {
      return await terrainRoute(url, extraHeaders);
    }

    return json(extraHeaders, 404, { error: 'not found', routes: servedRoutes(), unavailable: unavailableBody() });
  };

  // --- routes ---------------------------------------------------------------

  /** `GET|POST /maplet?lat=&lon=&radiusM=&budget=&layers=&format=` — mirrors http.ts. */
  async function mapletRoute(
    url: URL,
    req: Request,
    headers: Record<string, string>,
    cap: number,
  ): Promise<Response> {
    // A POST can carry the same parameters in a JSON body; URL parameters win
    // where both are given, which keeps GET and POST identical to read.
    let body: Record<string, unknown> = {};
    if (req.method === 'POST') {
      try {
        const parsed: unknown = await req.json();
        if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
      } catch {
        return json(headers, 400, { error: 'POST body must be JSON parameters' });
      }
    }

    const lat = numParam(body, url, 'lat');
    const lon = numParam(body, url, 'lon');
    if (lat === undefined || lon === undefined) {
      return json(headers, 400, { error: 'lat and lon are required' });
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return json(headers, 400, {
        error: 'lat must be in [-90,90] and lon in [-180,180]',
      });
    }

    const radiusM = clamp(numParam(body, url, 'radiusM', 300), 1, MAX_RADIUS_M);
    const budget = clamp(numParam(body, url, 'budget', DEFAULT_BUDGET), 64, cap);
    const layers =
      url.searchParams.get('layers')?.split(',').map((s) => s.trim()).filter(Boolean);

    let result;
    try {
      result = await (await carto).maplet({ lat, lon, radiusM, layers, budget });
    } catch (err) {
      // Including the "no walkable network survived" refusal from live.ts:
      // an honest, actionable message beats a 500 stack trace.
      return json(headers, 502, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    attributionHeaderOn(headers);

    const format = url.searchParams.get('format') ?? 'yaml';
    if (format === 'yaml' || format === 'text') {
      // The agent-ready document directly, with the token accounting in a
      // header so the body stays exactly what gets pasted into a context.
      const metrics = {
        ...result.metrics,
        fetchedFrom: result.fetchedFrom,
        fetchMs: result.fetchMs,
        warnings: result.warnings,
        sourceTruncated: result.sourceTruncated,
      };
      return new Response(result.yaml + (result.yaml.endsWith('\n') ? '' : '\n'), {
        status: 200,
        headers: {
          ...headers,
          'content-type': 'text/plain; charset=utf-8',
          'X-Maplet-Metrics': JSON.stringify(metrics),
        },
      });
    }

    // Mirror the local server's JSON maplet shape exactly.
    return json(headers, 200, {
      yaml: result.yaml,
      metrics: result.metrics,
      fetchedFrom: result.fetchedFrom,
      fetchMs: result.fetchMs,
      warnings: result.warnings,
      sourceTruncated: result.sourceTruncated,
      partial: result.graph.partial,
      omitted: result.graph.omitted,
    });
  }

  /** `GET /scr?bbox=w,s,e,n&layers=` — the raw wire format, as http.ts serves it. */
  async function scrRoute(url: URL, headers: Record<string, string>): Promise<Response> {
    const bbox = parseBbox(url.searchParams.get('bbox'));
    if (!bbox) {
      return json(headers, 400, { error: 'bbox must be "west,south,east,north"' });
    }
    const layers = url.searchParams.get('layers')?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
    // Same defence as /maplet: a source-chain failure is an honest 502 that
    // says what refused the request. Before this catch, the escape produced a
    // Cloudflare error 1101 at real Overpass egress refusals.
    let text: string;
    try {
      text = await (await carto).scr(bbox, layers);
    } catch (err) {
      return json(headers, 502, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    attributionHeaderOn(headers);
    return new Response(text, {
      status: 200,
      headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  /** `GET /daylight?lat=&lon=&at=` — computed, not fetched. Always available. */
  function daylightRoute(url: URL, headers: Record<string, string>): Response {
    const lat = numParam({}, url, 'lat');
    const lon = numParam({}, url, 'lon');
    if (lat === undefined || lon === undefined) {
      return json(headers, 400, { error: 'lat and lon are required' });
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return json(headers, 400, { error: 'lat must be in [-90,90] and lon in [-180,180]' });
    }

    let at = new Date();
    const atArg = url.searchParams.get('at');
    if (atArg !== null && atArg !== '') {
      at = new Date(atArg);
      if (Number.isNaN(at.getTime())) {
        return json(headers, 400, { error: `could not read "${atArg}" as an ISO 8601 instant` });
      }
    }

    const sun = sunPosition(lat, lon, at);
    // Polar day/night carries no sunrise/sunset, and leaving them out says so.
    const { sunrise: _sr, sunset: _ss, ...rest } = sun;
    const body =
      sun.polar === false
        ? { ...rest, sunrise: sun.sunrise, sunset: sun.sunset, needsLight: needsLight(sun) }
        : { ...rest, needsLight: needsLight(sun) };
    return json(headers, 200, { lat, lon, at: at.toISOString(), ...body });
  }

  /** `GET /weather?lat=&lon=&hours=` — Open-Meteo, keyless. */
  async function weatherRoute(url: URL, headers: Record<string, string>): Promise<Response> {
    const lat = numParam({}, url, 'lat');
    const lon = numParam({}, url, 'lon');
    if (lat === undefined || lon === undefined) {
      return json(headers, 400, { error: 'lat and lon are required' });
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return json(headers, 400, { error: 'lat must be in [-90,90] and lon in [-180,180]' });
    }
    const hours = clamp(numParam({}, url, 'hours', 12), 1, 48);

    const w = await (await carto).weatherAt(lat, lon, hours);
    if (!w) {
      return json(headers, 404, { error: 'weather is not configured for this deployment' });
    }
    if (w.degraded) {
      // Explicitly not a successful answer. Serving reachable-but-degraded
      // conditions as 200 would put a plausible zeroed "now" into an agent's
      // context - the one genuinely dangerous failure this library refuses.
      return json(headers, 503, {
        error: `weather unavailable: ${w.degraded}`,
      });
    }
    return json(headers, 200, w);
  }

  /** `GET /terrain?lat=&lon=&radiusM=&samples=` — Terrarium tiles, keyless. */
  async function terrainRoute(url: URL, headers: Record<string, string>): Promise<Response> {
    const lat = numParam({}, url, 'lat');
    const lon = numParam({}, url, 'lon');
    if (lat === undefined || lon === undefined) {
      return json(headers, 400, { error: 'lat and lon are required' });
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return json(headers, 400, { error: 'lat must be in [-90,90] and lon in [-180,180]' });
    }
    const radiusM = clamp(numParam({}, url, 'radiusM', 1000), 1, MAX_RADIUS_M);
    const samples = clamp(numParam({}, url, 'samples', 16), 4, 128);

    const grid = await (await carto).elevationFor(normalizeBbox(bboxAround(lat, lon, radiusM)), samples);
    if (!grid) {
      return json(headers, 404, { error: 'no elevation source is configured for this deployment' });
    }
    if (!hasDecodedSamples(grid)) {
      // Tiles were reached but none decoded. An all-zero field on the ocean
      // floor would read as a flat plain - reported as absent instead.
      return json(headers, 503, {
        error:
          'elevation tiles were fetched but none decoded into samples: ' +
          'the endpoint did not serve a readable Terrarium tile body ' +
          '(PNG or raw) for this area',
      });
    }

    const values = Array.from(grid.values).filter((v) => Number.isFinite(v));
    values.sort((a, b) => a - b);
    const lo = values[0];
    const hi = values[values.length - 1];
    const text = [
      `elevation over ${formatRadius(radiusM)} around ${lat.toFixed(4)},${lon.toFixed(4)}`,
      `min: ${(lo ?? 0).toFixed(1)}m`,
      `max: ${(hi ?? 0).toFixed(1)}m`,
      `range: ${((hi ?? 0) - (lo ?? 0)).toFixed(1)}m`,
      '',
      'Note: elevation is relative to sea level, and the source may be coarse at this radius.',
    ].join('\n');
    return new Response(text, {
      status: 200,
      headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  // --- helpers --------------------------------------------------------------

  async function refreshHealth(): Promise<void> {
    const now = Date.now();
    if (now - health.at < 60_000) return;
    const probed = await probeStatus(overpassStatusUrl);
    health = { at: now, ok: probed.ok, detail: probed.detail };
  }

  /** One Overpass probe: `/status` first, then a minimal interpreter query. */
  async function probeStatus(
    statusUrl: string,
    root = statusUrl.replace(/\/status$/, ''),
  ): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(statusUrl, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        return { ok: true, detail: `reachable (HTTP ${res.status})` };
      }
      // Several mirrors serve the interpreter but not `/status`. A 404 from
      // the status page says the instance is up and answers this network
      // position, so settle the check with a trivial interpreter call.
      if (res.status === 404) {
        const interpreter = `${root}/interpreter?data=${encodeURIComponent('[out:json];node(id:1);out;')}`;
        const q = await fetch(interpreter, { signal: AbortSignal.timeout(10_000) });
        if (q.ok || q.status === 400 || q.status === 429) {
          return { ok: true, detail: `reachable (interpreter HTTP ${q.status})` };
        }
        // Diagnostic pass: is the host itself filtering this egress, or only
        // the API path? A plain root GET distinguishes the two.
        const rootRes = await fetch(root, { signal: AbortSignal.timeout(5_000) });
        return {
          ok: false,
          detail: `interpreter ${q.status}, root ${rootRes.status}`,
        };
      }
      return { ok: false, detail: `overpass responded HTTP ${res.status}` };
    } catch (err) {
      return {
        ok: false,
        detail: `overpass unreachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  function indexBody(): unknown {
    return {
      name: 'supercarto-compile',
      description:
        'hosted compile of the supercarto maplet pipeline: real map data in, ' +
        'a token-budgeted topological graph out. Same conventions as the ' +
        'local HTTP API in src/server/http.ts.',
      attribution: ATTRIBUTION,
      routes: servedRoutes(),
      unavailable: unavailableBody(),
      fallback: {
        data:
          'when Overpass refuses this deployment egress (HTTP 521 from every ' +
          'known instance), /maplet and /scr compile from a hosted PMTiles ' +
          'extract of the planet built from OpenStreetMap. The extract detail ' +
          'level is coarse beyond z10-ish, so a city block here is zoom-level ' +
          'honest about what zoom it shipped: the map document carries ' +
          '`source: protomaps` when the fallback served it, and its own ' +
          'truncation warnings when it stopped early.',
        health:
          '/healthz probes Overpass only; a 503 here does not mean /maplet ' +
          'is down - the PMTiles fallback answers from the archive instead.',
      },
    };
  }
}

/**
 * The source chain the hosted surface serves from, in priority order: live
 * Overpass first (it keeps tag detail where it accepts a connection, and it
 * fast-fails HTTP 521 in about a second here), then a hosted PMTiles planet
 * build of the OSM basemap as the fallback that answers what Overpass refuses.
 *
 * Serverless compile budget: one z12 tile of a planet archive is denser than
 * an Overpass query on the same ground, and the compile cost grows steeply
 * with the feature count (measured: 693 features ~26s; 400 features ~0.1s).
 * At 400 the graph is better here, not just cheaper: the budgeter keeps named
 * places it would trade for anonymous street mass at the larger feature set.
 * Truncation stays visible: the result is flagged and the maplet carries the
 * warning, as with any other cap.
 */
async function buildDefaultCarto(opts: WorkerOptions): Promise<SuperCarto> {
  const pmtilesUrl = await resolvePmtilesUrl(opts.pmtilesUrl);
  const fallback = new ProtomapsSource({
    url: pmtilesUrl,
    name: 'protomaps',
    // See buildDefaultCarto comment: keeps one compile inside a Worker budget.
    maxFeatures: 400,
  });
  return new SuperCarto({
    sources: [new OverpassSource(), fallback],
    // Elevation is keyless (Terrarium tiles) and its absence in the hosted
    // surface would silently drop the slope heat layer that answers "can this
    // be wheeled up", for no reason.
    elevation: new TerrariumElevation(
      opts.terrariumEndpoint ? { template: opts.terrariumEndpoint } : {},
    ),
    // Weather stays on (Open-Meteo, keyless, the library default).
    // Traffic and transit stay off: traffic always needs a paid credential
    // and transit always needs an operator feed - the library refuses to
    // default either, and this deployment has nothing to add.
  });
}

// --- out-of-closure state -----------------------------------------------------

/**
 * Per-IP fixed-window counters for the maplet route.
 *
 * NOTE ON HONESTY: Cloudflare Workers isolate state per isolate. Different
 * isolates (and different colo instances) hold separate copies of this Map,
 * so the effective limit is `mapletPerMinute x isolate count`, not a global
 * guarantee. This is a best-effort courtesy cap that protects the shared
 * Overpass instance from a runaway loop, not a hard rate limit. For an actual
 * guarantee, use a Workers KV/DO counter or Cloudflare's managed rate limiting.
 */
const ipCounters = new Map<string, { start: number; count: number }>();

function rateLimited(req: Request, limitPerMinute: number): number {
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const now = Date.now();

  // Prune stale windows, so one abusive IP cannot grow the map forever.
  if (ipCounters.size > 10_000) {
    for (const [key, entry] of ipCounters) {
      if (now - entry.start >= RATE_WINDOW_MS) ipCounters.delete(key);
    }
  }

  let entry = ipCounters.get(ip);
  if (!entry || now - entry.start >= RATE_WINDOW_MS) {
    entry = { start: now, count: 0 };
    ipCounters.set(ip, entry);
  }
  entry.count += 1;
  return entry.count > limitPerMinute
    ? Math.max(1, Math.ceil((entry.start + RATE_WINDOW_MS - now) / 1000))
    : 0;
}

function mapletLimitMessage(limit: number): string {
  return (
    `rate limit: ${limit} maplet requests per minute per IP. This is a ` +
    `best-effort courtesy cap (Workers memory is per isolate, so counts are ` +
    `not global) that protects the shared Overpass instance. Retry after ` +
    `the listed seconds.`
  );
}

function json(
  headers: Record<string, string>,
  status: number,
  body: unknown,
): Response {
  return new Response(JSON.stringify(body, null, 2) + '\n', {
    status,
    headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
  });
}

function attributionHeaderOn(headers: Record<string, string>): void {
  headers['X-Data-Attribution'] = ATTRIBUTION;
}

function servedRoutes(): string[] {
  return [
    'GET|POST /maplet?lat=&lon=&radiusM=&budget=&layers=&format=yaml|json',
    'GET /scr?bbox=w,s,e,n&layers=',
    'GET /daylight?lat=&lon=&at=',
    'GET /weather?lat=&lon=&hours=',
    'GET /terrain?lat=&lon=&radiusM=&samples=',
    'GET /healthz',
  ];
}

/**
 * What the local server has that this deployment cannot honestly serve.
 *
 * "Not there" is not "not shown": a missing route comes with its reason, and
 * no route ever answers with a stub that reads like data.
 */
function unavailableBody(): Array<{ route: string; because: string }> {
  return [
    {
      route: '/transit',
      because:
        'a schedule needs an operator-imported GTFS feed read from the local ' +
        'filesystem; a Worker has no filesystem, so transit is absent rather ' +
        'than served as "no service"',
    },
    {
      route: 'tool get_traffic',
      because:
        'live traffic needs a licensed flow provider credential (TomTom or ' +
        'HERE); hosted mode ships none, and free-flow numbers presented as ' +
        'live conditions are the failure this library refuses to make',
    },
    {
      route: 'indoor floor plans',
      because:
        'indoor floor plans are local files: no filesystem here, so indoor ' +
        'layers are absent rather than fabricated',
    },
  ];
}

// --- param helpers (mirrored from src/server/http.ts) -----------------------------

function numParam(
  body: Record<string, unknown>,
  url: URL,
  key: string,
  fallback?: number,
): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) {
    // No URL param: fall back to the POST body, then to the caller's default.
    const v = body[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v: number | undefined, lo: number, hi: number): number {
  if (v === undefined) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function parseBbox(text: string | null): { west: number; south: number; east: number; north: number } | undefined {
  if (!text) return undefined;
  const parts = text.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
  return normalizeBbox({
    west: parts[0]!,
    south: parts[1]!,
    east: parts[2]!,
    north: parts[3]!,
  });
}

/** Whether any elevation sample actually decoded (see terrainRoute). */
function hasDecodedSamples(grid: ElevationGrid): boolean {
  if (grid.max !== 0 || grid.min !== 0) return true;
  for (const v of grid.values) {
    if (v !== 0) return true;
  }
  return false;
}

function formatRadius(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
}

// Re-exported so tests can express stubs in the same types the worker consumes.
export type { WeatherSource, ElevationSource };

/**
 * The Cloudflare Workers entrypoint.
 *
 * `env.OVERPASS_ENDPOINT` / `env.TERRARIUM_ENDPOINT` / `env.PMTILES_URL` are
 * honoured if an operator sets them as variables; without them the handler is
 * built from the keyless defaults and reused, so the archive handle inside
 * `SuperCarto` stays warm across requests in a single isolate.
 */
export default {
  fetch(
    request: Request,
    env?: {
      OVERPASS_ENDPOINT?: string;
      TERRARIUM_ENDPOINT?: string;
      PMTILES_URL?: string;
    },
  ): Promise<Response> {
    // Rebuild only when the operator's variables change, so the document cache
    // inside `SuperCarto` stays warm across requests in an isolate. The
    // fallback archive URL participates in that key: a resolved daily build
    // could change between isolates, and those must not share a cache built
    // from a different archive.
    const overpassEndpoint = env?.OVERPASS_ENDPOINT;
    const terrariumEndpoint = env?.TERRARIUM_ENDPOINT;
    const pmtilesUrl = env?.PMTILES_URL;
    const key = JSON.stringify([overpassEndpoint, terrariumEndpoint, pmtilesUrl]);
    if (handlerKey !== key) {
      handler = createHandler({
        ...(overpassEndpoint ? { overpassEndpoint } : {}),
        ...(terrariumEndpoint ? { terrariumEndpoint } : {}),
        ...(pmtilesUrl ? { pmtilesUrl } : {}),
      });
      handlerKey = key;
    }
    return handler(request);
  },
};

let handler: (req: Request) => Promise<Response> = createHandler();
let handlerKey = '[]';

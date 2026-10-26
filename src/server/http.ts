import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { SuperCarto } from '../live.js';
import { GtfsSource } from '../source/gtfs.js';
import { bboxAround, normalizeBbox, type BboxQuery } from '../source/types.js';
import { fromScr } from '../pipeline.js';
import { encodeDocument } from '../wire/encode.js';

/**
 * HTTP API.
 *
 * Deliberately built on `node:http` with no framework: there are four routes,
 * and a dependency here would be a larger part of the install than the whole
 * library. Swap this for your own framework if you have one; everything it calls
 * is exported.
 */

export interface ApiOptions {
  carto?: SuperCarto;
  /** Hard cap on a single maplet response. Default 16384. */
  maxTokens?: number;
  /** Allowed CORS origin, or `*`. Default `*`. */
  origin?: string;
  /** Dev origins, to narrow CORS when deploying. */
  devOrigins?: string[];
  /**
   * Realtime TripUpdates URL for `?feed=` override queries. Defaults to the
   * SUPERCARTO_GTFS_RT environment at server start. Without it an override
   * query silently answers schedule-only, which is the 0.5.6 bug in a new
   * coat: the join exists but nothing drives it here.
   */
  gtfsRtUrl?: string;
}

const MAX_RADIUS_M = 25_000;
const DEFAULT_BUDGET = 1024;

export class MapApiServer {
  private readonly carto: SuperCarto;
  private readonly maxTokens: number;
  private readonly origin: string;
  private readonly gtfsRtUrl: string | undefined;

  constructor(opts: ApiOptions = {}) {
    this.carto = opts.carto ?? new SuperCarto();
    this.maxTokens = opts.maxTokens ?? 16_384;
    this.origin = opts.origin ?? '*';
    this.gtfsRtUrl = opts.gtfsRtUrl ?? process.env.SUPERCARTO_GTFS_RT;
  }

  /** Build a `node:http` server bound to this API. */
  handler() {
    return createServer((req, res) => {
      this.route(req, res).catch((err: unknown) => {
        this.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    res.setHeader('Access-Control-Allow-Origin', this.origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/health') {
      this.json(res, 200, { ok: true, cacheSize: this.carto.cacheSize });
      return;
    }

    if (url.pathname === '/maplet') {
      await this.maplet(url, res);
      return;
    }

    if (url.pathname === '/scr') {
      await this.scr(url, res);
      return;
    }

    // Offered only when a GTFS feed is configured (or named per request via
    // ?feed=), so the 404 is the honest refusal and no route ever answers with
    // a stub that reads like "no service".
    if (url.pathname === '/transit') {
      await this.transit(url, res);
      return;
    }

    if (url.pathname === '/transit-route') {
      await this.transitRoute(url, res);
      return;
    }

    this.json(res, 404, {
      error: 'not found',
      routes: [
        '/health',
        '/maplet?lat=&lon=&radiusM=&budget=',
        '/scr?bbox=w,s,e,n',
        '/transit?lat=&lon=&radiusM=&budget=',
        '/transit-route?fromLat=&fromLon=&toLat=&toLon=',
      ],
    });
  }

  /** `GET /maplet?lat=&lon=&radiusM=&budget=&layers=` */
  private async maplet(url: URL, res: ServerResponse): Promise<void> {
    const lat = numParam(url, 'lat');
    const lon = numParam(url, 'lon');
    if (lat === undefined || lon === undefined) {
      this.json(res, 400, { error: 'lat and lon are required' });
      return;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      this.json(res, 400, { error: 'lat must be in [-90,90] and lon in [-180,180]' });
      return;
    }

    const radiusM = clamp(numParam(url, 'radiusM', 300), 1, MAX_RADIUS_M);
    const budget = clamp(numParam(url, 'budget', DEFAULT_BUDGET), 64, this.maxTokens);
    const layers = url.searchParams.get('layers')?.split(',').map((s) => s.trim()).filter(Boolean);

    const result = await this.carto.maplet({ lat, lon, radiusM, layers, budget });

    // `format=yaml` returns the agent-ready document directly, which is what a
    // tool-calling agent wants. JSON is for dashboards and debugging.
    const format = url.searchParams.get('format') ?? 'json';
    if (format === 'yaml' || format === 'text') {
      res.writeHead(200, { 'content-type': 'text/yaml; charset=utf-8' });
      res.end(result.yaml);
      return;
    }

    this.json(res, 200, {
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

  /** `GET /scr?bbox=w,s,e,n` - the raw wire format. */
  private async scr(url: URL, res: ServerResponse): Promise<void> {
    const bbox = parseBbox(url.searchParams.get('bbox'));
    if (!bbox) {
      this.json(res, 400, { error: 'bbox must be "west,south,east,north"' });
      return;
    }
    const layers = url.searchParams.get('layers')?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
    const text = await this.carto.scr(bbox, layers);
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(text);
  }

  /**
   * `GET /transit?lat=&lon=&radiusM=&budget=&now=&feed=`
   *
   * The deployment's configured feed serves the request; `feed` is an optional
   * override to a directory or .zip path, cached per path because loading a
   * feed is the expensive part and callers probe repeatedly. Without a feed
   * configured or named, this is a 404 stating why - the same honest refusal
   * the MCP surface makes by simply not advertising the tool.
   */
  private transitFeeds = new Map<string, GtfsSource>();

  private async transit(url: URL, res: ServerResponse): Promise<void> {
    const lat = numParam(url, 'lat');
    const lon = numParam(url, 'lon');
    if (lat === undefined || lon === undefined) {
      this.json(res, 400, { error: 'lat and lon are required' });
      return;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      this.json(res, 400, { error: 'lat must be in [-90,90] and lon in [-180,180]' });
      return;
    }

    const radiusM = clamp(numParam(url, 'radiusM', 400), 1, MAX_RADIUS_M);
    const budget = clamp(numParam(url, 'budget', DEFAULT_BUDGET), 64, this.maxTokens);
    const now = url.searchParams.get('now') ?? undefined;
    const feedPath = url.searchParams.get('feed');

    let result: Awaited<ReturnType<SuperCarto['transitAt']>>;
    try {
      if (feedPath) {
        const source = this.feedSource(feedPath);
        const rt = source.realtime ? await source.realtime(now) : undefined;
        result = source.querySlice({ lat, lon, radiusM, budget, now }, rt);
      } else {
        if (!this.carto.hasTransit) {
          this.json(res, 404, {
            error:
              'no GTFS feed configured for this deployment: set SUPERCARTO_GTFS or pass ?feed=<dir|zip>',
          });
          return;
        }
        result = await this.carto.transitAt({ lat, lon, radiusM, budget, now });
      }
    } catch (err) {
      this.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const format = url.searchParams.get('format') ?? 'json';
    if (format === 'yaml' || format === 'text') {
      res.writeHead(200, { 'content-type': 'text/yaml; charset=utf-8' });
      res.end(result.yaml);
      return;
    }

    this.json(res, 200, {
      yaml: result.yaml,
      tokens: result.tokens,
      budget: result.budget,
      feedName: result.feedName,
      stops: result.stops,
      edges: result.edges,
      omittedStops: result.prunedStops,
    });
  }

  /**
   * `GET /transit-route?fromLat=&fromLon=&toLat=&toLon=&maxWalkM=&budget=&now=[&feed=]`
   *
   * One shared ride line between the two coordinates, same words the MCP
   * tool uses. Realtime rides on exactly the wiring `config.ts` gives the
   * configured feed: the operator's `SUPERCARTO_GTFS_RT` follows `?feed=`
   * overrides, and the fresh overlay is fetched and passed in the same
   * breath - the join-buttressed-elsewhere lesson keeps its shape.
   */
  private async transitRoute(url: URL, res: ServerResponse): Promise<void> {
    const fromLat = numParam(url, 'fromLat');
    const fromLon = numParam(url, 'fromLon');
    const toLat = numParam(url, 'toLat');
    const toLon = numParam(url, 'toLon');
    if ([fromLat, fromLon, toLat, toLon].some((v) => v === undefined)) {
      this.json(res, 400, { error: 'fromLat, fromLon, toLat and toLon are required' });
      return;
    }
    for (const v of [fromLat, toLat]) {
      if (v! < -90 || v! > 90) {
        this.json(res, 400, { error: 'fromLat and toLat must be in [-90,90]' });
        return;
      }
    }
    for (const v of [fromLon, toLon]) {
      if (v! < -180 || v! > 180) {
        this.json(res, 400, { error: 'fromLon and toLon must be in [-180,180]' });
        return;
      }
    }

    const maxWalkM = clamp(numParam(url, 'maxWalkM', 500), 50, 2000);
    const budget = clamp(numParam(url, 'budget', DEFAULT_BUDGET), 64, this.maxTokens);
    const now = url.searchParams.get('now') ?? undefined;
    const feedPath = url.searchParams.get('feed');

    try {
      let result: Awaited<ReturnType<SuperCarto['transitRoute']>>;
      if (feedPath) {
        const source = this.feedSource(feedPath);
        const rt = source.realtime ? await source.realtime(now) : undefined;
        result = source.planTrip!({ from: { lat: fromLat!, lon: fromLon! }, to: { lat: toLat!, lon: toLon! }, maxWalkM, budget, now }, rt);
      } else {
        if (!this.carto.hasTransit) {
          this.json(res, 404, {
            error:
              'no GTFS feed configured for this deployment: set SUPERCARTO_GTFS or pass ?feed=<dir|zip>',
          });
          return;
        }
        result = await this.carto.transitRoute({
          from: { lat: fromLat!, lon: fromLon! },
          to: { lat: toLat!, lon: toLon! },
          maxWalkM,
          budget,
          now,
        });
      }

      const format = url.searchParams.get('format') ?? 'json';
      if (format === 'yaml' || format === 'text') {
        res.writeHead(200, { 'content-type': 'text/yaml; charset=utf-8' });
        res.end(result.yaml);
        return;
      }
      this.json(res, 200, {
        yaml: result.yaml,
        tokens: result.tokens,
        budget: result.budget,
        plans: result.plans,
      });
    } catch (err) {
      this.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * The per-feed source cache, with realtime wired the way the configured
   * feed is: an operator's SUPERCARTO_GTFS_RT follows feed overrides, or an
   * override query would silently answer schedule-only.
   */
  private feedSource(feedPath: string): GtfsSource {
    let source = this.transitFeeds.get(feedPath);
    if (!source) {
      source = new GtfsSource(feedPath, this.gtfsRtUrl ? { url: this.gtfsRtUrl } : undefined);
      this.transitFeeds.set(feedPath, source);
    }
    return source;
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body, null, 2);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(text);
  }
}

/** Start the API server on a port. Returns the server so callers can close it. */
export function startApiServer(
  port = 8787,
  opts: ApiOptions = {},
): ReturnType<MapApiServer['handler']> {
  const server = new MapApiServer(opts).handler();
  server.listen(port, () => {
    // Written to stderr because stdout is the MCP transport.
    process.stderr.write(`supercarto api listening on http://localhost:${port}\n`);
  });
  return server;
}

function numParam(url: URL, key: string, fallback?: number): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v: number | undefined, lo: number, hi: number): number {
  if (v === undefined) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function parseBbox(text: string | null): BboxQuery | undefined {
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

export { fromScr, encodeDocument, bboxAround };
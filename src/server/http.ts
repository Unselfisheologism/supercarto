import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { SuperCarto } from '../live.js';
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
}

const MAX_RADIUS_M = 25_000;
const DEFAULT_BUDGET = 1024;

export class MapApiServer {
  private readonly carto: SuperCarto;
  private readonly maxTokens: number;
  private readonly origin: string;

  constructor(opts: ApiOptions = {}) {
    this.carto = opts.carto ?? new SuperCarto();
    this.maxTokens = opts.maxTokens ?? 16_384;
    this.origin = opts.origin ?? '*';
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

    this.json(res, 404, {
      error: 'not found',
      routes: ['/health', '/maplet?lat=&lon=&radiusM=&budget=', '/scr?bbox=w,s,e,n'],
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
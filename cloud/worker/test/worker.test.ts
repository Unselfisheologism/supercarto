import { afterEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { SuperCarto } from '../../../src/live.js';
import { createHandler } from '../src/worker.js';
import { ProtomapsSource } from '../../../src/source/protomaps.js';
import { decompress } from '../../../src/source/zlibsafe.js';
import { normalizeBbox, bboxAround, plainFetch } from '../../../src/source/types.js';
import type { MapSource, SourceRequest, SourceResult } from '../../../src/source/types.js';
import type { GeoJsonFeature } from '../../../src/ingest/geojson.js';
import type { WeatherResult, WeatherSource } from '../../../src/source/weather.js';
import type { ElevationGrid, ElevationSource } from '../../../src/source/terrain.js';

// ============================================================================
// PMTiles fixture, written from the specifications rather than the reader's
// own output - the same shape test/pmtiles.test.ts builds, but served from
// memory so the fallback source is exercised end to end without a disk.

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

/** Zigzag, then varint. This is MVT's svarint encoding. */
function svarint(n: number): number[] {
  return varint((n << 1) ^ (n >> 31));
}

/** TileID per PMTiles spec 4.1: a cumulative Hilbert position, not a raster index. */
function hilbert(z: number, x: number, y: number): number {
  let rx: number, ry: number, d = 0;
  for (let s = 1 << (z - 1); s > 0; s >>= 1) {
    rx = (x & s) > 0 ? 1 : 0;
    ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const t = x;
      x = y;
      y = t;
    }
  }
  return d + ((4 ** z - 1) / 3);
}

const EXTENT = 4096;

/** One MVT 2.1 tile: one layer, one linestring with a tagged property. */
function buildMvt(nameIdx = 0): Uint8Array {
  const layerName = 'roads';
  const roadName = ['Market St', '5th St', 'Mandela Pkwy'][nameIdx] ?? 'Road';
  const points: [number, number][] = [
    [100, 200], [2000, 200], [2000, 3000], [3000, 3500],
  ];

  const geom: number[] = [];
  let x = 0;
  let y = 0;
  geom.push(...varint(1 | (points.length << 3)));
  for (const [px, py] of points) {
    geom.push(...svarint(px - x), ...svarint(py - y));
    x = px;
    y = py;
  }
  geom.push(...varint(2 | (1 << 3)), ...svarint(500), ...svarint(0));

  const tags = [0, 0];
  const feat = [
    ...varint((1 << 3) | 0), ...varint(42 + nameIdx),
    ...varint((2 << 3) | 2), ...varint(tags.length), ...tags,
    ...varint((3 << 3) | 0), ...varint(2),
    ...varint((4 << 3) | 2), ...varint(geom.length), ...geom,
  ];

  const str = (field: number, s: string): number[] => [
    ...varint((field << 3) | 2),
    ...varint(s.length),
    ...[...s].map((c) => c.charCodeAt(0)),
  ];

  const valueBody = str(1, roadName);
  const layer = [
    ...str(1, layerName),
    ...varint((2 << 3) | 2), ...varint(feat.length), ...feat,
    ...str(3, 'name'),
    ...varint((4 << 3) | 2), ...varint(valueBody.length), ...valueBody,
    ...varint((5 << 3) | 0), ...varint(EXTENT),
    ...varint((15 << 3) | 0), ...varint(2),
  ];
  return Uint8Array.from([...varint((3 << 3) | 2), ...varint(layer.length), ...layer]);
}

/**
 * A gzip PMTiles v3 archive holding the given SF z12 tiles, each carrying one
 * named road. Directories stay uncompressed (compression code 0), tiles are
 * gzip (code 2) - the Web-decompression path is what the real archive uses.
 */
function buildArchiveBytes(tiles: { x: number; y: number }[]): Uint8Array {
  const HLEN = 127;
  const z = 12;
  const payloads = tiles.map((t, i) => Buffer.from(gzipSync(buildMvt(i))));

  const entries = tiles
    .map((t, i) => ({
      tileId: hilbert(z, t.x, t.y),
      runLength: 1,
      length: payloads[i]!.length,
      offset: payloads.slice(0, i).reduce((a, p) => a + p.length, 0),
    }))
    .sort((a, b) => a.tileId - b.tileId);

  const dir: number[] = [...varint(entries.length)];
  let lastId = 0;
  for (const e of entries) {
    dir.push(...varint(e.tileId - lastId));
    lastId = e.tileId;
  }
  for (const e of entries) dir.push(...varint(e.runLength));
  for (const e of entries) dir.push(...varint(e.length));
  let nextByte = 0;
  entries.forEach((e, i) => {
    dir.push(...varint(i > 0 && e.offset === nextByte ? 0 : e.offset + 1));
    nextByte = e.offset + e.length;
  });

  const rootDir = Buffer.from(dir);
  const data = Buffer.concat(payloads);
  const header = Buffer.alloc(HLEN);
  header.write('PMTiles', 0, 'ascii');
  header.writeUInt8(3, 7);
  const p64 = (o: number, v: number) => header.writeBigUInt64LE(BigInt(v), o);
  p64(8, HLEN);
  p64(16, rootDir.length);
  p64(24, 0);
  p64(32, 0);
  p64(40, 0);
  p64(48, 0);
  p64(56, HLEN + rootDir.length);
  p64(64, data.length);
  p64(72, tiles.length);
  p64(80, entries.length);
  p64(88, payloads.length);
  header.writeUInt8(1, 96);
  header.writeUInt8(0, 97);
  header.writeUInt8(2, 98);
  header.writeUInt8(1, 99);
  header.writeUInt8(z, 100);
  header.writeUInt8(z, 101);
  header.writeUInt8(z, 102);
  header.writeFloatLE(0.5, 105);

  return new Uint8Array(Buffer.concat([header, rootDir, data]));
}

/** A fetch over an in-memory archive, honouring the same Range reads. */
function archiveFetch(bytes: Uint8Array): typeof fetch {
  return async (_input, init) => {
    const range = new Headers(init?.headers).get('range') ?? '';
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    const start = m ? Number(m[1]) : 0;
    const end = m ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1;
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` },
    });
  };
}

const SF_TILES = [
  { x: 655, y: 1583 },
  { x: 654, y: 1583 },
  { x: 655, y: 1584 },
];
const SF_BBOX = { west: -122.4268, south: 37.7702, east: -122.4014, north: 37.7799 };

/** A source that is configured but cannot serve anything, like egress-refused Overpass. */
class RefusingSource implements MapSource {
  readonly name = 'overpass-refused';
  readonly description = 'refuse everything, like HTTP 521 egress';
  async available() { return true; }
  async fetch(): Promise<SourceResult> {
    throw new Error('Upstream error: HTTP 521');
  }
}

const SF_FEATURES: GeoJsonFeature[] = [
  {
    type: 'Feature', id: 1,
    properties: { highway: 'primary', name: 'Market St' },
    geometry: { type: 'LineString', coordinates: [[-122.4194, 37.7749], [-122.4150, 37.7749]] },
  },
  {
    type: 'Feature', id: 2,
    properties: { highway: 'secondary', name: '5th St' },
    geometry: { type: 'LineString', coordinates: [[-122.4150, 37.7749], [-122.4150, 37.7780]] },
  },
  {
    type: 'Feature', id: 3,
    properties: { amenity: 'cafe', name: 'Blue Bottle' },
    geometry: { type: 'Point', coordinates: [-122.4170, 37.7750] },
  },
  {
    type: 'Feature', id: 4,
    properties: { railway: 'subway_entrance', name: 'Powell Station' },
    geometry: { type: 'Point', coordinates: [-122.4150, 37.7748] },
  },
];

class StubSource implements MapSource {
  readonly name = 'stub';
  readonly description = 'test fixture';
  async available() { return true; }
  async fetch(_req: SourceRequest): Promise<SourceResult> {
    return {
      features: SF_FEATURES,
      source: this.name,
      truncated: false,
      elapsedMs: 1,
      warnings: [],
    };
  }
}

const HEALTHY_WEATHER: WeatherResult = {
  now: {
    tempC: 14, feelsLikeC: 12, precipitationMm: 0, precipitation: 'none',
    code: 1, summary: 'mainly clear', cloudCoverPct: 20,
    windKmh: 11, windDirDeg: 270, gustKmh: 14, visibilityM: 20000, humidityPct: 62, night: false,
  },
  hourly: [],
  daily: [],
  lat: 37.775, lon: -122.4194,
  gridOffsetM: 400,
  source: 'stub-weather',
};

function weatherStub(result: WeatherResult = HEALTHY_WEATHER): WeatherSource {
  return {
    name: 'stub-weather',
    async fetch() { return result; },
  };
}

function elevationStub(): ElevationSource {
  return {
    name: 'stub-terrain',
    async fetch(bbox): Promise<ElevationGrid> {
      const res = 16;
      const values = Float32Array.from({ length: res * res }, (_, i) => 5 + (i % res));
      return {
        bbox: normalizeBbox(bbox),
        width: res,
        height: res,
        values,
        min: Math.min(...values),
        max: Math.max(...values),
      };
    },
  };
}

function handlerWith(opts: Partial<Parameters<typeof createHandler>[0]> = {}) {
  return createHandler({
    carto: new SuperCarto({
      // The stub source answers in a millisecond from a fixture, so the harness
      // never touches Overpass; keyless defaults are exercised through the
      // healthz probe's injected fetch instead.
      sources: [new StubSource()],
      weather: weatherStub(),
      elevation: elevationStub(),
    }),
    // A small limit keeps the 429 test fast and visible; the default stays 30.
    mapletPerMinute: 3,
    ...opts,
  });
}

/** Same-shape request builder the real runtime would deliver. */
function req(path: string, ip = 'test-ip'): Request {
  return new Request(`https://worker.test${path}`, {
    headers: { 'cf-connecting-ip': ip },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- tests ---------------------------------------------------------------

describe('hosted worker surface', () => {
  it('index lists the served routes and honestly names what is absent', async () => {
    const res = await handlerWith()(req('/'));
    expect(res.status).toBe(200);
    const body = await res.json() as { routes: string[]; unavailable: Array<{ route: string; because: string }>; attribution: string };

    const served = body.routes.join('\n');
    for (const path of ['/maplet', '/scr', '/daylight', '/weather', '/terrain', '/healthz']) {
      expect(served).toContain(path);
    }

    const gone = body.unavailable.map((u) => u.route);
    expect(gone).toContain('/transit');
    expect(gone).toContain('tool get_traffic');
    // The honesty copy: a missing thing states why, in the Local-server voice.
    const transit = body.unavailable.find((u) => u.route === '/transit');
    expect(transit?.because).toMatch(/filesystem/);
    expect(body.attribution).toContain('ODbL');
  });

  it('maplet serves the YAML document as text with token metrics in a header', async () => {
    const res = await handlerWith()(req('/maplet?lat=37.775&lon=-122.4194&budget=512', 'maplet-happy'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('X-Data-Attribution')).toBe('© OpenStreetMap contributors (ODbL)');

    const metrics = JSON.parse(res.headers.get('X-Maplet-Metrics') ?? '{}') as { budget: number; nodes: number; edges: number; tokens: number };
    expect(metrics.budget).toBe(512);
    expect(metrics.nodes).toBeGreaterThan(0);
    expect(metrics.tokens).toBeLessThanOrEqual(512);

    const yaml = await res.text();
    expect(yaml.length).toBeGreaterThan(0);
    expect(yaml).toContain('Blue Bottle');
  });

  it('maplet format=json mirrors the local server body exactly', async () => {
    const res = await handlerWith()(req('/maplet?lat=37.775&lon=-122.4194&format=json', 'maplet-json'));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ['fetchedFrom', 'fetchMs', 'metrics', 'omitted', 'partial', 'sourceTruncated', 'warnings', 'yaml'].sort(),
    );
    expect(body.partial).toBe(false);
    expect((body.metrics as { budget: number }).budget).toBe(1024);
  });

  it('maplet rejects a missing coordinate with the local server message', async () => {
    const res = await handlerWith()(req('/maplet?lat=37.775', 'maplet-bad'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'lat and lon are required' });
  });

  it('rate limit: 429 with Retry-After after the per-IP threshold', async () => {
    const handler = handlerWith();
    const ip = 'flood-ip';
    // The handler was built with mapletPerMinute: 3; the fourth call must refuse.
    let last: Response | undefined;
    for (let i = 0; i < 4; i++) {
      last = await handler(req(
        `/maplet?lat=${(37.7 + i * 0.001).toFixed(4)}&lon=-122.4194`, ip,
      ));
    }
    expect(last?.status).toBe(429);
    const retry = last?.headers.get('Retry-After');
    expect(retry).toMatch(/^\d+$/);
    expect(Number(retry)).toBeGreaterThan(0);
    const body = await last?.json() as { error: string };
    expect(body.error).toContain('best-effort');
    expect(body.error).toContain('per isolate');
    // Other IPs are unaffected: the counter is per IP.
    const other = await handler(req('/maplet?lat=37.775&lon=-122.4194', 'other-ip'));
    expect(other.status).toBe(200);
  });

  it('daylight computes sun state without any network or credential', async () => {
    const res = await handlerWith()(req('/daylight?lat=37.775&lon=-122.4194&at=2025-06-21T20:00:00Z'));
    expect(res.status).toBe(200);
    const body = await res.json() as { twilight: string; elevationDeg: number; needsLight: boolean; polar: unknown };
    expect(body.twilight).toBe('day');
    expect(body.elevationDeg).toBeGreaterThan(0);
    expect(body.needsLight).toBe(false);
    expect(body.polar).toBe(false);
  });

  it('daylight reports polar night honestly, with no invented sunrise', async () => {
    const res = await handlerWith()(req('/daylight?lat=89&lon=0&at=2025-12-21T12:00:00Z'));
    const body = await res.json() as { polar: string; sunrise?: string; sunset?: string };
    expect(body.polar).toBe('night');
    expect(body.sunrise).toBeUndefined();
    expect(body.sunset).toBeUndefined();
  });

  it('weather serves keyless forecast data, and refuses a degraded source instead of serving zeros', async () => {
    const ok = await handlerWith()(req('/weather?lat=37.775&lon=-122.4194'));
    expect(ok.status).toBe(200);
    const body = await ok.json() as { now: { summary: string }; source: string };
    expect(body.source).toBe('stub-weather');
    expect(body.now.summary).toBe('mainly clear');

    const degraded = handlerWith({
      carto: new SuperCarto({
        sources: [new StubSource()],
        weather: weatherStub({ ...HEALTHY_WEATHER, degraded: 'open-meteo unreachable' }),
        elevation: elevationStub(),
      }),
    })(req('/weather?lat=37.775&lon=-122.4194'));
    expect((await degraded).status).toBe(503);
  });

  it('healthz is 200 only when the injected Overpass probe succeeds, result cached', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('26-27', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const handler = handlerWith();

    const ok = await handler(req('/healthz'));
    expect(ok.status).toBe(200);
    const calls = fetchMock.mock.calls.length;

    // Within the 60s cache window the answer is reused, not re-probed.
    const cached = await handler(req('/healthz'));
    expect(cached.status).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(calls);

    // A fresh cache (new handler does not reset the shared cache by design;
    // unstub and check the failure path on a distinct probe by waiting is too
    // slow, so instead assert the 503 shape directly with a refused probe.)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 61_000));
    const failed = await handler(req('/healthz'));
    vi.useRealTimers();
    expect(failed.status).toBe(503);
    expect(((await failed.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('unknown routes give a 404 that names what is served and what is not', async () => {
    const res = await handlerWith()(req('/transit?lat=37.775&lon=-122.4194'));
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; routes: string[]; unavailable: Array<{ route: string }> };
    expect(body.error).toBe('not found');
    expect(body.routes.join(' ')).toContain('/maplet');
    expect(body.unavailable.map((u) => u.route)).toContain('/transit');
  });
});

describe('source-failure honesty', () => {
  /** Every configured source refuses: the chain falls through to "no source". */
  function handlerWithRefused() {
    return createHandler({
      carto: new SuperCarto({ sources: [new RefusingSource()], weather: false }),
    });
  }

  it('/scr answers 502 with the error, never an escaping 1101', async () => {
    // Before the dispatch-level catch, the exception escaped /scr and the
    // Worker runtime surfaced an opaque Cloudflare error 1101 (HTTP 500) -
    // a status that says nothing about what actually happened.
    const res = await handlerWithRefused()(req('/scr?bbox=-122.42,37.77,-122.41,37.78'));
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('no source could serve the request');
    expect(body.error).toContain('HTTP 521');
  });

  it('/maplet keeps its QoS shape when every source refuses', async () => {
    const res = await handlerWithRefused()(req('/maplet?lat=37.775&lon=-122.4194'));
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('no source could serve the request');
  });

  it('an unknown route never becomes an unhandled throw either', async () => {
    // The dispatch-level catch is the safety net; exercising it on a route
    // whose handler itself would throw (a malformed URL) keeps the guarantee
    // honest rather than per-endpoint luck.
    const res = await handlerWithRefused()(new Request('https://worker.test/' + '%ffffff'));
    expect([400, 404, 502]).toContain(res.status);
  });
});

describe('the hosted PMTiles fallback', () => {
  /** A chain where Overpass refuses and the archive answers. */
  function handlerWithFallback(source: ProtomapsSource) {
    return createHandler({
      carto: new SuperCarto({
        sources: [new RefusingSource(), source],
        weather: false,
      }),
    });
  }

  it('/maplet compiles from the archive when Overpass refuses, and says so', async () => {
    const bytes = buildArchiveBytes(SF_TILES);
    const src = new ProtomapsSource({
      // A URL, not a path: the worker fallback is always remote.
      url: 'https://archive.test/hosted.pmtiles',
      name: 'protomaps',
      fetchImpl: archiveFetch(bytes),
      maxFeatures: 400,
    });
    const res = await handlerWithFallback(src)(req('/maplet?lat=37.775&lon=-122.4194&budget=512', 'pmtiles-happy'));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Data-Attribution')).toContain('OpenStreetMap contributors');

    const metrics = JSON.parse(res.headers.get('X-Maplet-Metrics') ?? '{}') as {
      fetchedFrom: string; nodes: number; edges: number; tokens: number;
    };
    expect(metrics.fetchedFrom).toBe('protomaps');
    expect(metrics.nodes).toBeGreaterThan(0);
    expect(metrics.edges).toBeGreaterThan(0);

    const yaml = await res.text();
    expect(yaml).toContain('source: protomaps');
    expect(yaml).toContain('map:');
    expect(yaml).toMatch(/\nedges:\n/);
    expect(yaml).toMatch(/\nnodes:\n/);
  });

  it('an archive the deployment cannot reach leaves the chain honest at 502', async () => {
    // available() false (bad archive) means the fallback is skipped without
    // pretending; the refusal the operator sees names the failure.
    const src = new ProtomapsSource({
      url: 'https://archive.test/not-a-archive.pmtiles',
      fetchImpl: async () => new Response('Not Found', { status: 404 }),
    });
    const res = await handlerWithFallback(src)(req('/maplet?lat=37.775&lon=-122.4194', 'pmtiles-down'));
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('no source could serve');
  });

  it('gzip tile bytes decode through the non-Node web path', async () => {
    // Workerd has no node:zlib; zlibsafe falls back to DecompressionStream.
    // Hiding `process` for one call is how a Node test exercises that path.
    const original = globalThis.process;
    // @ts-expect-error - deliberately simulating the Worker runtime
    globalThis.process = undefined;
    try {
      const gz = Buffer.from(gzipSync(Buffer.from([1, 2, 3, 4, 5, 6, 7])));
      const out = await decompress(new Uint8Array(gz), 2, 'tile');
      expect([...out]).toEqual([1, 2, 3, 4, 5, 6, 7]);

      // Workerd has no brotli decoder either; the error says where brotli
      // works instead of returning compressed bytes as data.
      await expect(decompress(new Uint8Array([1]), 3, 'metadata'))
        .rejects.toThrow(/brotli, which needs Node's zlib/);

      // zstd is refused with the version that carries it, matching the
      // Node-side error text.
      await expect(decompress(new Uint8Array([1]), 4, 'tile'))
        .rejects.toThrow(/zstd, which needs Node 22.15 or later/);
    } finally {
      globalThis.process = original;
    }
  });

  it('the source-level feature cap truncates visibly, not silently', async () => {
    const bytes = buildArchiveBytes(SF_TILES);
    const src = new ProtomapsSource({
      url: 'https://archive.test/hosted.pmtiles',
      name: 'protomaps',
      fetchImpl: archiveFetch(bytes),
      maxFeatures: 1,
    });
    const res = await src.fetch({ bbox: SF_BBOX, layers: [], maxFeatures: 500 });
    expect(res.truncated).toBe(true);
    expect(res.features.length).toBe(1);
    const joined = res.warnings.join(' ');
    expect(joined).toMatch(/stopped at the 1 feature cap/);
  });
});

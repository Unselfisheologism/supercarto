import { afterEach, describe, expect, it, vi } from 'vitest';
import { SuperCarto } from '../../../src/live.js';
import { createHandler } from '../src/worker.js';
import { normalizeBbox, bboxAround } from '../../../src/source/types.js';
import type { MapSource, SourceRequest, SourceResult } from '../../../src/source/types.js';
import type { GeoJsonFeature } from '../../../src/ingest/geojson.js';
import type { WeatherResult, WeatherSource } from '../../../src/source/weather.js';
import type { ElevationGrid, ElevationSource } from '../../../src/source/terrain.js';

// --- stubs -------------------------------------------------------------------

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

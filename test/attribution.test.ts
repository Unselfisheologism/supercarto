import { describe, expect, it } from 'vitest';
import { SuperCarto, type MapSource, type SourceRequest, type SourceResult } from '../src/index.js';
import { defineTools, type McpTool } from '../src/server/mcp.js';
import { MapApiServer, ATTRIBUTION } from '../src/server/http.js';
import type { GeoJsonFeature } from '../src/ingest/geojson.js';
import type {
  WeatherSource,
  WeatherResult,
} from '../src/source/weather.js';
import type { AirQualitySource, AirQualityResult } from '../src/source/air.js';

/**
 * Attribution is a licence term, not a courtesy.
 *
 * The maplet data is OpenStreetMap under ODbL; the weather and air data is
 * Open-Meteo under CC BY 4.0, which mandates attribution in its own right.
 * These tests pin the contract at both surfaces so it cannot silently drift:
 *
 *  - REST: the `X-Data-Attribution` header rides on every response - data,
 *    health, and the 404 route list alike - and the JSON bodies state it in
 *    the payload, so a reader of the body alone still sees it.
 *  - MCP: the attribution rides at the transport level, which keeps the
 *    compiler's YAML byte-identical to the Python port.
 *
 * A tool whose answer carries no third-party data carries no line: daylight is
 * arithmetic, and `get_traffic` already names its provider in `source:`.
 */

const SF_FEATURES: GeoJsonFeature[] = [
  {
    type: 'Feature', id: 1,
    properties: { highway: 'primary', name: 'Market St' },
    geometry: { type: 'LineString', coordinates: [[-122.4194, 37.7749], [-122.4150, 37.7749]] },
  },
  {
    type: 'Feature', id: 2,
    properties: { amenity: 'cafe', name: 'Blue Bottle' },
    geometry: { type: 'Point', coordinates: [-122.417, 37.7750] },
  },
];

class StubSource implements MapSource {
  readonly name = 'stub';
  readonly description = 'test fixture';
  async available() { return true; }
  async fetch(_req: SourceRequest): Promise<SourceResult> {
    return { features: SF_FEATURES, source: this.name, truncated: false, elapsedMs: 1, warnings: [] };
  }
}

function weatherResult(source: string): WeatherResult {
  return {
    now: {
      tempC: 22.7, feelsLikeC: 26.9, precipitationMm: 0, precipitation: 'none',
      code: 0, summary: 'clear night', cloudCoverPct: 0, windKmh: 4.3,
      windDirDeg: 180, gustKmh: 4.9, visibilityM: 20000, humidityPct: 60,
      night: true,
    },
    hourly: [
      { at: '2026-01-01T13:00:00Z', tempC: 22.7, precipitationMm: 0, precipitation: 'none', windKmh: 4.3, code: 0 },
    ],
    daily: [
      { date: '2026-01-01', tempMaxC: 24, tempMinC: 18, precipitationMm: 0, precipitationProbPct: 0, windKmh: 4, code: 0 },
    ],
    lat: 35.68, lon: 139.76, gridOffsetM: 400, source,
  };
}

function airResult(source: string): AirQualityResult {
  return {
    now: {
      europeanAqi: 62, usAqi: 65, pm25UgM3: 28.1, pm10UgM3: 29.7,
      ozoneUgM3: 0, no2UgM3: 0, so2UgM3: 0, coUgM3: 0,
    },
    hourly: [
      { at: '2026-01-01T08:00:00Z', europeanAqi: 74, usAqi: 77, pm25UgM3: 33.4, pm10UgM3: 35 },
    ],
    lat: 35.68, lon: 139.76, gridOffsetM: 800, source,
  };
}

const stubCarto = (weather?: WeatherSource, air?: AirQualitySource) =>
  new SuperCarto({
    sources: [new StubSource()],
    weather: weather ?? false,
    air: air ?? false,
    heat: false,
  });

function toolOf(carto: SuperCarto, name: string): McpTool | undefined {
  return defineTools(carto, 8192).find((t) => t.name === name);
}

const ODBL = '© OpenStreetMap contributors (ODbL)';
const OPEN_METEO_CC = 'Open-Meteo.com (CC BY 4.0)';

describe('attribution on the MCP surface', () => {
  it('get_maplet names ODbL in the header block, without touching the YAML body', async () => {
    const tool = toolOf(stubCarto(), 'get_maplet');
    const out = await tool!.handler({ lat: 37.7749, lon: -122.4194 });
    const lines = out.content[0]!.text.split('\n');
    const yamlStart = lines.indexOf('');
    expect(lines.slice(0, yamlStart).some((l) => l.startsWith('#') && l.includes(ODBL))).toBe(true);
    // The emitted document itself is untouched: attribution is transport-level.
    expect(lines.slice(yamlStart).some((l) => l.includes(ODBL))).toBe(false);
  });

  it('search_places names ODbL', async () => {
    const tool = toolOf(stubCarto(), 'search_places');
    const out = await tool!.handler({ lat: 37.7749, lon: -122.4194, query: 'bottle' });
    expect(out.content[0]!.text).toContain(ODBL);
  });

  it('search_places names ODbL even when nothing matches - the answer still cost a fetch', async () => {
    const tool = toolOf(stubCarto(), 'search_places');
    const out = await tool!.handler({ lat: 37.7749, lon: -122.4194, query: 'dragon teahouse' });
    expect(out.content[0]!.text).toContain(ODBL);
  });

  it('get_weather names Open-Meteo under its CC BY 4.0 term', async () => {
    const carto = stubCarto({ name: 'open-meteo', fetch: async () => weatherResult('open-meteo') });
    const tool = toolOf(carto, 'get_weather');
    const out = await tool!.handler({ lat: 35.68, lon: 139.76 });
    expect(out.content[0]!.text).toContain(OPEN_METEO_CC);
  });

  it('get_weather names a custom source by its own name and invents no licence for it', async () => {
    const carto = stubCarto({
      name: 'forecast-by-acme',
      fetch: async () => weatherResult('forecast-by-acme'),
    });
    const tool = toolOf(carto, 'get_weather');
    const out = await tool!.handler({ lat: 35.68, lon: 139.76 });
    const body = out.content[0]!.text;
    expect(body).toContain('weather data by forecast-by-acme');
    expect(body).not.toContain(OPEN_METEO_CC);
  });

  it('get_air names Open-Meteo under its CC BY 4.0 term', async () => {
    const carto = stubCarto(undefined, {
      name: 'open-meteo-air',
      fetch: async () => airResult('open-meteo-air'),
    });
    const tool = toolOf(carto, 'get_air');
    const out = await tool!.handler({ lat: 35.68, lon: 139.76 });
    expect(out.content[0]!.text).toContain(OPEN_METEO_CC);
  });

  it('get_daylight carries no attribution, because arithmetic borrowed nothing', async () => {
    const tool = toolOf(stubCarto(), 'get_daylight');
    const out = await tool!.handler({ lat: 35.68, lon: 139.76 });
    expect(out.content[0]!.text).not.toContain(ODBL);
    expect(out.content[0]!.text).not.toContain('Open-Meteo');
  });
});

describe('attribution on the REST surface', () => {
  it('the header rides on every response: data, health, and the 404 route list', async () => {
    const api = new MapApiServer({ carto: stubCarto() });
    const server = api.handler();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      for (const path of [
        `/maplet?lat=37.7749&lon=-122.4194&budget=512`,
        `/health`,
        `/no-such-route`,
      ]) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`);
        expect(res.status).toBe(path === '/no-such-route' ? 404 : 200);
        expect(res.headers.get('X-Data-Attribution')).toBe(ATTRIBUTION);
        const body = (await res.json()) as { attribution?: string };
        expect(body.attribution).toBe(ATTRIBUTION);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('the yaml format carries the header too', async () => {
    const api = new MapApiServer({ carto: stubCarto() });
    const server = api.handler();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/maplet?lat=37.7749&lon=-122.4194&budget=512&format=yaml`,
      );
      expect(res.headers.get('X-Data-Attribution')).toBe(ATTRIBUTION);
      const yaml = await res.text();
      // Same rule as MCP: the document stays the document.
      expect(yaml).not.toContain(ODBL);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

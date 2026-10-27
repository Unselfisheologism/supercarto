import { describe, expect, it } from 'vitest';
import {
  OpenMeteoAir,
  describeEuropeanAqi,
  describeUsAqi,
  elevatedGases,
} from '../src/index.js';
import { TOOL_CATALOG, advertisedTools, allToolNames, offersTool } from '../src/toolcatalog.js';
import type { AirQualityResult } from '../src/source/air.js';

// --- fixtures ---------------------------------------------------------------

/**
 * A canned body in exactly the shape the Open-Meteo air endpoint returns.
 * Fields the caller should treat as missing are null, mirroring the source
 * behaviour at region edges.
 */
const BODY = {
  latitude: 35.700005,
  longitude: 139.80002,
  current: {
    time: '2026-10-27T07:00',
    european_aqi: 62,
    us_aqi: 65,
    pm10: 29.7,
    pm2_5: 28.1,
    carbon_monoxide: 267.0,
    nitrogen_dioxide: 63.5,
    sulphur_dioxide: 48.1,
    ozone: 29.0,
  },
  hourly: {
    time: ['2026-10-27T07:00', '2026-10-27T08:00', '2026-10-27T09:00'],
    european_aqi: [62, 74, 55],
    us_aqi: [65, 78, 57],
    pm2_5: [28.1, 33.4, 21.2],
    pm10: [29.7, 34.9, 23.3],
  },
};

function airWith(overrides: Partial<typeof BODY> = {}): OpenMeteoAir {
  return new OpenMeteoAir({ fetchImpl: async () => new Response(JSON.stringify({ ...BODY, ...overrides }), { status: 200 }) });
}

function expectResult(res: AirQualityResult, _msg?: string): void {
  expect(res.degraded).toBeUndefined();
}

// --- bands ------------------------------------------------------------------

describe('AQI banding', () => {
  it('walks every European band boundary', () => {
    expect(describeEuropeanAqi(0)).toBe('good');
    expect(describeEuropeanAqi(20)).toBe('good');
    expect(describeEuropeanAqi(21)).toBe('fair');
    expect(describeEuropeanAqi(40)).toBe('fair');
    expect(describeEuropeanAqi(41)).toBe('moderate');
    expect(describeEuropeanAqi(60)).toBe('moderate');
    expect(describeEuropeanAqi(61)).toBe('poor');
    expect(describeEuropeanAqi(80)).toBe('poor');
    expect(describeEuropeanAqi(81)).toBe('very poor');
    expect(describeEuropeanAqi(100)).toBe('very poor');
    expect(describeEuropeanAqi(101)).toBe('extremely poor');
  });

  it('walks every US band boundary', () => {
    expect(describeUsAqi(50)).toBe('good');
    expect(describeUsAqi(51)).toBe('moderate');
    expect(describeUsAqi(100)).toBe('moderate');
    expect(describeUsAqi(101)).toBe('unhealthy for sensitive');
    expect(describeUsAqi(200)).toBe('unhealthy');
    expect(describeUsAqi(201)).toBe('very unhealthy');
    expect(describeUsAqi(301)).toBe('hazardous');
  });

  it('calls a missing reading unknown, never good', () => {
    expect(describeEuropeanAqi(Number.NaN)).toBe('unknown');
    expect(describeUsAqi(Number.NaN)).toBe('unknown');
  });
});

// --- gases ------------------------------------------------------------------

describe('elevated gas selection', () => {
  it('names only gases above their good bound', () => {
    const n = {
      no2UgM3: 63.5, // above 50: named
      ozoneUgM3: 29.0, // below 100: omitted
      so2UgM3: 48.1, // below 100: omitted
      coUgM3: 267.0, // below 4000: omitted
    };
    const gases = elevatedGases(n as never);
    expect(gases).toEqual(['NO2 63.5']);
  });

  it('never names a gas whose reading is missing', () => {
    // A null from the source arrives as NaN; naming it would be inventing a
    // reading, omitting it is the honest state.
    const n = { no2UgM3: Number.NaN, ozoneUgM3: Number.NaN, so2UgM3: Number.NaN, coUgM3: Number.NaN };
    expect(elevatedGases(n as never)).toEqual([]);
  });
});

// --- source -----------------------------------------------------------------

describe('OpenMeteoAir', () => {
  it('requests exactly the deliberate field list', async () => {
    let requested = '';
    const src = new OpenMeteoAir({
      fetchImpl: (async (url: string | URL | Request) => {
        requested = String(url);
        return new Response(JSON.stringify(BODY), { status: 200 });
      }) as typeof fetch,
    });
    const res = await src.fetch(35.6833, 139.762, 24);
    expectResult(res);
    expect(requested).toContain('air-quality-api.open-meteo.com');
    const decoded = decodeURIComponent(requested);
    expect(decoded).toContain('current=european_aqi,us_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone');
    expect(decoded).toContain('hourly=european_aqi,us_aqi,pm2_5,pm10');

    expect(res.now.europeanAqi).toBe(62);
    expect(res.now.usAqi).toBe(65);
    expect(res.now.pm25UgM3).toBe(28.1);
    expect(res.hourly).toHaveLength(3);
    // Hourly is trimmed to start at the current hour, not replay last night.
    expect(res.hourly[0]!.at).toBe('2026-10-27T07:00:00Z');
    // The CAMS grid snap is carrying in the result: the caller must be able to
    // say how far the sample was taken from where the person stands.
    expect(res.gridOffsetM).toBeGreaterThan(0);
  });

  it('turns a null gap into NaN rather than clean air', async () => {
    const gap = structuredClone(BODY) as typeof BODY;
    // Every numeric field nulls out; only the timestamp survives.
    gap.current = {
      time: '2026-10-27T07:00',
      european_aqi: 62,
      us_aqi: 65,
      pm10: null,
      pm2_5: null,
      carbon_monoxide: null,
      nitrogen_dioxide: null,
      sulphur_dioxide: null,
      ozone: null,
    } as unknown as typeof gap.current;
    const src = airWith(gap as never);
    const res = await src.fetch(35.68, 139.76);
    expectResult(res);
    expect(res.now.pm25UgM3).toBeNaN();
    expect(res.now.pm10UgM3).toBeNaN();
    expect(elevatedGases(res.now)).toEqual([]);
  });

  it('degrades to an explicit unknown when the source cannot be reached', async () => {
    const src = new OpenMeteoAir({
      fetchImpl: (async () => new Response('gateway down', { status: 502 })) as typeof fetch,
    });
    const res = await src.fetch(35.68, 139.76);
    expect(res.degraded).toContain('502');
    expect(res.now.europeanAqi).toBeNaN();
    expect(res.hourly).toEqual([]);
  });
});

// --- catalogue --------------------------------------------------------------

describe('get_air in the tool catalogue', () => {
  it('is in the catalogue and advertised when air is enabled', () => {
    expect(allToolNames()).toContain('get_air');
    expect(advertisedTools({ elevation: true, weather: true, air: true, traffic: true, transit: true })).toContain(
      'get_air(lat,lon,hours)',
    );
    expect(offersTool('get_air', { air: true })).toBe(true);
  });

  it('is withheld when the deployment opts out', () => {
    // Same rule as weather: an operator who disables it must see the tool
    // disappear rather than answer calls with an "unconfigured" error.
    const lines = advertisedTools({ elevation: true, weather: true, air: false, traffic: true, transit: true });
    expect(lines).not.toContain('get_air(lat,lon,hours)');
  });

  it('does not have to be registered separately in the MCP surface to exist', () => {
    for (const t of TOOL_CATALOG) expect(t.signature).toMatch(/^get_[a-z_]+\(|^(localize|route|search_places|expand_feature)\(/);
  });
});

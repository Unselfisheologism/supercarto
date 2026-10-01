import { describe, expect, it } from 'vitest';
import {
  HereFlow,
  OpenMeteoWeather,
  TomTomFlow,
  TrafficRouter,
  levelForRatio,
  OsrmRouter,
  type TrafficSource,
} from '../src/index.js';

/**
 * Weather and traffic.
 *
 * These two layers exist for the same reason and are tested for the same
 * property: an agent is acting for a person who is standing outside, so a
 * plausible-looking wrong number is worse than an admitted gap. Most of what
 * follows checks that the "I do not know" path is real and reachable, because
 * that path is the one a unit test almost never exercises and the one that
 * matters most in production.
 */

describe('levelForRatio', () => {
  it('grades congestion the way road agencies do', () => {
    // Thresholds follow level-of-service grading rather than round numbers,
    // because that is where a person's intuition is already calibrated.
    expect(levelForRatio(1)).toBe('free');
    expect(levelForRatio(0.85)).toBe('light');
    expect(levelForRatio(0.65)).toBe('moderate');
    expect(levelForRatio(0.45)).toBe('heavy');
    expect(levelForRatio(0.2)).toBe('severe');
  });

  it('does not report a road as faster than its own speed limit', () => {
    // A mis-tagged road reporting 130 on a 100 limit must not read as free flow
    // plus extra; it is clamped, so the agent sees congestion rather than
    // enthusiasm.
    expect(levelForRatio(1.3)).toBe('free');
  });
});

describe('OpenMeteoWeather', () => {
  const okBody = {
    latitude: 35.7,
    longitude: 139.76,
    current: {
      time: '2026-10-01T12:00',
      temperature_2m: 23.2,
      apparent_temperature: 26.9,
      precipitation: 0,
      rain: 0,
      showers: 0,
      snowfall: 0,
      weather_code: 0,
      cloud_cover: 10,
      wind_speed_10m: 4.3,
      wind_direction_10m: 180,
      wind_gusts_10m: 6,
      visibility: 20000,
      relative_humidity_2m: 70,
      is_day: 0,
    },
    hourly: {
      time: ['2026-10-01T12:00', '2026-10-01T13:00', '2026-10-01T14:00'],
      temperature_2m: [23.2, 22.7, 22.1],
      precipitation: [0, 0.4, 2.1],
      rain: [0, 0.4, 2.1],
      showers: [0, 0, 0],
      snowfall: [0, 0, 0],
      weather_code: [0, 61, 65],
      wind_speed_10m: [4.3, 3.5, 3.1],
    },
    daily: {
      time: ['2026-10-01'],
      weather_code: [61],
      temperature_2m_max: [29.5],
      temperature_2m_min: [20.6],
      precipitation_sum: [1.1],
      precipitation_probability_max: [82],
      wind_speed_10m_max: [9],
    },
  };

  function stubFetch(body: unknown, ok = true): typeof fetch {
    const impl = async () => {
      if (ok) return { ok: true, status: 200, json: async () => body };
      return { ok: false, status: 503, statusText: 'unavailable' };
    };
    return impl as unknown as typeof fetch;
  }

  it('reads conditions and forecasts at a coordinate', async () => {
    const src = new OpenMeteoWeather({ fetchImpl: stubFetch(okBody) });
    const w = await src.fetch(35.6833, 139.762, 6);

    expect(w.degraded).toBeUndefined();
    expect(w.now.tempC).toBeCloseTo(23.2);
    expect(w.now.feelsLikeC).toBeCloseTo(26.9);
    expect(w.now.night).toBe(true);
    expect(w.now.summary).toBe('clear night');
    expect(w.hourly).toHaveLength(3);
    expect(w.hourly[1]!.precipitation).toBe('rain');
  });

  it('starts the forecast at now rather than replaying the morning', async () => {
    // An agent asking about "now" wants forward-looking hours. Returning the
    // whole day from midnight would show it rain that has already stopped.
    const src = new OpenMeteoWeather({ fetchImpl: stubFetch(okBody) });
    const w = await src.fetch(35.6833, 139.762, 12);
    expect(w.hourly[0]!.at).toBe('2026-10-01T12:00:00Z');
  });

  it('distinguishes snow from rain, because it changes what a person does', async () => {
    // "Take an umbrella" and "wear a coat, the ground will be white" are
    // different instructions. Collapsing both into "precipitation" throws away
    // the part the agent acts on.
    const snowy = {
      ...okBody,
      current: { ...okBody.current, snowfall: 2.5, rain: 0, precipitation: 2.5 },
    };
    const src = new OpenMeteoWeather({ fetchImpl: stubFetch(snowy) });
    expect((await src.fetch(0, 0)).now.precipitation).toBe('snow');

    const sleet = {
      ...okBody,
      current: { ...okBody.current, snowfall: 1, rain: 1, precipitation: 2 },
    };
    const s2 = new OpenMeteoWeather({ fetchImpl: stubFetch(sleet) });
    expect((await s2.fetch(0, 0)).now.precipitation).toBe('sleet');
  });

  it('flags hail on a thunderstorm even with almost no rain total', async () => {
    // Code 96 is a thunderstorm with hail, and the rain total can be small
    // enough that a threshold on millimetres alone would miss it.
    const hail = {
      ...okBody,
      current: { ...okBody.current, weather_code: 96, precipitation: 0.4, rain: 0.4 },
    };
    const src = new OpenMeteoWeather({ fetchImpl: stubFetch(hail) });
    expect((await src.fetch(0, 0)).now.precipitation).toBe('hail');
    expect((await src.fetch(0, 0)).now.summary).toContain('hail');
  });

  it('reports NaN rather than zero when the source is unreachable', async () => {
    // The single most dangerous failure available here: an agent handed
    // precipitationMm 0 concludes it is dry and tells someone to cycle into a
    // storm. NaN renders as `unknown`, which it will report as uncertainty.
    const src = new OpenMeteoWeather({ fetchImpl: stubFetch({}, false) });
    const w = await src.fetch(35.68, 139.76);

    expect(w.degraded).toMatch(/503/);
    expect(Number.isNaN(w.now.precipitationMm)).toBe(true);
    expect(Number.isNaN(w.now.tempC)).toBe(true);
    expect(w.now.summary).toContain('unknown');
  });

  it('survives a throw rather than propagating it', async () => {
    const src = new OpenMeteoWeather({
      fetchImpl: (async () => {
        throw new Error('socket hang up');
      }) as typeof fetch,
    });
    const w = await src.fetch(0, 0);
    expect(w.degraded).toMatch(/socket hang up/);
    expect(w.hourly).toEqual([]);
  });

  it('reports how far the forecast grid is from the requested point', async () => {
    // Weather models run on a grid, and "here" is not where the model is. An
    // agent in a valley told about the hilltop grid cell will give bad advice.
    const src = new OpenMeteoWeather({ fetchImpl: stubFetch(okBody) });
    const w = await src.fetch(35.5, 139.5, 3);
    expect(w.gridOffsetM).toBeGreaterThan(1000);
  });
});

describe('TrafficRouter', () => {
  const summary = {
    durationS: 600,
    roads: ['Mission St'],
    geometry: [
      [-122.42, 37.77],
      [-122.41, 37.78],
    ] as [number, number][],
  };

  const stubRouter = {
    name: 'stub',
    route: async () => ({
      route: {
        id: 1,
        mode: 'drive' as const,
        dist: 1000,
        time: summary.durationS,
        steps: [{ n: 1, instruction: 'head north', dist: 1000, turn: 'Mission St' }],
      },
      geometry: summary.geometry,
      source: 'stub',
    }),
  };

  it('reports free flow and says so when no provider has a key', async () => {
    const r = new TrafficRouter(stubRouter, [new TomTomFlow({ apiKey: '' })]);
    const res = await r.route({
      from: { lat: 37.77, lon: -122.42 },
      to: { lat: 37.78, lon: -122.41 },
    });

    expect(res.freeFlowOnly).toBe(true);
    expect(res.durationS).toBe(summary.durationS);
    expect(res.delayS).toBe(0);
    expect(res.unavailable).toMatch(/TOMTOM_API_KEY/);
  });

  it('scales duration by the congestion actually observed', async () => {
    const flow: TrafficSource = {
      name: 'stub',
      configured: () => true,
      flow: async () => ({
        source: 'stub',
        segments: [
          { road: 'Mission St', level: 'moderate', ratio: 0.6, speedKmh: 24, freeFlowKmh: 40 },
          { road: 'Van Ness', level: 'severe', ratio: 0.2, speedKmh: 8, freeFlowKmh: 40 },
        ],
      }),
    };
    const r = new TrafficRouter(stubRouter, [flow]);
    const res = await r.route({
      from: { lat: 37.77, lon: -122.42 },
      to: { lat: 37.78, lon: -122.41 },
    });

    expect(res.freeFlowOnly).toBe(false);
    // Mean ratio 0.4, so the journey is 2.5x its free-flow duration.
    expect(res.durationS).toBe(1500);
    expect(res.delayS).toBe(900);
    // The mean is what a journey feels; the worst segment is what makes someone
    // late, and the agent needs both.
    expect(res.worstLevel).toBe('severe');
    expect(res.segments).toHaveLength(2);
  });

  it('falls back to free flow when the provider is broken', async () => {
    const broken: TrafficSource = {
      name: 'broken',
      configured: () => true,
      flow: async () => {
        throw new Error('provider 502');
      },
    };
    const r = new TrafficRouter(stubRouter, [broken]);
    const res = await r.route({
      from: { lat: 37.77, lon: -122.42 },
      to: { lat: 37.78, lon: -122.41 },
    });
    expect(res.freeFlowOnly).toBe(true);
    expect(res.durationS).toBe(summary.durationS);
  });

  it('tries providers in order and takes the first that answers', async () => {
    const dead: TrafficSource = {
      name: 'dead',
      configured: () => true,
      flow: async () => undefined,
    };
    const live: TrafficSource = {
      name: 'live',
      configured: () => true,
      flow: async () => ({
        source: 'live',
        segments: [{ road: 'A', level: 'free', ratio: 1 }],
      }),
    };
    const r = new TrafficRouter(stubRouter, [dead, live]);
    const res = await r.route({
      from: { lat: 37.77, lon: -122.42 },
      to: { lat: 37.78, lon: -122.41 },
    });
    expect(res.source).toBe('live');
    expect(res.freeFlowOnly).toBe(false);
  });

  it('reports hasFlow false when no provider is configured', async () => {
    // This is what keeps `get_traffic` out of the tool list. Advertising a tool
    // that can only return a free-flow number invites an agent to quote it as
    // live.
    const r = new TrafficRouter(new OsrmRouter(), [new TomTomFlow({ apiKey: '' })]);
    expect(r.hasFlow).toBe(false);

    const withKey = new TrafficRouter(new OsrmRouter(), [new TomTomFlow({ apiKey: 'k' })]);
    expect(withKey.hasFlow).toBe(true);
  });
});

describe('TomTomFlow', () => {
  it('is unconfigured without a key', () => {
    expect(new TomTomFlow({ apiKey: '' }).configured()).toBe(false);
    expect(new TomTomFlow({ apiKey: 'x' }).configured()).toBe(true);
  });

  it('decodes a flow response into segments', async () => {
    const calls: string[] = [];
    const src = new TomTomFlow({
      apiKey: 'k',
      fetchImpl: (async (url: string) => {
        calls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            flows: [
              {
                roadName: 'Mission St',
                flows: [
                  { currentSpeed: 12, freeFlowSpeed: 40, confidence: 'high' },
                  { currentSpeed: 36, freeFlowSpeed: 40, confidence: 'low' },
                ],
              },
            ],
          }),
        };
      }) as unknown as typeof fetch,
    });

    const res = await src.flow(
      { from: { lat: 37.77, lon: -122.42 }, to: { lat: 37.78, lon: -122.41 } },
      { durationS: 600, roads: [], geometry: [[-122.42, 37.77], [-122.41, 37.78]] },
    );

    expect(res?.segments).toHaveLength(2);
    expect(res?.segments[0]!.level).toBe('severe');
    // 36 of 40 km/h is 90% of free flow, which is the top of the `free` band:
    // a road at its own speed limit is not congested, however busy it looks.
    expect(res?.segments[1]!.level).toBe('free');
    expect(res?.segments[1]!.ratio).toBeCloseTo(0.9);
    // A low-confidence sample is flagged so an agent can hedge rather than
    // present a marginal reading as settled.
    expect(res?.segments[1]!.stale).toBe(true);
    expect(calls[0]).toContain('flowinformation');
  });
});

describe('HereFlow', () => {
  it('sends longitude first, which is the opposite of TomTom', async () => {
    // Getting this wrong silently returns congestion for the wrong hemisphere,
    // so the ordering is asserted rather than assumed.
    let seen = '';
    const src = new HereFlow({
      apiKey: 'k',
      fetchImpl: (async (url: string) => {
        seen = url;
        return { ok: true, status: 200, json: async () => ({ currentFlow: [] }) };
      }) as unknown as typeof fetch,
    });

    await src.flow(
      { from: { lat: 37.77, lon: -122.42 }, to: { lat: 37.78, lon: -122.41 } },
      { durationS: 600, roads: [], geometry: [] },
    );

    expect(seen).toContain('-122.42000;37.77000');
  });

  it('ignores samples with no usable speed', async () => {
    const src = new HereFlow({
      apiKey: 'k',
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          currentFlow: [
            { location: { roadName: 'X' } },
            { location: { currentSpeed: 20, freeFlowSpeed: 40 } },
          ],
        }),
      })) as unknown as typeof fetch,
    });

    const res = await src.flow(
      { from: { lat: 0, lon: 0 }, to: { lat: 0.01, lon: 0.01 } },
      { durationS: 60, roads: [], geometry: [] },
    );
    expect(res?.segments).toHaveLength(1);
  });
});

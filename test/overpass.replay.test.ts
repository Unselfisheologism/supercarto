/**
 * Offline replay of recorded upstream misbehaviour.
 *
 * Each test here reproduces something that actually happened against the public
 * Overpass instance. They run in milliseconds, need no network, and do not take
 * anything from a shared public server.
 */

import { describe, expect, it } from 'vitest';
import { OverpassSource } from '../src/source/overpass.js';
import {
  FIXTURE_BBOX,
  REQUIRED_FIXTURES,
  fixtureFetch,
  loadFixture,
  rawFetch,
} from './fixtures/overpass.js';

/** Skips the whole suite rather than passing vacuously if captures are missing. */
const missing = REQUIRED_FIXTURES.filter((n) => !loadFixture(n));
const describeIfFixtures = missing.length === 0 ? describe : describe.skip;

if (missing.length > 0) {
  // Loud on purpose: a green run with no fixtures would be a false reassurance.
console.warn(
      '[overpass fixtures] missing ' + missing.join(', ') +
      ' - run `npx tsx scratch/capture.ts` to capture. Offline replay suite is skipped.',
    );
}

type FeatureLike = { geometry?: { type: string } | null };

/**
 * Slack the adapter allows, in degrees.
 *
 * Mirrors `dropImplausible`: a feature that runs off the edge of the request is
 * legitimate, so a maplet is not expected to clip everything to the exact box.
 */
const TOLERANCE = 0.002;

function countWays(res: { features: FeatureLike[] }): number {
  return res.features.filter((f) => f.geometry?.type === 'LineString').length;
}

describeIfFixtures('Overpass replay: recorded upstream responses', () => {
  it('finds the corruption in the corrupt fixture, so the fixture is meaningful', () => {
    // Guards against a fixture that was recaptured after the instance recovered.
    // If this fails, every corrupt-data test below is testing nothing.
    const fx = loadFixture('london-corrupt')!;
    const lats = fx.elements
      .filter((e) => typeof e.lat === 'number')
      .map((e) => e.lat as number);
    expect(lats.length).toBeGreaterThan(0);
    // Served latitude is ~5.5 for a London box that should be ~51.5, and a
    // minority of responses leak through at plausible-but-wrong latitudes.
    const inBox = lats.filter((l) => l >= 51.5 && l <= 51.52).length;
    expect(inBox).toBe(0);
    expect(lats.filter((l) => l < 10).length).toBeGreaterThan(100);
  });

  it('finds the corruption in the large San Francisco fixture too', () => {
    // Same guard for the other corrupt capture: its way geometry sits at ~37.21
    // while the box is at ~37.78. If a recapture ever produces healthy data,
    // this fails and the tests below would be asserting against nothing.
    const fx = loadFixture('sf-large-1')!;
    const wayPts = fx.elements
      .filter((e) => Array.isArray(e.geometry))
      .flatMap((e) => e.geometry as Array<{ lat: number }>);
    expect(wayPts.length).toBeGreaterThan(0);
    const wrong = wayPts.filter((p) => p.lat < 37.5).length;
    expect(wrong).toBeGreaterThan(0);
    expect(wayPts.filter((p) => p.lat >= 37.769 && p.lat <= 37.79).length).toBe(0);
  });

  it('refuses to serve a corrupt region as if it were a real map', async () => {
    // The bug this pins: London came back as `nodes: 0, edges: 0`, an empty
    // map for one of the densest cities on earth, with no error at all.
    const src = new OverpassSource({ fetchImpl: fixtureFetch('london-corrupt'), maxAttempts: 1 });
    await expect(
      src.fetch({ bbox: FIXTURE_BBOX.london, layers: [], maxFeatures: 20_000 }),
    ).rejects.toThrow(/outside the requested area/);
  });

  it('names the corrupt coordinates in the error, so the cause is diagnosable', async () => {
    const src = new OverpassSource({ fetchImpl: fixtureFetch('london-corrupt'), maxAttempts: 1 });
    await expect(
      src.fetch({ bbox: FIXTURE_BBOX.london, layers: [], maxFeatures: 20_000 }),
    ).rejects.toThrow(/lat=/);
  });

  it('does not report an empty map for a large box served corruptly', async () => {
    // The specific San Francisco failure: 2,320 picnic tables and toilets, zero
    // streets. Points from a region can survive while way geometry is corrupt,
    // so the result looked plausible but had no roads in it at all.
    const src = new OverpassSource({ fetchImpl: fixtureFetch('sf-large-1'), maxAttempts: 1 });
    const res = await src.fetch({ bbox: FIXTURE_BBOX.sfLarge, layers: [], maxFeatures: 20_000 });
    // Whatever survives must be genuinely inside the box, which for way
    // geometry means none of the corrupt ~37.21 vertices came through.
    let checked = 0;
    for (const f of res.features) {
      if (f.geometry?.type !== 'LineString') continue;
      checked++;
      for (const [, lat] of coords(f.geometry)) {
        expect(lat).toBeGreaterThanOrEqual(37.769);
        expect(lat).toBeLessThanOrEqual(37.79);
      }
    }
    // A map with zero streets is the failure being guarded against; if the
    // adapter drops every corrupt way, the answer must be an error, not a map.
    if (checked === 0) {
      expect(res.features.length === 0 || res.warnings.length > 0).toBe(true);
    }
  });

  it('recovers streets for a large box by retrying smaller', async () => {
    // The fix that made San Francisco usable: ask again over a tighter box, and
    // the instance answers correctly. Uses the good fixture to stand in for the
    // smaller retry, since the whole point is that a smaller box works.
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      const fx = loadFixture(calls === 1 ? 'sf-large-1' : 'sf-small')!;
      return new Response(JSON.stringify({ elements: fx.elements }), { status: 200 });
    }) as unknown as typeof fetch;

    const src = new OverpassSource({ fetchImpl, maxAttempts: 4 });
    const res = await src.fetch({ bbox: FIXTURE_BBOX.sfLarge, layers: [], maxFeatures: 20_000 });
    expect(calls).toBeGreaterThan(1);
    expect(countWays(res)).toBeGreaterThan(0);
  });

  it('serves the healthy fixture as a normal map', async () => {
    // The control: a good response must still produce a usable map, with the
    // corrupting coordinates filtered out rather than passed through.
    const src = new OverpassSource({ fetchImpl: fixtureFetch('sf-small'), maxAttempts: 1 });
    const res = await src.fetch({ bbox: FIXTURE_BBOX.sfSmall, layers: [], maxFeatures: 20_000 });
    expect(res.features.length).toBeGreaterThan(0);
    // Every emitted point is genuinely inside the requested box, allowing the
    // small tolerance that admits a feature which merely leaves the request.
    for (const f of res.features) {
      for (const [, lat] of coords(f.geometry)) {
        expect(lat).toBeGreaterThanOrEqual(37.773 - TOLERANCE);
        expect(lat).toBeLessThanOrEqual(37.777 + TOLERANCE);
      }
    }
  });

  it('replays a 504 without leaking licence boilerplate as the cause', async () => {
    // The real 504 body opens with OpenStreetMap attribution. Surfacing that as
    // the explanation for a timeout is useless.
    const html = `<html><body>
      <p>The data included in this document is from www.openstreetmap.org.</p>
      <p><strong>Error</strong>: runtime error: open64: 0 Success Dispatcher_Client::request_read_and_idx::timeout</p>
    </body></html>`;
    const src = new OverpassSource({ fetchImpl: rawFetch(html, 504), maxAttempts: 1 });
    await expect(
      src.fetch({ bbox: FIXTURE_BBOX.sfSmall, layers: [], maxFeatures: 100 }),
    ).rejects.toThrow(/Dispatcher_Client::request_read_and_idx::timeout/);
  });

it('keeps the real streets that depend on the majority rule', async () => {
    // The majority rule exists for a case a hand-written fixture can only
    // approximate: a real road from a real capture that is mostly inside the
    // requested box with a corrupt vertex. The unit test builds that shape by
    // hand; this one pins the specific ways it happens to, so the rule cannot
    // be quietly reverted to "every vertex must be in range".
    //
    // Measured against the capture: of 939 ways, 865 are wholly outside, 69
    // wholly inside, and exactly 3 are mixed. Those 3 are kept only because of
    // the majority rule. Reverting it to unanimity leaves this suite green
    // unless they are asserted by name.
    const MIXED_ONLY = ['8916934', '8917174', '111089307'];

    const src = new OverpassSource({ fetchImpl: fixtureFetch('sf-small'), maxAttempts: 1 });
    const res = await src.fetch({ bbox: FIXTURE_BBOX.sfSmall, layers: [], maxFeatures: 20_000 });

    const keptIds = new Set(
      res.features
        .filter((f) => f.geometry?.type === 'LineString')
        .map((f) => String(f.id)),
    );
    for (const id of MIXED_ONLY) {
      expect(keptIds.has(id), `way ${id} should survive: mostly inside, one corrupt vertex`).toBe(true);
    }
    // And the corrupt vertex itself must not be carried into the graph.
    for (const f of res.features) {
      if (f.geometry?.type !== 'LineString') continue;
      for (const [, lat] of coords(f.geometry)) {
        expect(lat).toBeGreaterThanOrEqual(37.773 - TOLERANCE);
        expect(lat).toBeLessThanOrEqual(37.777 + TOLERANCE);
      }
    }
  });

  it('serves an earlier result when later attempts hit a busy server', async () => {
    // Observed live: a request that got a usable map, then hit a busy server on
    // every retry, used to throw the map away and report "exhausted retries".
    // The first response is the large corrupt fixture, which triggers a shrink
    // retry; every retry then fails, so the loop can never improve on it.
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls > 1) {
        return new Response('busy', { status: 504, statusText: 'Gateway Timeout' });
      }
      const fx = loadFixture('sf-large-1')!;
      return new Response(JSON.stringify({ elements: fx.elements }), { status: 200 });
    }) as unknown as typeof fetch;

    const src = new OverpassSource({ fetchImpl, maxAttempts: 3 });
    const res = await src.fetch({ bbox: FIXTURE_BBOX.sfLarge, layers: [], maxFeatures: 20_000 });
    expect(calls).toBeGreaterThan(1);
    expect(res.warnings.join(' ')).toMatch(/best result obtained/);
  });
});

/** Every coordinate in a geometry, tolerating null. */
function coords(geom: { type: string; coordinates?: unknown } | null): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!geom) return out;
  const walk = (v: unknown): void => {
    if (Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number') {
      out.push([v[0], v[1]]);
      return;
    }
    if (Array.isArray(v)) for (const x of v) walk(x);
  };
  walk(geom.coordinates);
  return out;
}
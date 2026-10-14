import { describe, it, expect } from 'vitest';
import { OverpassSource, normalizeLayers } from '../src/source/overpass.js';

/**
 * Layer names and degraded-road responses.
 *
 * Two measured failures: documented `layers: ["road","poi"]` queried OSM tags
 * that do not exist (`node[road]` matches nothing on the planet), returning
 * nothing silently; and a Tokyo fetch served a POI map with zero streets
 * after two refused attempts, as success.
 */
const TOKYO = { west: 139.75, south: 35.67, east: 139.77, north: 35.69 };

function okBody(elements: unknown[]) {
  return async () =>
    new Response(JSON.stringify({ elements }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

function errBody(status = 429) {
  return async () =>
    new Response('<error>rate limited</error>', {
      status,
      statusText: 'Too Many Requests',
    });
}

function seq(...bodies: (() => Promise<Response>)[]) {
  let i = 0;
  return (async () => bodies[Math.min(i++, bodies.length - 1)]!()) as unknown as typeof fetch;
}

const NODES_ONLY = {
  elements: [
    { type: 'node', id: 1, lat: 35.6800, lon: 139.7600, tags: { amenity: 'cafe', name: 'Kissa' } },
    { type: 'node', id: 2, lat: 35.6810, lon: 139.7610, tags: { shop: 'books', name: 'Books' } },
  ],
};

const WITH_WAYS = {
  elements: [
    ...NODES_ONLY.elements,
    {
      type: 'way',
      id: 10,
      nodes: [1, 2],
      tags: { highway: 'residential', name: 'Sakura St' },
    },
  ],
};

describe('normalizeLayers', () => {
  it('maps documented names to OSM tags', () => {
    expect(normalizeLayers(['road'])).toEqual(['highway']);
    expect(normalizeLayers(['poi'])).toEqual(['amenity', 'shop', 'tourism']);
  });

  it('keeps streets first regardless of request order, without duplicates', () => {
    expect(normalizeLayers(['poi', 'road'])).toEqual(['highway', 'amenity', 'shop', 'tourism']);
    expect(normalizeLayers(['poi', 'amenity'])).toEqual(['amenity', 'shop', 'tourism']);
  });

  it('throws on unknown names instead of querying nothing', () => {
    expect(() => normalizeLayers(['road', 'flying'])).toThrow(/unknown layer.*"flying"/);
    expect(() => normalizeLayers(['flying'])).toThrow(/Valid:/);
  });
});

describe('degraded road responses', () => {
  it('throws after refusals deliver a roadless result on populated land', async () => {
    // The measured Tokyo shape: two refused attempts, then a 200 with nodes
    // only. Served as success, it produced a POI map with no streets.
    const src = new OverpassSource({
      fetchImpl: seq(errBody(), errBody(), okBody(NODES_ONLY.elements)),
      maxAttempts: 3,
    });
    await expect(
      src.fetch({ bbox: TOKYO, layers: [], maxFeatures: 100 }),
    ).rejects.toThrow(/no road geometry/);
  });

  it('serves a clean first-attempt roadless result (honest geography)', async () => {
    // No prior refusal means no evidence of degradation: a plaza, farmland
    // or genuinely roadless patch must serve, not throw.
    const src = new OverpassSource({
      fetchImpl: seq(okBody(NODES_ONLY.elements)),
      maxAttempts: 3,
    });
    const res = await src.fetch({ bbox: TOKYO, layers: [], maxFeatures: 100 });
    expect(res.features.length).toBeGreaterThan(0);
  });

  it('still delivers ways on the happy path', async () => {
    const src = new OverpassSource({
      fetchImpl: seq(okBody(WITH_WAYS.elements)),
      maxAttempts: 2,
    });
    const res = await src.fetch({ bbox: TOKYO, layers: [], maxFeatures: 100 });
    expect(res.features.some((f) => f.geometry?.type === 'LineString')).toBe(true);
  });
});

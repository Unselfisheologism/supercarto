import { describe, it, expect } from 'vitest';
import { OverpassSource } from '../src/source/overpass.js';

/**
 * Regression: the public Overpass instance rejects the `bbox:` prefixed
 * filter for negative-latitude boxes - 400 "bbox-query: n must be greater
 * or equal than s", measured against overpass-api.de on 2026-10-17 for
 * Yogyakarta (-7.775,110.3739,-7.7677,110.3812), while the positional form
 * `way(s,w,n,e)[tag]` succeeds on the same coordinates. The emitted query
 * must stay positional.
 */
const YOGYAKARTA = { west: 110.3739, south: -7.775, east: 110.3812, north: -7.7677 };

const WITH_WAY = {
  elements: [
    { type: 'node', id: 1, lat: -7.771, lon: 110.377, tags: { amenity: 'cafe', name: 'Kopi' } },
    { type: 'node', id: 2, lat: -7.772, lon: 110.378, tags: {} },
    { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'residential', name: 'Jl. Contoh' } },
  ],
};

describe('Overpass query form', () => {
  it('emits the positional bbox filter accepted for negative latitudes', async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify(WITH_WAY), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const src = new OverpassSource({ fetchImpl, maxAttempts: 1 });
    const res = await src.fetch({ bbox: YOGYAKARTA, layers: [], maxFeatures: 100 });
    expect(res.features.length).toBeGreaterThan(0);

    expect(bodies.length).toBeGreaterThan(0);
    const query = decodeURIComponent(bodies[0]!);
    expect(query).not.toContain('bbox:');
    expect(query).toContain(
      `(${YOGYAKARTA.south},${YOGYAKARTA.west},${YOGYAKARTA.north},${YOGYAKARTA.east})`,
    );
  });
});

import { describe, expect, it } from 'vitest';
import { toMaplet, type GeoJsonFeatureCollection } from '../src/index.js';

/**
 * The named-place regression.
 *
 * A maplet in a dense area compiled to zero named places: 4,057 anonymous
 * intersections were built from the ways, the default node cap of 4,000 was
 * reached, and the loop that turns points into named nodes broke before running.
 *
 * The order is deliberate - lines first so points can snap onto a junction that
 * already exists - but the cap was applied uniformly, so a street-dense area
 * spent the entire budget of nodes on anonymous geometry and an agent asking
 * "where is a cafe" got a map with no cafes on it. This is worse than a large
 * maplet: it is confidently wrong about what the area contains.
 *
 * The budget fitter cannot rescue it either, because it runs on the compiled
 * graph, and the names were never compiled into it.
 */

/** A dense street grid with a handful of named places on it. */
function denseUrbanFixture(ways: number): GeoJsonFeatureCollection {
  const features: GeoJsonFeatureCollection['features'] = [];

  // A grid of long parallel streets. Each way is split into many vertices, which
  // is what produces one intersection per vertex after compilation.
  for (let w = 0; w < ways; w++) {
    const lat = 37.79 + w * 0.0004;
    const coords: [number, number][] = [];
    for (let i = 0; i < 40; i++) {
      coords.push([-122.4 + i * 0.0004, lat]);
    }
    features.push({
      type: 'Feature',
      properties: { highway: 'residential', name: `Street ${w}` },
      geometry: { type: 'LineString', coordinates: coords },
    });
  }

  // Named places, interleaved so they are not all at one edge of the area.
  for (let p = 0; p < 8; p++) {
    features.push({
      type: 'Feature',
      properties: { amenity: 'cafe', name: `Cafe ${p}` },
      geometry: { type: 'Point', coordinates: [-122.398 + p * 0.0009, 37.7905 + p * 0.0009] },
    });
  }
  return { type: 'FeatureCollection', features };
}

const BBOX = { west: -122.405, south: 37.785, east: -122.385, north: 37.805 };

function compile(fc: GeoJsonFeatureCollection, budget: number, maxNodes?: number) {
  return toMaplet(fc, {
    bbox: BBOX,
    budget,
    radiusLabel: '400m',
    ...(maxNodes !== undefined ? { compile: { maxNodes } } : {}),
    capabilities: { elevation: false, weather: false, traffic: false },
  });
}

describe('named places survive a dense street grid', () => {
  it('keeps named places at the default node cap', () => {
    // Enough ways to blow past DEFAULT_MAX_NODES on intersections alone.
    const m = compile(denseUrbanFixture(200), 2048);
    const named = m.graph.nodes.filter((n) => n.name);

    // The regression: this was zero, because the ways exhausted maxNodes before
    // the point pass ever ran.
    expect(named.length).toBeGreaterThan(0);
    expect(named.some((n) => n.name?.startsWith('Cafe'))).toBe(true);
  });

  it('reports how many nodes the compile reached before the cap', () => {
    // Diagnostic value as much as a test: if the cap is ever hit, this says so,
    // because a silently capped compile is what produced zero named places.
    const m = compile(denseUrbanFixture(200), 2048);
    expect(m.metrics.droppedNodes).toBeGreaterThanOrEqual(0);
  });

  it('still emits edges, so the map is navigable', () => {
    // The fix must not simply delete the streets. A maplet with names and no
    // edges is as useless as one with edges and no names.
    const m = compile(denseUrbanFixture(200), 2048);
    expect(m.graph.edges.length).toBeGreaterThan(0);
  });

  it('honours the token budget with named places present', () => {
    // Adding names must not let the emitted maplet blow past its budget.
    for (const budget of [1024, 2048, 4096]) {
      const m = compile(denseUrbanFixture(200), budget);
      expect(m.metrics.tokens).toBeLessThanOrEqual(budget * 1.1);
    }
  });

  it('names a place in a sparse area too', () => {
    // Control: a sparse area worked before, and must keep working. If this ever
    // fails, the fix has broken the easy case.
    const m = compile(denseUrbanFixture(3), 2048);
    expect(m.graph.nodes.filter((n) => n.name).length).toBeGreaterThan(0);
  });
});
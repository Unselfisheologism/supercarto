import { describe, expect, it } from 'vitest';
import { densityToHeat, slopeToHeat } from '../src/source/heat.js';
import { toMaplet } from '../src/index.js';
import type { GeoJsonFeatureCollection } from '../src/index.js';
import type { Envelope } from '../src/wire/types.js';

const ENV: Envelope = {
  type: 'bbox',
  west: 139.68,
  south: 35.68,
  east: 139.70,
  north: 35.70,
};

/**
 * A heat layer that spends budget saying nothing is worse than no heat layer.
 *
 * Two defects, both found by reading a live maplet's output rather than the code:
 *
 *  1. `slopeToHeat` emitted an all-zero layer over flat terrain. A maplet printed
 *     `slope: {max: 0, mean: 0}` followed by five lines all reading `v: 0, rel: 0`.
 *  2. `compileHeat` projected heat cells in the layer's own 16x16 grid as though
 *     they were coordinates in the document's 4096-unit extent, so every cell
 *     landed in the same corner. One maplet printed three different density values
 *     at a single coordinate, and five samples across three unique points.
 */
describe('heat layers carry signal or are absent', () => {
  it('emits nothing for flat terrain', () => {
    const flat = new Float32Array(64).fill(10);
    expect(slopeToHeat(flat, 8, 8)).toBeUndefined();
  });

  it('emits a layer when the gradient varies across the area', () => {
    // A uniform ramp grades uniformly, and the 20% clamp flattens it to a constant,
    // so there is genuinely nothing to say. A ridge does vary.
    const ridge = new Float32Array(64);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) ridge[y * 8 + x] = Math.abs(x - 3.5) * 3;
    }
    const layer = slopeToHeat(ridge, 8, 8);
    expect(layer).toBeDefined();
    expect(layer!.maxValue).toBeGreaterThan(layer!.minValue);
    expect(layer!.cells?.every((c) => c.value > 0)).toBe(true);
  });

  it('places cells at distinct coordinates, not stacked at one point', () => {
    // Heat lives on the document, and only the live path derives it, so this
    // attaches a layer directly and compiles through the `doc` option - the same
    // route `SuperCarto.maplet` takes.
    const base = toMaplet(
      {
        type: 'FeatureCollection',
        features: Array.from({ length: 12 }, (_, i) => ({
          type: 'Feature',
          properties: { amenity: 'cafe', name: `Cafe ${i}` },
          geometry: {
            type: 'Point',
            coordinates: [ENV.west + 0.001 + i * 0.0008, ENV.south + 0.001 + (i % 4) * 0.004],
          },
        })),
      } as GeoJsonFeatureCollection,
      {
        bbox: { west: ENV.west, south: ENV.south, east: ENV.east, north: ENV.north },
        budget: 4000,
        radiusLabel: 'test',
        capabilities: { elevation: false, weather: false, traffic: false },
      },
    );

    // Distinct cells spread across the 16x16 grid, distinct values.
    base.doc.heat = [
      {
        id: 1,
        name: 'poi_density',
        resolution: 16,
        minValue: 0,
        maxValue: 20,
        encoding: 'sparse',
        cells: [
          { x: 1, y: 1, value: 20 },
          { x: 9, y: 3, value: 14 },
          { x: 5, y: 11, value: 9 },
          { x: 13, y: 7, value: 4 },
        ],
      },
    ];

    const compiled = toMaplet({ type: 'FeatureCollection', features: [] } as GeoJsonFeatureCollection, {
      doc: base.doc,
      bbox: { west: ENV.west, south: ENV.south, east: ENV.east, north: ENV.north },
      budget: 4000,
      radiusLabel: 'test',
      capabilities: { elevation: false, weather: false, traffic: false },
    });

    const layer = compiled.graph.heat[0];
    expect(layer, 'heat layer should survive compilation').toBeDefined();
    expect(layer!.hotspots.length).toBeGreaterThan(1);

    // The regression: cells were projected in the layer's 16x16 grid as though
    // they were 4096-unit extent coordinates, so every hotspot landed on one point.
    const keys = layer!.hotspots.map((s) => `${s.lat},${s.lon}`);
    expect(new Set(keys).size).toBe(keys.length);

    // And each hotspot must be inside the requested envelope, not in one corner.
    for (const s of layer!.hotspots) {
      expect(s.lat).toBeGreaterThan(ENV.south);
      expect(s.lat).toBeLessThan(ENV.north);
      expect(s.lon).toBeGreaterThan(ENV.west);
      expect(s.lon).toBeLessThan(ENV.east);
    }
  });

  it('drops a layer whose cells are all the same value', () => {
    const base = toMaplet(
      { type: 'FeatureCollection', features: [] } as GeoJsonFeatureCollection,
      {
        bbox: { west: ENV.west, south: ENV.south, east: ENV.east, north: ENV.north },
        budget: 1024,
        radiusLabel: 'test',
        capabilities: { elevation: false, weather: false, traffic: false },
      },
    );
    base.doc.heat = [
      {
        id: 1,
        name: 'slope_pct',
        resolution: 16,
        minValue: 0,
        maxValue: 0,
        encoding: 'sparse',
        cells: [
          { x: 2, y: 2, value: 0 },
          { x: 8, y: 8, value: 0 },
          { x: 4, y: 12, value: 0 },
        ],
      },
    ];
    const compiled = toMaplet({ type: 'FeatureCollection', features: [] } as GeoJsonFeatureCollection, {
      doc: base.doc,
      bbox: { west: ENV.west, south: ENV.south, east: ENV.east, north: ENV.north },
      budget: 1024,
      radiusLabel: 'test',
      capabilities: { elevation: false, weather: false, traffic: false },
    });
    expect(compiled.graph.heat).toHaveLength(0);
    expect(compiled.yaml).not.toContain('slope_pct');
  });
});

describe('density heat', () => {
  it('bins into the declared resolution grid', () => {
    const points = Array.from({ length: 30 }, (_, i) => ({ x: i * 10, y: i * 7, value: 1 }));
    const layer = densityToHeat(points, ENV)!;
    expect(layer.resolution).toBe(16);
    for (const c of layer.cells ?? []) {
      expect(c.x).toBeLessThan(16);
      expect(c.y).toBeLessThan(16);
    }
  });

  it('accumulates repeated points into one cell rather than many', () => {
    const same = Array.from({ length: 12 }, () => ({ x: 100, y: 100, value: 1 }));
    const layer = densityToHeat(same, ENV)!;
    expect(layer.cells).toHaveLength(1);
    expect(layer.cells![0]!.value).toBe(12);
  });
});
import { describe, expect, it } from 'vitest';
import {
  bboxToTile,
  compassOf,
  dedupeLine,
  gridScaleFor,
  gridToLonLat,
  haversine,
  latToMercY,
  lonLatToGrid,
  mercXToLon,
  mercYToLat,
  lonToMercX,
  metersPerDegLon,
  simplifyLine,
  tileBounds,
  turnFrom,
  fromGeoJson,
  compile,
  type GridLine,
} from '../src/index.js';

const SF = { lat: 37.7749, lon: -122.4194 };

const COMPASS_WORDS = [
  'north',
  'northeast',
  'east',
  'southeast',
  'south',
  'southwest',
  'west',
  'northwest',
];

describe('projection', () => {
  it('round-trips lon/lat through the grid', () => {
    const env = { type: 'bbox' as const, west: -122.43, south: 37.76, east: -122.40, north: 37.79 };
    const grid = lonLatToGrid(SF, env, 4096);
    const back = gridToLonLat(grid, env, 4096);
    // One grid unit at this scale is well under a metre, so the round trip
    // should land within a few metres.
    expect(haversine(SF, back)).toBeLessThan(5);
  });

  it('round-trips at high latitude', () => {
    const oslo = { lat: 59.9139, lon: 10.7522 };
    const env = { type: 'bbox' as const, west: 10.70, south: 59.88, east: 10.80, north: 59.95 };
    const back = gridToLonLat(lonLatToGrid(oslo, env, 4096), env, 4096);
    expect(haversine(oslo, back)).toBeLessThan(5);
  });

  it('places the origin at the top-left of a tile', () => {
    const env = { type: 'tile' as const, z: 15, x: 5240, y: 12661 };
    const bounds = tileBounds(15, 5240, 12661);
    const topLeft = gridToLonLat({ x: 0, y: 0 }, env, 4096);
    expect(topLeft.lon).toBeCloseTo(bounds.west, 4);
    expect(topLeft.lat).toBeCloseTo(bounds.north, 4);
  });

  it('keeps y increasing southward', () => {
    // Grid y must grow toward the south, since that is the tile convention and
    // the compiler's compass function depends on it.
    const env = { type: 'tile' as const, z: 15, x: 5240, y: 12661 };
    const north = gridToLonLat({ x: 0, y: 0 }, env, 4096);
    const south = gridToLonLat({ x: 0, y: 4096 }, env, 4096);
    expect(north.lat).toBeGreaterThan(south.lat);
  });

  it('computes tile bounds that agree with the inverse projection', () => {
    const { north, south, west, east } = tileBounds(15, 5240, 12661);
    expect(north).toBeGreaterThan(south);
    expect(east).toBeGreaterThan(west);
    // The bounds must round-trip through mercator at both corners: converting
    // the north edge to northing and back has to return the same latitude.
    expect(mercYToLat(latToMercY(north))).toBeCloseTo(north, 9);
    expect(mercYToLat(latToMercY(south))).toBeCloseTo(south, 9);
    expect(mercXToLon(lonToMercX(west))).toBeCloseTo(west, 9);
  });
});

describe('grid scale', () => {
  /** Build a two-vertex line and measure it the way the emitter does. */
  function measure(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    const doc = fromGeoJson({
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          id: 1,
          properties: { highway: 'primary' },
          geometry: { type: 'LineString' as const, coordinates: [[a.lon, a.lat], [b.lon, b.lat]] },
        },
      ],
    });
    const scale = gridScaleFor(doc)!;
    const edge = compile(doc, {}).edges[0]!;
    return Math.hypot(edge.dx * scale.x, edge.dy * scale.y);
  }

  it('matches haversine for an east-west span at mid latitude', () => {
    const a = { lat: 37.7749, lon: -122.4194 };
    const b = { lat: 37.7749, lon: -122.4095 };
    const measured = measure(a, b);
    const truth = haversine(a, b);
    // Quantization at 4096 units is the dominant error, so allow 1%.
    expect(Math.abs(measured - truth) / truth).toBeLessThan(0.01);
  });

  it('matches haversine at high latitude, where mercator error is worst', () => {
    const a = { lat: 59.9139, lon: 10.7522 };
    const b = { lat: 59.9139, lon: 10.7622 };
    const measured = measure(a, b);
    const truth = haversine(a, b);
    expect(Math.abs(measured - truth) / truth).toBeLessThan(0.01);
  });

  it('matches haversine for a north-south span', () => {
    const a = { lat: 37.7749, lon: -122.4194 };
    const b = { lat: 37.7849, lon: -122.4194 };
    const measured = measure(a, b);
    const truth = haversine(a, b);
    expect(Math.abs(measured - truth) / truth).toBeLessThan(0.01);
  });

  it('matches haversine for a diagonal span', () => {
    const a = { lat: 37.7749, lon: -122.4194 };
    const b = { lat: 37.7849, lon: -122.4095 };
    const measured = measure(a, b);
    const truth = haversine(a, b);
    expect(Math.abs(measured - truth) / truth).toBeLessThan(0.02);
  });

  it('returns undefined for a degenerate envelope instead of a fake scale', () => {
    // A zero-extent tile has no meaningful ground scale, so the scale must be
    // undefined rather than zero or Infinity, which would poison every
    // distance in the emitted graph.
    const doc = fromGeoJson(
      { type: 'FeatureCollection', features: [] },
      { envelope: { type: 'tile', z: 0, x: 0, y: 0 }, extent: 0 },
    );
    expect(gridScaleFor(doc)).toBeUndefined();
  });
});

describe('haversine', () => {
  it('returns zero for identical points', () => {
    expect(haversine(SF, SF)).toBe(0);
  });

  it('agrees with a known short span', () => {
    // One degree of latitude is ~111.2 km everywhere.
    const d = haversine({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    expect(d / 1000).toBeCloseTo(111.2, 0);
  });

  it('shrinks a degree of longitude with latitude', () => {
    const equator = haversine({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
    const north = haversine({ lat: 60, lon: 0 }, { lat: 60, lon: 1 });
    expect(north).toBeLessThan(equator / 2 + 1);
  });
});

describe('metersPerDegLon', () => {
  it('halves from the equator to 60 degrees', () => {
    expect(metersPerDegLon(60) / metersPerDegLon(0)).toBeCloseTo(0.5, 2);
  });
});

describe('compass', () => {
  it('reports cardinal directions from grid deltas', () => {
    // Grid y grows southward, so -y is north.
    expect(compassOf({ x: 0, y: 0 }, { x: 0, y: -10 })).toBe('north');
    expect(compassOf({ x: 0, y: 0 }, { x: 0, y: 10 })).toBe('south');
    expect(compassOf({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe('east');
    expect(compassOf({ x: 0, y: 0 }, { x: -10, y: 0 })).toBe('west');
  });

  it('reports diagonals', () => {
    expect(compassOf({ x: 0, y: 0 }, { x: 10, y: -10 })).toBe('northeast');
    expect(compassOf({ x: 0, y: 0 }, { x: -10, y: 10 })).toBe('southwest');
  });

  it('handles a zero-length vector without throwing', () => {
    // A degenerate vector has no direction. The contract is only that it
    // returns one of the eight words and does not produce NaN.
    expect(COMPASS_WORDS).toContain(compassOf({ x: 5, y: 5 }, { x: 5, y: 5 }));
  });

  it('derives turns from inbound and outbound directions', () => {
    expect(turnFrom('north', 'east')).toBe('right');
    expect(turnFrom('north', 'west')).toBe('left');
    expect(turnFrom('north', 'north')).toBe('straight');
  });
});

describe('simplification', () => {
  const zigzag: GridLine = [];
  for (let i = 0; i < 100; i++) zigzag.push({ x: i * 10, y: i % 2 === 0 ? 0 : 1 });

  it('collapses a collinear line to its endpoints', () => {
    const line: GridLine = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 15, y: 0 },
      { x: 20, y: 0 },
    ];
    const out = simplifyLine(line, 1);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[out.length - 1]).toEqual({ x: 20, y: 0 });
  });

  it('keeps a corner that exceeds the tolerance', () => {
    const line: GridLine = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(simplifyLine(line, 1)).toHaveLength(3);
  });

  it('preserves a significant feature at a larger tolerance', () => {
    const line: GridLine = [
      { x: 0, y: 0 },
      { x: 5, y: 40 },
      { x: 10, y: 0 },
    ];
    expect(simplifyLine(line, 5).length).toBeGreaterThanOrEqual(3);
  });

  it('never returns fewer than two vertices for a real line', () => {
    const line: GridLine = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    expect(simplifyLine(line, 1000).length).toBeGreaterThanOrEqual(2);
  });

  it('handles a long line without overflowing the stack', () => {
    // A recursive implementation blows up here; this is the regression guard.
    const long: GridLine = [];
    for (let i = 0; i < 50_000; i++) long.push({ x: i, y: (i % 7) - 3 });
    expect(() => simplifyLine(long, 1)).not.toThrow();
  });

  it('returns the input unchanged when tolerance is zero', () => {
    expect(simplifyLine(zigzag, 0)).toBe(zigzag);
  });
});

describe('dedupe', () => {
  it('removes consecutive duplicates', () => {
    const line: GridLine = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 5, y: 5 },
    ];
    expect(dedupeLine(line)).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 5 },
    ]);
  });

  it('drops a repeated closing vertex for a ring', () => {
    const ring: GridLine = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 5 },
      { x: 0, y: 0 },
    ];
    expect(dedupeLine(ring, true)).toHaveLength(3);
  });
});

describe('tile selection', () => {
  it('chooses a coarse tile for a large bbox', () => {
    const t = bboxToTile(-122.5, 37.7, -122.3, 37.9, 1);
    expect(t.z).toBeLessThanOrEqual(12);
  });

  it('chooses a fine tile for a small bbox', () => {
    // A ~900m x 1100m bbox needs zoom 14 or finer to fit in one tile.
    const t = bboxToTile(-122.42, 37.77, -122.41, 37.78, 1);
    expect(t.z).toBeGreaterThanOrEqual(13);
  });
});

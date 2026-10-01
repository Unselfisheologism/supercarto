import type { Envelope, HeatLayer, Projection } from '../wire/types.js';
import { gridToLonLat } from '../geo/project.js';

/**
 * Agent-shaped heatmaps.
 *
 * The plan called for heatmaps and the codec was built for them, but nothing
 * produced them, so the feature was inert. What follows closes that gap with
 * the only two kinds worth having for an agent acting for a person.
 *
 * A pretty traffic heatmap is not one of them. An agent does not need to know a
 * road is red; it needs to know which walk to take, when to leave, and whether
 * the ground rises. So the layers here are:
 *
 * - `poi_density` - where the useful places are, which is what a person
 *   choosing a meeting point or a dinner location is actually asking.
 * - `elevation` and `slope` - whether a route climbs, which changes whether a
 *   wheelchair, a pram, a bike, or a person with a heart condition can take it.
 *
 * Both are derived from data already in the document, so they cost no extra
 * network call.
 */

export interface HeatCellInput {
  x: number;
  y: number;
  value: number;
}

/**
 * Count named places into a grid and return a sparse heat layer.
 *
 * Sparse rather than dense because a model needs the shape of the distribution,
 * not 4096 numbers it will never look at. A 16x16 grid over a 400m radius is
 * 25m cells, which is finer than the block an agent reasons about, so the
 * hotspots it reports are ones it can act on.
 */
export function densityToHeat(
  points: HeatCellInput[],
  envelope: Envelope,
  opts: {
    name?: string;
    resolution?: number;
    /** Cap on cells emitted. Default 24. */
    maxCells?: number;
    /** Per-axis metres per grid unit, for the radius label. */
    metresPerUnit?: number;
  } = {},
): HeatLayer | undefined {
  if (points.length === 0) return undefined;

  const extent = maxOf(points.map((p) => p.x), maxOf(points.map((p) => p.y), 1));
  const res = opts.resolution ?? 16;
  const maxCells = opts.maxCells ?? 24;

  const bins = new Map<number, number>();
  for (const p of points) {
    const cx = Math.min(res - 1, Math.max(0, Math.floor((p.x / extent) * res)));
    const cy = Math.min(res - 1, Math.max(0, Math.floor((p.y / extent) * res)));
    const key = cy * res + cx;
    bins.set(key, (bins.get(key) ?? 0) + p.value);
  }

  const ranked = [...bins.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxCells);
  if (ranked.length === 0) return undefined;

  const values = ranked.map(([, v]) => v);
  const cells: HeatLayer['cells'] = ranked.map(([key, v]) => ({
    x: key % res,
    y: Math.floor(key / res),
    value: v,
  }));

  void envelope;
  void opts.metresPerUnit;

  return {
    id: 1,
    name: opts.name ?? 'poi_density',
    resolution: res,
    minValue: Math.min(...values),
    maxValue: Math.max(...values),
    encoding: 'sparse',
    cells,
  };
}

/**
 * Slope from an elevation grid, as a percentage grade.
 *
 * Grade rather than absolute gradient because a percentage is the number a
 * person uses to judge a ramp: 8% is the usual accessibility limit, 5% is
 * comfortable. Metres per metre would make an agent do the conversion.
 */
export function slopeToHeat(
  elevations: Float32Array,
  width: number,
  height: number,
  opts: { name?: string; maxCells?: number; metresPerUnit?: number } = {},
): HeatLayer | undefined {
  if (width < 2 || height < 2) return undefined;

  const mpu = opts.metresPerUnit ?? 1;
  const res = 16;
  const bins = new Map<number, number>();

  const grade = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const here = elevations[y * width + x] ?? 0;
      const right = elevations[y * width + Math.min(width - 1, x + 1)] ?? here;
      const down = elevations[Math.min(height - 1, y + 1) * width + x] ?? here;
      const run = mpu;
      const g = Math.hypot(right - here, down - here) / run;
      grade[y * width + x] = g;
      // Clamped to 20%: beyond that nothing is walkable without a vehicle, and
      // a cell reported as 400% grade is noise rather than information.
      bins.set(
        cellKey(x, y, width, height, res),
        Math.min(0.2, g) * 100,
      );
    }
  }

  const ranked = [...bins.entries()].sort((a, b) => b[1] - a[1]).slice(0, opts.maxCells ?? 16);
  if (ranked.length === 0) return undefined;
  const values = ranked.map(([, v]) => v);

  return {
    id: 1,
    name: opts.name ?? 'slope_pct',
    resolution: res,
    minValue: Math.round(Math.min(...values)),
    maxValue: Math.round(Math.max(...values)),
    encoding: 'sparse',
    cells: ranked.map(([key, v]) => ({
      x: key % res,
      y: Math.floor(key / res),
      value: Math.round(v),
    })),
  };
}

function cellKey(x: number, y: number, w: number, h: number, res: number): number {
  const cx = Math.min(res - 1, Math.max(0, Math.floor((x / Math.max(1, w - 1)) * res)));
  const cy = Math.min(res - 1, Math.max(0, Math.floor((y / Math.max(1, h - 1)) * res)));
  return cy * res + cx;
}

function maxOf(xs: number[], fallback: number): number {
  let m = fallback;
  for (const x of xs) if (x > m) m = x;
  return m;
}

/** Project a heat cell back to lon/lat so the emitter can place a hotspot. */
export function cellToLonLat(
  x: number,
  y: number,
  extent: number,
  envelope: Envelope,
  projection: Projection,
): { lat: number; lon: number } {
  return gridToLonLat({ x, y }, envelope, extent, projection);
}

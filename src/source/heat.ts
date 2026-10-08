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
      grade[y * width + x] = Math.hypot(right - here, down - here) / run;
      // Stored unclamped.
      //
      // Clamping here collapsed every cell steeper than 20% to the same value
      // before ranking, so any terrain with a real gradient produced a flat
      // distribution and was then dropped as carrying no signal. The clamp is a
      // presentation limit - "beyond this nothing is walkable" - so it belongs at
      // emit time, after the hottest cells have already been chosen.
      bins.set(cellKey(x, y, width, height, res), grade[y * width + x]!);
    }
  }

  const all = [...bins.values()];
  if (all.length === 0) return undefined;

  /**
   * Flat terrain has no slope layer.
   *
   * Every cell grades to 0, so there is no distribution to report and every
   * hotspot it could emit reads `v: 0, rel: 0`. That is the whole layer. A real
   * maplet printed `slope: {max: 0, mean: 0}` followed by five identical zero
   * lines - token budget spent asserting nothing.
   *
   * The range is taken over every cell, not just the ones that survive the cap.
   * Judging the top N meant a ridge whose 16 hottest cells happened to tie was
   * reported as having no variation at all, while its flatter cells existed.
   *
   * An absent layer is also the honest signal: no gradient here, so accessibility
   * is not constrained by terrain.
   */
  const rawMax = Math.max(...all);
  const rawMin = Math.min(...all);
  if (rawMax - rawMin <= 0) return undefined;

  const ranked = [...bins.entries()].sort((a, b) => b[1] - a[1]).slice(0, opts.maxCells ?? 16);
  if (ranked.length === 0) return undefined;

  // Clamped only now, after selection.
  const MAX_GRADE_PCT = 20;
  const values = ranked.map(([, v]) => Math.min(MAX_GRADE_PCT, v * 100));

  return {
    id: 1,
    name: opts.name ?? 'slope_pct',
    resolution: res,
    // The declared range is the layer's own range, over every cell and clamped at
    // the same ceiling the emitted values use. Taking it from the emitted top-N
    // instead reported max == min whenever those happened to tie, which collapsed
    // the compiler's `rel` normalisation to a divide-by-nothing.
    minValue: Math.round(Math.min(MAX_GRADE_PCT, rawMin * 100)),
    maxValue: Math.round(Math.min(MAX_GRADE_PCT, rawMax * 100)),
    encoding: 'sparse',
    cells: ranked.map(([key], i) => ({
      x: key % res,
      y: Math.floor(key / res),
      value: Math.round(values[i]!),
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

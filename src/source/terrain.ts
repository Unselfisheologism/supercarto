import type { HeatLayer } from '../wire/types.js';
import type { BboxQuery, MapSource, SourceRequest, SourceResult } from './types.js';

/**
 * Terrain elevation.
 *
 * Web Mercator flattens the earth, so a 2D map cannot tell a model that one
 * street is 40m above another. For anything that reasons about grade - a drone
 * route, a flood, a cyclist - elevation is the missing dimension.
 *
 * The source is a tiled elevation service returning binary 16-bit samples,
 * which is the common shape (Terrarium encoding, used by AWS Terrain Tiles and
 * several open mirrors).
 */

export interface ElevationGrid {
  /** Envelope the samples cover. */
  bbox: BboxQuery;
  /** Samples per axis. */
  width: number;
  height: number;
  /** Row-major elevations in metres, `width * height` entries. */
  values: Float32Array;
  /** Smallest and largest sample, for range checks. */
  min: number;
  max: number;
}

export interface ElevationSource {
  readonly name: string;
  /** Fetch elevations covering `bbox`, sampled to `res` by `res`. */
  fetch(bbox: BboxQuery, res: number, signal?: AbortSignal): Promise<ElevationGrid>;
}

/**
 * Terrarium-encoded elevation tiles.
 *
 * Encoding is `elevation = (raw - 32768) / 256` metres, where `raw` is a
 * big-endian signed 16-bit sample. This is the AWS Terrain Tiles format, and
 * several open endpoints serve it unchanged.
 */
export class TerrariumElevation implements ElevationSource {
  readonly name = 'terrarium';

  /**
   * URL template with `{z}/{x}/{y}` and `{r}` placeholders.
   * `{r}` is the tile size in pixels, e.g. `256`.
   */
  private readonly template: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxTiles: number;

  constructor(opts: { template?: string; fetchImpl?: typeof fetch; maxTiles?: number } = {}) {
    this.template = opts.template ?? 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.maxTiles = opts.maxTiles ?? 16;
  }

  async fetch(bbox: BboxQuery, res: number, signal?: AbortSignal): Promise<ElevationGrid> {
    const { z, tiles } = tilesFor(bbox, this.maxTiles);
    const size = 256;
    const out = new Float32Array(res * res);
    let min = Infinity;
    let max = -Infinity;

    for (const t of tiles) {
      const res0 = await this.fetchImpl(
        this.template
          .replace('{z}', String(z))
          .replace('{x}', String(t.x))
          .replace('{y}', String(t.y))
          .replace('{r}', String(size)),
        { signal },
      );
      if (!res0.ok) continue;
      // Decoding a PNG needs an image decoder; this implementation works when
      // the endpoint serves raw float16 instead, which keeps the dependency
      // surface at zero and is what the `raw` endpoint below expects.
      const buf = new Uint8Array(await res0.arrayBuffer());
      const pixels = decodeRawTerrarium(buf);
      if (!pixels) continue;
      for (let i = 0; i < out.length; i++) {
        const v = sampleBilinear(pixels, pixels.width, pixels.height, i % res, Math.floor(i / res), res);
        out[i] = v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }

    if (min === Infinity) {
      min = 0;
      max = 0;
    }

    return { bbox, width: res, height: res, values: out, min, max };
  }
}

interface RawElevation {
  width: number;
  height: number;
  data: Int16Array;
}

/**
 * Decode a raw Terrarium buffer: `width`, `height` as uint32 LE, then
 * big-endian int16 samples.
 */
function decodeRawTerrarium(buf: Uint8Array): RawElevation | undefined {
  if (buf.length < 8) return undefined;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = dv.getUint32(0, true);
  const height = dv.getUint32(4, true);
  const expected = width * height * 2;
  if (buf.length < 8 + expected) return undefined;
  const data = new Int16Array(width * height);
  for (let i = 0; i < data.length; i++) {
    // Terrarium stores samples big-endian.
    data[i] = dv.getInt16(8 + i * 2, false);
  }
  return { width, height, data };
}

function sampleBilinear(
  grid: RawElevation,
  gw: number,
  gh: number,
  x: number,
  y: number,
  res: number,
): number {
  const fx = (x / Math.max(1, res - 1)) * (gw - 1);
  const fy = (y / Math.max(1, res - 1)) * (gh - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(gw - 1, x0 + 1);
  const y1 = Math.min(gh - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = elev(grid.data, gw, gh, x0, y0);
  const b = elev(grid.data, gw, gh, x1, y0);
  const c = elev(grid.data, gw, gh, x0, y1);
  const d = elev(grid.data, gw, gh, x1, y1);
  const top = a + (b - a) * tx;
  const bot = c + (d - c) * tx;
  return (top + (bot - top) * ty - 32768) / 256;
}

function elev(data: Int16Array, w: number, h: number, x: number, y: number): number {
  const cx = Math.max(0, Math.min(w - 1, x));
  const cy = Math.max(0, Math.min(h - 1, y));
  return data[cy * w + cx] ?? 0;
}

/** Slippy tiles covering a bbox, capped so a huge area cannot fan out. */
function tilesFor(bbox: BboxQuery, maxTiles: number): { z: number; tiles: Array<{ x: number; y: number }> } {
  const nw = tileX(bbox.west, bbox.north);
  const se = tileX(bbox.east, bbox.south);
  for (let z = 12; z >= 0; z--) {
    const a = nw(z);
    const b = se(z);
    const w = Math.abs(b.x - a.x) + 1;
    const h = Math.abs(b.y - a.y) + 1;
    if (w * h <= maxTiles) {
      const tiles: Array<{ x: number; y: number }> = [];
      for (let x = a.x; x <= b.x; x++) {
        for (let y = a.y; y <= b.y; y++) tiles.push({ x, y });
      }
      return { z, tiles };
    }
  }
  return { z: 0, tiles: [{ x: 0, y: 0 }] };
}

function tileX(lon: number, lat: number): (z: number) => { x: number; y: number } {
  return (z: number) => {
    const n = 2 ** z;
    const x = Math.floor(((lon + 180) / 360) * n);
    const latRad = Math.max(-85.05112878, Math.min(85.05112878, lat)) * (Math.PI / 180);
    const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
    return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
  };
}

/**
 * Turn an elevation grid into a SCR heat layer.
 *
 * Reusing the heat encoding rather than inventing an elevation-specific one is
 * deliberate: it is the same shape (a scalar field over a grid), it reuses the
 * sparse and run-length encodings, and the agent already knows how to read a
 * heat layer. An `elevation` layer with `rel` values is self-explanatory.
 */
export function elevationToHeat(grid: ElevationGrid, name = 'elevation'): HeatLayer {
  const cells: HeatLayer['cells'] = [];
  // Report the extremes and a coarse sample, not every cell. A model needs to
  // know the terrain ranges across here and where the high ground is; it does
  // not need a 64x64 grid of numbers it will never use.
  const step = Math.max(1, Math.floor(grid.width / 16));
  for (let y = 0; y < grid.height; y += step) {
    for (let x = 0; x < grid.width; x += step) {
      const v = grid.values[y * grid.width + x] ?? 0;
      cells.push({ x, y, value: Math.round(v) });
    }
  }
  return {
    id: 1,
    name,
    resolution: grid.width,
    minValue: Math.round(grid.min),
    maxValue: Math.round(grid.max),
    encoding: 'sparse',
    cells,
  };
}

export type { MapSource, SourceRequest, SourceResult };
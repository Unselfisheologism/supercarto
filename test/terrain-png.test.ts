import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { decodePngTerrarium } from '../src/source/png.js';
import { TerrariumElevation } from '../src/source/terrain.js';
import type { BboxQuery } from '../src/source/types.js';

/**
 * A PNG value is not elevation until the 32768 offset comes off.
 *
 * Terrarium tiles arrive as PNG images; before this decoder existed the
 * elevation source silently skipped every real-world tile, so the hosted
 * `/terrain` route answered an honest 503 instead of elevation. These tests
 * pin the PNG path: chunk parsing, every scanline filter, the exact
 * Terrarium formula, and the rejects for the formats this decoder refuses to
 * guess at.
 */

const SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(chunk: Uint8Array): number {
  const store = globalThis as unknown as { __crcTable?: Int32Array };
  let table = store.__crcTable;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    store.__crcTable = table;
  }
  let crc = -1;
  for (const b of chunk) crc = table[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

interface PngOptions {
  width: number;
  height: number;
  /** One RGB triple per pixel, row-major. */
  pixels: Array<[number, number, number]>;
  /** Color type: 2 = RGB, 6 = RGBA. */
  colorType?: 2 | 6;
  /** Filter type applied to every scanline (0-4), for filter coverage tests. */
  filter?: number;
  bitDepth?: number;
  interlace?: number;
  colorOverride?: number;
  truncateAt?: number;
}

/** Build a Prairie-style minimal PNG by hand; `node:zlib` supplies the IDAT. */
function makeTerrariumPng(opts: PngOptions): Uint8Array {
  const {
    width,
    height,
    pixels,
    colorType = 2,
    filter = 0,
    bitDepth = 8,
    interlace = 0,
    colorOverride,
    truncateAt,
  } = opts;
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;

  // Unfiltered pixel rows, in the domain filters receive them.
  const rawRows: Array<Uint8Array> = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(stride);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixels[y * width + x] ?? [0, 0, 0];
      const o = x * channels;
      row[o] = r;
      row[o + 1] = g;
      row[o + 2] = b;
      if (channels === 4) row[o + 3] = 255;
    }
    rawRows.push(row);
  }

  const idat = deflateSync(filteredRows(width, channels, rawRows, filter));

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = colorOverride ?? colorType;
  ihdr[12] = interlace;

  const chunks: Array<Uint8Array> = [];
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', idat));
  chunks.push(chunk('IEND', new Uint8Array(0)));

  let total = 8;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  out.set(SIG, 0);
  let off = 8;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return truncateAt === undefined ? out : out.slice(0, truncateAt);
}

/**
 * Apply one row filter per scanline, exactly as the PNG spec's encoders do,
 * so the decoder under test has to handle every filter to pass.
 */
function filteredRows(
  width: number,
  channels: number,
  rows: Array<Uint8Array>,
  filter: number,
): Uint8Array {
  const stride = width * channels;
  const mosaic = new Uint8Array(rows.length * (stride + 1));
  rows.forEach((unfiltered, y) => {
    const prior = y > 0 ? rows[y - 1]! : null;
    const filtered = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? unfiltered[i - channels]! : 0;
      const up = prior ? prior[i]! : 0;
      const upleft = prior && i >= channels ? prior[i - channels]! : 0;
      switch (filter) {
        case 1: // Sub
          filtered[i] = (unfiltered[i]! - left) & 0xff;
          break;
        case 2: // Up
          filtered[i] = (unfiltered[i]! - up) & 0xff;
          break;
        case 3: // Average
          filtered[i] = (unfiltered[i]! - Math.floor((left + up) / 2)) & 0xff;
          break;
        case 4: // Paeth
          filtered[i] = (unfiltered[i]! - paethEncode(left, up, upleft)) & 0xff;
          break;
        default: // 0: None
          filtered[i] = unfiltered[i]!;
      }
    }
    mosaic.set([filter], y * (stride + 1));
    mosaic.set(filtered, y * (stride + 1) + 1);
  });
  return mosaic;
}

function paethEncode(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  dv.setUint32(8 + body.length, crc32(out.slice(4, 8 + body.length)));
  return out;
}

function pixelsFor(width: number, height: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Range across the tile: R carries big steps, G small, B the fraction,
      // exactly how Terrarium packs elevation.
      out.push([(x * 7) % 256, (y * 11) % 256, (x + y) % 256]);
    }
  }
  return out;
}

async function decode(opts: PngOptions) {
  return decodePngTerrarium(makeTerrariumPng(opts));
}

describe('decodePngTerrarium', () => {
  const W = 4;
  const H = 3;

  it('decodes RGB filter-0 tiles with the exact Terrarium formula', async () => {
    const pixels = pixelsFor(W, H);
    const got = await decode({ width: W, height: H, pixels });
    expect(got).toBeDefined();
    expect(got!.width).toBe(W);
    expect(got!.height).toBe(H);
    for (let p = 0; p < W * H; p++) {
      const [r, g, b] = pixels[p]!;
      const expected = r * 256 + g + b / 256 - 32768;
      expect(got!.data[p]).toBeCloseTo(expected, 3);
    }
  });

  it('decodes every scanline filter to the same values as filter 0', async () => {
    const pixels = pixelsFor(W, H);
    const baseline = await decode({ width: W, height: H, pixels, filter: 0 });
    for (const filter of [1, 2, 3, 4]) {
      const got = await decode({ width: W, height: H, pixels, filter });
      expect(got, `filter ${filter}`).toBeDefined();
      expect(Array.from(got!.data), `filter ${filter}`).toEqual(Array.from(baseline!.data));
    }
  });

  it('accepts RGBA tiles on the R,G,B channel offsets', async () => {
    const pixels = pixelsFor(W, H);
    const rgb = await decode({ width: W, height: H, pixels, colorType: 2 });
    const rgba = await decode({ width: W, height: H, pixels, colorType: 6 });
    expect(rgba).toBeDefined();
    expect(Array.from(rgba!.data)).toEqual(Array.from(rgb!.data));
  });

  it('rejects grayscale, palette, 16-bit, and interlaced bodies instead of guessing', async () => {
    const pixels = pixelsFor(W, H);
    expect(await decode({ width: W, height: H, pixels, colorOverride: 0 })).toBeUndefined();
    expect(await decode({ width: W, height: H, pixels, colorOverride: 3 })).toBeUndefined();
    expect(await decode({ width: W, height: H, pixels, colorOverride: 4 })).toBeUndefined();
    expect(await decode({ width: W, height: H, pixels, bitDepth: 16 })).toBeUndefined();
    expect(await decode({ width: W, height: H, pixels, interlace: 1 })).toBeUndefined();
  });

  it('rejects non-PNG and truncated bodies, like a failed fetch', async () => {
    const pixels = pixelsFor(W, H);
    const png = makeTerrariumPng({ width: W, height: H, pixels });
    expect((await decodePngTerrarium(png.slice(0, 8)))).toBeUndefined();
    expect((await decodePngTerrarium(png.slice(0, png.length - 4)))).toBeUndefined();
    expect(
      await decodePngTerrarium(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])),
    ).toBeUndefined();
  });
});

describe('TerrariumElevation over PNG tiles', () => {
  const BBOX: BboxQuery = { west: -122.42, south: 37.76, east: -122.41, north: 37.77 };

  function serving(
    value: (input: string | URL, init?: RequestInit) => Response | Promise<Response>,
  ) {
    return value as unknown as typeof fetch;
  }

  it('produces real elevation values from a stubbed PNG endpoint', async () => {
    const pixels: Array<[number, number, number]> = [];
    for (let i = 0; i < 256 * 256; i++) {
      // raw > 32768 everywhere, so no sample lands on the 0m baseline; the
      // ramp rises across the tile as raw grows.
      const raw = 32768 + 512 + (i % 256) * 4;
      pixels.push([Math.floor(raw / 256) % 256, raw % 256, 0]);
    }
    const png = makeTerrariumPng({ width: 256, height: 256, pixels });
    const src = new TerrariumElevation({
      fetchImpl: serving(() =>
        new Response(png.slice(), { status: 200 }),
      ),
    });
    const grid = await src.fetch(BBOX, 16);
    expect(grid.width).toBe(16);
    expect(grid.values.length).toBe(256);
    // Somewhere on the ramp the decoder actually landed on real values, not
    // the all-zero "flat plain" the old PNG gap produced.
    expect(grid.min).toBeGreaterThan(1);
    expect(grid.max).toBeGreaterThan(grid.min);
    // Ramp carries raw 512..1532 m above the 32768 baseline: 512..1532 m of
    // real elevation, not values scaled down by an unexplained factor.
    expect(grid.min).toBeGreaterThan(500);
    expect(grid.max).toBeGreaterThan(1500);
    // Formula direction: raw rises left to right, so does elevation.
    expect(grid.values[grid.values.length - 1]).toBeGreaterThan(grid.values[0]!);
  });

  it('keeps the skip behavior for a non-decoding endpoint', async () => {
    const src = new TerrariumElevation({
      fetchImpl: serving(() => new Response('{"error":"nope"}', { status: 200 })),
    });
    const grid = await src.fetch(BBOX, 8);
    expect(grid.min).toBe(0);
    expect(grid.max).toBe(0);
    expect(Array.from(grid.values).every((v) => v === 0)).toBe(true);
  });
});

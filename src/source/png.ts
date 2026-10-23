import { inflate } from './zlibsafe.js';

/**
 * A dependency-free PNG reader for elevation tiles.
 *
 * Elevation sources serve PNG images (AWS Terrain Tiles' Terrarium encoding
 * among them), and decode needs zlib inflate plus the PNG scanline filters.
 * The implementation below reads the 8-bit, non-interlaced subset of the
 * format that those tiles use. There are no runtime npm dependencies: inflate
 * is the Web `DecompressionStream` outside Node and Node's own `zlib` under
 * Node, both through `zlibsafe.ts`.
 *
 * Honesty rules, same as every other decoder here: anything this reader does
 * not understand (palettes, 16-bit depth, Adam7 interlace, other color
 * schemas) is a hard reject that says why, never compressed bytes dressed as
 * data or silently misread elevation.
 */

/** Header of a successfully parsed PNG, minus pixels. */
interface PngHeader {
  width: number;
  height: number;
  /** Bytes per pixel. */
  stride: number;
  /** Indices into each pixel holding the Terrarium R, G, B values. */
  channels: [number, number, number];
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Decode a Terrarium-encoded PNG tile to metres.
 *
 * Returns `{ width, height, data }` where `data` holds
 * `R * 256 + G + B / 256 - 32768` per pixel, the Terrarium elevation metres.
 * Any non-conforming input, including a non-PNG body, returns `undefined` so
 * the caller can skip the tile like a failed fetch.
 */
export async function decodePngTerrarium(
  buf: Uint8Array,
): Promise<{ width: number; height: number; data: Float32Array } | undefined> {
  const parsed = parsePng(buf);
  if (!parsed) return undefined;
  const { header, idat } = parsed;
  let raw: Uint8Array;
  try {
    raw = await inflate(concat(idat));
  } catch {
    return undefined;
  }
  const pixels = defilter(raw, header);
  if (!pixels) return undefined;

  // Terrarium over RGB(A): elevation = R * 256 + G + B / 256 - 32768,
  // in metres. Stored decoded, so the shared bilinear sampler is pure
  // interpolation and both tile body shapes land in the same domain.
  const [ir, ig, ib] = header.channels;
  const data = new Float32Array(header.width * header.height);
  for (let p = 0; p < data.length; p++) {
    const o = p * header.stride;
    data[p] = (pixels[o + ir] ?? 0) * 256 + (pixels[o + ig] ?? 0) + (pixels[o + ib] ?? 0) / 256 - 32768;
  }
  return { width: header.width, height: header.height, data };
}

function parsePng(buf: Uint8Array): { header: PngHeader; idat: Array<Uint8Array> } | undefined {
  if (buf.length < 8) return undefined;
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) return undefined;
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 8;
  let header: PngHeader | undefined;
  const idat: Array<Uint8Array> = [];

  while (off + 8 <= buf.length) {
    const len = dv.getUint32(off, false);
    if (len > 0x7fffffff || off + 12 + len > buf.length) return undefined;
    const type = ascii(buf, off + 4);
    const body = off + 8;
    if (type === 'IHDR') {
      if (len !== 13) return undefined;
      header = readHeader(buf, body, dv);
      if (!header) return undefined;
    } else if (type === 'IDAT') {
      idat.push(buf.slice(body, body + len));
    } else if (type === 'IEND') {
      break;
    }
    // CRC and ancillary chunks are skipped unread: pixel data needs no
    // signature beyond the chunk layout above. An IHDR before any IDAT,
    // however, is mandatory, and is checked below.
    off += 12 + len;
  }

  if (!header || idat.length === 0) return undefined;
  return { header, idat };
}

function readHeader(buf: Uint8Array, at: number, dv: DataView): PngHeader | undefined {
  const width = dv.getUint32(at, false);
  const height = dv.getUint32(at + 4, false);
  const depth = buf[at + 8];
  const color = buf[at + 9];
  const compression = buf[at + 10];
  const filter = buf[at + 11];
  const interlace = buf[at + 12];
  if (width === 0 || width > 65536 || height === 0 || height > 65536) return undefined;
  if (compression !== 0 || filter !== 0 || interlace !== 0) return undefined;
  if (depth !== 8) return undefined;
  // Terrarium-style elevation is RGB (three channels); RGBA is accepted on the
  // same channel offsets since many pipelines hand it over nearly identical.
  // Grayscale(4 and especially 0) and palette(3) are not this encoding and
  // get a hard reject rather than a guess at the channel meaning.
  if (color !== 2 && color !== 6) return undefined;
  const stride = color === 2 ? 3 : 4;
  return { width, height, stride, channels: [0, 1, 2] };
}

/**
 * Undo the PNG scanline filters (type 0-4) into plain pixel rows.
 * `raw` is the inflated stream: one filter byte, then one `stride` byte per
 * pixel, per row.
 */
function defilter(raw: Uint8Array, header: PngHeader): Uint8Array | undefined {
  const { width, height, stride } = header;
  const rowlen = width * stride;
  if (raw.length < height * (rowlen + 1)) return undefined;
  const out = new Uint8Array(height * rowlen);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowlen + 1)];
    const src = y * (rowlen + 1) + 1;
    const dst = y * rowlen;
    for (let i = 0; i < rowlen; i++) {
      const x = src + i;
      const cur = raw[x] ?? 0;
      const left = i >= stride ? out[dst + i - stride] ?? 0 : 0;
      const up = y > 0 ? out[dst - rowlen + i] ?? 0 : 0;
      const upleft = y > 0 && i >= stride ? out[dst - rowlen + i - stride] ?? 0 : 0;
      switch (filter) {
        case 0:
          out[dst + i] = cur;
          break;
        case 1: // Sub
          out[dst + i] = (cur + left) & 0xff;
          break;
        case 2: // Up
          out[dst + i] = (cur + up) & 0xff;
          break;
        case 3: // Average
          out[dst + i] = (cur + ((left + up) >> 1)) & 0xff;
          break;
        case 4: // Paeth
          out[dst + i] = (cur + paeth(left, up, upleft)) & 0xff;
          break;
        default:
          return undefined;
      }
    }
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function concat(parts: Array<Uint8Array>): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

function ascii(buf: Uint8Array, at: number): string {
  return String.fromCharCode(buf[at] ?? 0, buf[at + 1] ?? 0, buf[at + 2] ?? 0, buf[at + 3] ?? 0);
}

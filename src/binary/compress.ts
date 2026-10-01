import {
  gzipSync,
  gunzipSync,
  brotliCompressSync,
  brotliDecompressSync,
} from 'node:zlib';
import { encodeBinary, decodeBinary, SCR_BINARY_MAGIC } from './codec.js';
import type { ScrDocument } from '../wire/types.js';

/** zlib's BROTLI_PARAM_QUALITY, which is not re-exported by Node. */
const BROTLI_PARAM_QUALITY = 0x0001;

/**
 * Compressed transport for SCR documents.
 *
 * Three codecs, chosen by what the consumer already has rather than by size
 * alone. `gzip` is the universal fallback; `brotli` is what browsers and CDNs
 * understand and is usually smallest; `zstd` is the right answer for a modern
 * service but needs a dependency, so it is optional rather than required.
 *
 * All three wrap the same binary body, and the header records which was used,
 * so a document can always be read back without out-of-band information.
 */

export type Codec = 'raw' | 'gzip' | 'brotli' | 'zstd';

const MAGIC = SCR_BINARY_MAGIC;
const CODEC_BYTE = 0xa7;

export interface EncodeOptions {
  /** Compression codec. Default `brotli`, or `zstd` when available. */
  readonly codec?: Codec;
  /** Brotli quality, 0-11. Default 5: the size/time curve flattens by 6. */
  readonly quality?: number;
  /** zstd level, 1-22. Default 3. */
  readonly level?: number;
}

/** Whether zstd is available in this runtime. */
export async function zstdAvailable(): Promise<boolean> {
  try {
    const z = (await import('node:zlib')) as { zstdCompressSync?: unknown };
    return typeof z.zstdCompressSync === 'function';
  } catch {
    return false;
  }
}

export function encode(doc: ScrDocument, opts: EncodeOptions = {}): Uint8Array {
  const body = encodeBinary(doc);
  const codec: Codec = opts.codec ?? defaultCodec();
  const payload = compress(body, codec, opts);
  return wrap(codec, payload);
}

export function decode(bytes: Uint8Array): ScrDocument {
  const { codec, payload } = unwrap(bytes);
  return decodeBinary(decompress(payload, codec));
}

/** Magic bytes for sniffing, so a server can route without decompressing. */
export function isScrBinary(bytes: Uint8Array): boolean {
  if (bytes.length < 10) return false;
  return bytes[4] === CODEC_BYTE && bytes[0] === 0x31 && bytes[1] === 0x52 && bytes[2] === 0x43 && bytes[3] === 0x53;
}

export function defaultCodec(): Codec {
  // zstd when the runtime has it, brotli otherwise. Brotli beats gzip by a wide
  // margin on text and is already present in every supported runtime.
  const z = (globalThis as { zlib?: { zstdCompressSync?: unknown } });
  if (typeof z.zlib?.zstdCompressSync === 'function') return 'zstd';
  return 'brotli';
}

function compress(body: Uint8Array, codec: Codec, opts: EncodeOptions): Uint8Array {
  switch (codec) {
    case 'gzip':
      // gzipSync, not deflateSync: the two are not interchangeable. deflate
      // emits a raw stream with no header, which gunzipSync rejects.
      return new Uint8Array(gzipSync(body, { level: 9 }));
    case 'brotli':
      return new Uint8Array(
        brotliCompressSync(body, {
          // BROTLI_PARAM_QUALITY. The size/time curve flattens by about 6, so
          // higher costs time for very little gain on map documents.
          params: { [BROTLI_PARAM_QUALITY]: opts.quality ?? 5 },
        }),
      );
    case 'zstd': {
      const z = requireZstd();
      return new Uint8Array(z.compressSync(body, { params: { [0x400]: opts.level ?? 3 } }));
    }
    default:
      return body;
  }
}

function decompress(payload: Uint8Array, codec: Codec): Uint8Array {
  switch (codec) {
    case 'gzip':
      return new Uint8Array(gunzipSync(payload));
    case 'brotli':
      return new Uint8Array(brotliDecompressSync(payload));
    case 'zstd': {
      const z = requireZstd();
      return new Uint8Array(z.decompressSync(payload));
    }
    default:
      return payload;
  }
}

function requireZstd(): {
  compressSync: (b: Uint8Array, o?: unknown) => Buffer;
  decompressSync: (b: Uint8Array) => Buffer;
} {
  const z = (globalThis as { zlib?: Record<string, unknown> }).zlib;
  const fns = z ?? {};
  if (typeof fns.zstdCompressSync !== 'function') {
    throw new Error('zstd is not available in this runtime; use codec "brotli" or "gzip"');
  }
  return {
    compressSync: fns.zstdCompressSync as never,
    decompressSync: fns.zstdDecompressSync as never,
  };
}

/**
 * Frame a compressed payload.
 *
 * Layout: magic(4) | frame marker(1) | codec(1) | payload length(4) | payload.
 * The length is explicit so a decoder can validate the buffer before
 * decompressing, which turns a truncated stream into a clear error rather than
 * a zlib stack trace.
 */
const FRAME_HEADER = 10;

function wrap(codec: Codec, payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(FRAME_HEADER + payload.length);
  const dv = new DataView(framed.buffer);
  dv.setUint32(0, MAGIC, true);
  framed[4] = CODEC_BYTE;
  framed[5] = CODEC_ORDINAL[codec] ?? 0;
  dv.setUint32(6, payload.length, true);
  framed.set(payload, FRAME_HEADER);
  return framed;
}

function unwrap(bytes: Uint8Array): { codec: Codec; payload: Uint8Array } {
  if (bytes.length < FRAME_HEADER) throw new Error('SCR binary payload too short');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not an SCR binary payload');
  if (bytes[4] !== CODEC_BYTE) throw new Error('unrecognized SCR binary frame');
  const codec = ordinalToCodec(bytes[5]!);
  const len = dv.getUint32(6, true);
  if (10 + len > bytes.length) {
    throw new Error(`SCR binary payload truncated: declared ${len} bytes, have ${bytes.length - 10}`);
  }
  return { codec, payload: bytes.subarray(FRAME_HEADER, FRAME_HEADER + len) };
}

const CODEC_ORDINAL: Record<Codec, number> = { raw: 0, gzip: 1, brotli: 2, zstd: 3 };

function ordinalToCodec(n: number): Codec {
  switch (n) {
    case 1:
      return 'gzip';
    case 2:
      return 'brotli';
    case 3:
      return 'zstd';
    default:
      return 'raw';
  }
}

/** MIME type for a compressed document, for HTTP responses. */
export function mimeFor(codec: Codec): string {
  return `application/vnd.supercarto.binary+${codec}`;
}
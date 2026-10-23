/**
 * Worker-safe compression decoding.
 *
 * `node:zlib` used to be a static import at the top of `protomaps.ts`, which
 * meant any module that reached a compressed PMTiles archive could not even
 * evaluate inside a non-Node bundle: the import throws at load time on
 * runtimes without Node built-ins. The decoders here instead load the Node
 * module lazily, only when a Node-shaped runtime is detected, and fall back to
 * the standard `DecompressionStream` elsewhere.
 *
 * Node behaviour is unchanged: the same synchronous zlib functions are used,
 * so compiled output stays byte-identical to the Python port (the parity gate
 * enforces this). Cloudflare Workerd's `DecompressionStream` supports `gzip`,
 * `deflate` and `deflate-raw`. PMTiles v3 directories, tiles and JSON metadata
 * files are gzip in the public OSM basemap builds (compression code 2), so the
 * hosted fallback path needs gzip only - brotli (3) and zstd (4) throw the
 * same honest, actionable errors the Node paths would have surfaced rather
 * than never returning compressed bytes dressed as data.
 */

/** The subset of node:zlib this module uses, all synchronous and buffer-based. */
interface NodeZlib {
  gunzipSync: (buf: Uint8Array) => Uint8Array;
  brotliDecompressSync?: (buf: Uint8Array) => Uint8Array;
  zstdDecompressSync?: (buf: Uint8Array) => Uint8Array;
}

/** Whether the process global exists, which is what marks a Node runtime. */
export function nodeRuntime(): boolean {
  return (globalThis as { process?: unknown }).process !== undefined;
}

let nodeZlibPromise: Promise<NodeZlib | undefined> | undefined;

/**
 * Load node:zlib at first use rather than import time.
 *
 * The specifier is read out of an array on purpose: esbuild (wrangler/cf)
 * folds plain `'node:' + 'zlib'` concatenations and would then trace the
 * module into every Worker bundle - where it is neither needed nor allowed
 * without nodejs_compat. A computed element access stays unresolved there,
 * while a plain Node process resolves it at runtime, same sync functions.
 */
async function nodeZlib(): Promise<NodeZlib | undefined> {
  if (!nodeRuntime()) return undefined;
  nodeZlibPromise ??= import(zlibSpecs[0]!) as Promise<NodeZlib>;
  return await nodeZlibPromise;
}

const zlibSpecs: string[] = ['node:zlib'];

/**
 * Inflate with the web-standard `DecompressionStream`, which Workerd exposes
 * for `gzip`, `deflate` (zlib wrapper) and `deflate-raw`. Not used under Node,
 * where the matched synchronous zlib functions keep decoded bytes identical.
 */
export async function webDecompress(
  buf: Uint8Array,
  format: 'gzip' | 'deflate' | 'deflate-raw',
): Promise<Uint8Array> {
  const source = new Response(new Uint8Array(buf)).body;
  if (!source) throw new Error('could not open a decompression stream');
  const deflate = source.pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(deflate).arrayBuffer());
}

/**
 * Inflate an archive component of known compression code.
 *
 * Mirror of the synchronous decoder this module replaces. Codes follow the
 * PMTiles v3 header: `0`/`1` store bytes as-is, `2` gzip, `3` brotli, `4`
 * zstd. The failure cases say what they are, never return compressed bytes
 * dressed as data.
 */
export async function decompress(
  buf: Uint8Array,
  compression: number,
  what: string,
): Promise<Uint8Array> {
  if (compression === 0 || compression === 1) return buf;

  const zlib = await nodeZlib();

  switch (compression) {
    case 2: {
      if (zlib) return zlib.gunzipSync(buf);
      return await webDecompress(buf, 'gzip');
    }
    case 3: {
      if (zlib?.brotliDecompressSync) return zlib.brotliDecompressSync(buf);
      // Without Node's zlib there is no standards-track brotli decoder in
      // Workerd, so the error says where brotli works instead of failing at a
      // distance or appearing as an empty map.
      throw new Error(
        `PMTiles ${what} uses brotli, which needs Node's zlib ` +
          '(this runtime has no brotli decoder)',
      );
    }
    case 4: {
      // zstd arrived in Node 22.15. Absent, the caller gets an error naming
      // the version rather than silently misreading compressed bytes.
      if (zlib?.zstdDecompressSync) return zlib.zstdDecompressSync(buf);
      throw new Error(`PMTiles ${what} uses zstd, which needs Node 22.15 or later`);
    }
    default:
      throw new Error(`unknown PMTiles compression ${compression}`);
  }
}

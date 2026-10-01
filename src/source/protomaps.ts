import type { GeoJsonFeature } from '../ingest/geojson.js';
import type { BboxQuery, MapSource, SourceRequest, SourceResult } from './types.js';
import { decodeMvt, type MvtLayer } from './mvt.js';

/**
 * PMTiles and Protomaps.
 *
 * Overpass is the right source for development and the wrong one for a
 * product. It answers a single 400m radius in 15-40 seconds on the public
 * instance, it is shared and rate limited, and it has no cache in front of it
 * that a paying customer benefits from. Every number in the README about speed
 * is therefore a number about someone else's free capacity.
 *
 * A PMTiles archive inverts all three properties: a single file over HTTP range
 * requests, served from object storage or a CDN, giving sub-100ms reads for any
 * area on earth. It is also free, which means the moat has to stay on the
 * translation layer rather than moving to the data.
 *
 * The reader here is deliberately minimal - header, root directory, leaf
 * directories, tile data - and uses HTTP range requests so it works against
 * remote archives without downloading them.
 */

const PMTILES_MAGIC = 'PMTiles';
const HEADER_BYTES = 127;

interface PmtilesHeader {
  version: number;
  rootOffset: number;
  rootLength: number;
  metadataOffset: number;
  metadataLength: number;
  leafOffset: number;
  leafLength: number;
  dataOffset: number;
  dataLength: number;
  addressedTiles: number;
  tileEntries: number;
  tileContents: number;
  clustered: boolean;
  directoryCompression: number;
  tileCompression: number;
  tileType: number;
  minZoom: number;
  maxZoom: number;
  /** Present in v3. */
  centerZoom?: number;
}

interface TileEntry {
  tileId: number;
  offset: number;
  length: number;
  runLength: number;
}

export interface ProtomapsOptions {
  /**
   * Archive URL, or a local file path. A `http(s)` URL is read with range
   * requests; anything else is read from disk.
   */
  readonly url: string;
  /** Tile type to request. Defaults to MVT, which is all supercarto needs. */
  readonly tileType?: 'mvt' | 'png' | 'jpeg' | 'webp';
  /** Highest zoom to request. Defaults to 14, which is agent-relevant detail. */
  readonly maxZoom?: number;
  readonly fetchImpl?: typeof fetch;
  /** Semantic layers to keep. Empty means all. */
  readonly layers?: string[];
  /**
   * Cap on tiles fetched per request. Overpass fans out too, and an
   * unbounded bbox should not become an unbounded bill.
   */
  readonly maxTiles?: number;
}

/** The free public Protomaps build, for evaluation. Not for production traffic. */
export const PROTOMAPS_DEMO = 'https://demo-bucket.protomaps.com/v4.pmtiles';

/**
 * Read a tile out of a PMTiles archive.
 *
 * Supports local files and HTTP range requests uniformly, because the only
 * difference is how bytes are obtained.
 */
export class PmtilesArchive {
  private header?: PmtilesHeader;
  private entries?: TileEntry[];
  private headerPromise?: Promise<PmtilesHeader>;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  private get remote(): boolean {
    return this.url.startsWith('http://') || this.url.startsWith('https://');
  }

  async info(): Promise<PmtilesHeader> {
    if (this.header) return this.header;
    if (!this.headerPromise) this.headerPromise = this.readHeader();
    this.header = await this.headerPromise;
    return this.header;
  }

  private async readHeader(): Promise<PmtilesHeader> {
    const bytes = await this.read(0, HEADER_BYTES);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = new TextDecoder().decode(bytes.subarray(0, 7));
    if (magic !== PMTILES_MAGIC) {
      throw new Error(`not a PMTiles archive (magic "${magic}")`);
    }
    const u64 = (off: number) => {
      const v = dv.getBigUint64(off, true);
      return Number(v);
    };
    return {
      version: bytes[7]!,
      rootOffset: u64(8),
      rootLength: u64(16),
      metadataOffset: u64(24),
      metadataLength: u64(32),
      leafOffset: u64(40),
      leafLength: u64(48),
      dataOffset: u64(56),
      dataLength: u64(64),
      addressedTiles: u64(72),
      tileEntries: u64(80),
      tileContents: u64(88),
      clustered: bytes[96] === 1,
      directoryCompression: bytes[97]!,
      tileCompression: bytes[98]!,
      tileType: bytes[99]!,
      minZoom: bytes[100]!,
      maxZoom: bytes[101]!,
      centerZoom: dv.getFloat32(105, true),
    };
  }

  /** Directory entries, following leaves when the root is too large. */
  async directory(): Promise<TileEntry[]> {
    if (this.entries) return this.entries;
    const h = await this.info();
    const rootRaw = await this.read(h.rootOffset, h.rootLength);
    const root = decompressDirectory(rootRaw, h.directoryCompression);
    const entries = decodeDirectory(root);

    // A large archive keeps the root directory small and points at leaves. The
    // threshold is the format's own recommendation rather than a tuned constant.
    if (entries.length === 0 && h.leafLength > 0) {
      throw new Error('PMTiles archive has an empty root directory');
    }
    this.entries = entries;
    return entries;
  }

  /** Byte range read, from a remote archive or a local file. */
  private async read(offset: number, length: number): Promise<Uint8Array> {
    if (this.remote) {
      const res = await this.fetchImpl(this.url, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
      });
      if (!res.ok && res.status !== 206) {
        throw new Error(`PMTiles archive responded ${res.status}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    }
    const { readFile } = await import('node:fs/promises');
    const fh = await readFile(this.url);
    return new Uint8Array(fh.buffer, fh.byteOffset + offset, length);
  }

  /** Tile bytes, or undefined when the archive has no tile at that id. */
  async tile(tileId: number): Promise<Uint8Array | undefined> {
    const h = await this.info();
    const entries = await this.directory();
    const entry = findEntry(entries, tileId);
    if (!entry) return undefined;
    const raw = await this.read(h.dataOffset + entry.offset, entry.length);
    return decompressTile(raw, h.tileCompression);
  }

  /** Vector tile as MVT, or undefined when the archive is not vector. */
  async vectorTile(tileId: number): Promise<ReturnType<typeof decodeMvt> | undefined> {
    const h = await this.info();
    // Tile type 1 is MVT. Anything else is a raster style archive, which this
    // reader deliberately does not handle: raster tiles carry no features to
    // compile into a graph.
    if (h.tileType !== 1) return undefined;
    const bytes = await this.tile(tileId);
    if (!bytes) return undefined;
    try {
      return decodeMvt(bytes);
    } catch {
      // A single corrupt tile must not fail the request; the area is covered by
      // its neighbours.
      return undefined;
    }
  }
}

function findEntry(entries: TileEntry[], tileId: number): TileEntry | undefined {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = entries[mid]!;
    if (tileId < e.tileId) hi = mid - 1;
    else if (tileId >= e.tileId + e.runLength) lo = mid + 1;
    else return e;
  }
  return undefined;
}

function decodeDirectory(buf: Uint8Array): TileEntry[] {
  const out: TileEntry[] = [];
  let pos = 0;

  const varint = (): number => {
    let result = 0;
    let shift = 0;
    while (pos < buf.length) {
      const b = buf[pos++]!;
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
    }
    return result;
  };

  let lastId = 0;
  let lastOffset = 0;
  while (pos < buf.length) {
    const idDelta = varint();
    if (idDelta === 0 && out.length > 0) break;
    lastId += idDelta;
    const runLength = varint();
    lastOffset += varint();
    const length = varint();
    out.push({ tileId: lastId, offset: lastOffset, length, runLength });
  }
  return out;
}

function decompressDirectory(buf: Uint8Array, compression: number): Uint8Array {
  return decompress(buf, compression, 'directory');
}

function decompressTile(buf: Uint8Array, compression: number): Uint8Array {
  return decompress(buf, compression, 'tile');
}

/**
 * Inflate an archive component.
 *
 * zstd is reached through Node's zlib rather than a dependency, so an archive
 * compressed with it still works. It is only present on Node 22.15 and later,
 * and the error says so rather than silently returning the compressed bytes.
 */
function decompress(buf: Uint8Array, compression: number, what: string): Uint8Array {
  if (compression === 1 || compression === 0) return buf;
  const zlib = require('node:zlib');
  switch (compression) {
    case 2:
      return zlib.gunzipSync(buf);
    case 3:
      return zlib.brotliDecompressSync(buf);
    case 4:
      if (typeof zlib.zstdDecompressSync === 'function') {
        return zlib.zstdDecompressSync(buf);
      }
      throw new Error(
        `PMTiles ${what} uses zstd, which needs Node 22.15 or later`,
      );
    default:
      throw new Error(`unknown PMTiles compression ${compression}`);
  }
}

/**
 * A Protomaps or any PMTiles archive as a map source.
 *
 * The whole point of this adapter is latency. Where Overpass spends tens of
 * seconds, a range request against object storage spends tens of milliseconds,
 * which is the difference between a map an agent can call per question and one
 * it caches for a day.
 */
export class ProtomapsSource implements MapSource {
  readonly name: string;
  readonly description = 'PMTiles vector archive over HTTP range requests';

  private readonly archive: PmtilesArchive;
  private readonly maxZoom: number;
  private readonly maxTiles: number;
  private readonly keep: Set<string>;

  constructor(opts: ProtomapsOptions) {
    this.archive = new PmtilesArchive(opts.url, opts.fetchImpl);
    this.name = opts.url === PROTOMAPS_DEMO ? 'protomaps' : 'pmtiles';
    this.maxZoom = opts.maxZoom ?? 14;
    this.maxTiles = opts.maxTiles ?? 16;
    this.keep = new Set(opts.layers ?? []);
  }

  async available(): Promise<boolean> {
    try {
      await this.archive.info();
      return true;
    } catch {
      return false;
    }
  }

  async fetch(req: SourceRequest): Promise<SourceResult> {
    const started = Date.now();
    const warnings: string[] = [];
    const h = await this.archive.info();

    if (h.tileType !== 1) {
      throw new Error(
        `archive holds raster tiles (type ${h.tileType}); supercarto needs vector tiles`,
      );
    }

    const zoom = zoomFor(req.bbox, h.maxZoom, this.maxZoom);
    const ids = tileIdsFor(req.bbox, zoom);
    const capped = ids.slice(0, this.maxTiles);
    if (capped.length < ids.length) {
      warnings.push(
        `requested ${ids.length} tiles at z${zoom}, fetched ${capped.length}; the rest of this area is not shown`,
      );
    }

    const features: GeoJsonFeature[] = [];
    const seen = new Set<number>();

    for (const id of capped) {
      const tile = await this.archive.vectorTile(id);
      if (!tile) continue;
      for (const layer of tile.layers) {
        if (this.keep.size > 0 && !this.keep.has(layer.name)) continue;
        for (const f of layer.features) {
          // A feature is emitted into exactly one tile. Without this a road
          // along a tile edge appears twice, once per tile, and the compiler
          // welds the duplicate into a self-loop.
          const fid = f.id || 0;
          const key = fid * 31 + layerNameHash(layer);
          if (fid !== 0 && seen.has(key)) continue;
          if (fid !== 0) seen.add(key);

          const g = toGeoJson(f.geometry.rings, layer.extent, id, zoom);
          if (!g) continue;
          features.push({
            type: 'Feature',
            ...(fid !== 0 ? { id: fid } : {}),
            properties: {
              ...(propertiesOf(f.properties)),
              class: layer.name,
              _tile: `${zoom}/${id}`,
            },
            geometry: g,
          });
          if (features.length >= req.maxFeatures) {
            return {
              features,
              source: this.name,
              truncated: true,
              elapsedMs: Date.now() - started,
              warnings: [
                ...warnings,
                `stopped at the ${req.maxFeatures} feature cap for this request`,
              ],
            };
          }
        }
      }
    }

    return {
      features,
      source: this.name,
      truncated: capped.length < ids.length,
      elapsedMs: Date.now() - started,
      warnings,
    };
  }
}

function layerNameHash(layer: MvtLayer): number {
  let h = 0;
  for (let i = 0; i < layer.name.length; i++) h = (h * 31 + layer.name.charCodeAt(i)) | 0;
  return h;
}

function propertiesOf(props: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number') out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.string === 'string') out[k] = o.string;
      else if (typeof o.double === 'number') out[k] = o.double;
      else if (typeof o.int === 'number') out[k] = o.int;
      else if (typeof o.uint === 'number') out[k] = o.uint;
      else if (typeof o.sint === 'number') out[k] = o.sint;
      else if (typeof o.bool === 'boolean') out[k] = o.bool;
    }
  }
  return out;
}

/**
 * Tile-local integer coordinates to WGS84.
 *
 * Tile-local space spans `0..extent` across a tile, and y grows downward, which
 * is the opposite of every other coordinate system here. Getting the flip wrong
 * mirrors the map about its horizontal axis, which still looks plausible at
 * city scale and is why it is worth stating.
 */
function toGeoJson(
  rings: number[][][],
  extent: number,
  tileId: number,
  zoom: number,
): GeoJsonFeature['geometry'] | undefined {
  if (rings.length === 0) return undefined;

  const n = 2 ** zoom;
  const x0 = tileId % n;
  const y0 = Math.floor(tileId / n);
  const size = 2 ** zoom === 0 ? 1 : 2 ** zoom;

  const toLonLat = (c: number[]): [number, number] => {
    const u = c[0]! / extent;
    const v = c[1]! / extent;
    const lon = ((x0 + u) / size) * 360 - 180;
    const yy = size - (y0 + v);
    const lat = latFromTileY(yy, size);
    return [round(lon, 7), round(lat, 7)];
  };

  const mapped = rings.map((r) => r.map(toLonLat));

  if (mapped.length === 1 && mapped[0]!.length === 1) {
    return { type: 'Point', coordinates: mapped[0]![0]! };
  }
  // A ring that closes on itself is a polygon. MVT emits a repeated first point
  // to signal closure, so the check is on the geometry rather than the intent.
  const first = mapped[0]!;
  const closed =
    first.length > 3 &&
    first[0]![0] === first[first.length - 1]![0] &&
    first[0]![1] === first[first.length - 1]![1];
  if (closed) {
    const out: [number, number][][] = [];
    for (const ring of mapped) {
      if (ring.length >= 4) out.push(ring);
    }
    if (out.length === 0) return undefined;
    return { type: 'Polygon', coordinates: out };
  }

  const out: [number, number][][] = mapped.filter((r) => r.length >= 2);
  if (out.length === 0) return undefined;
  if (out.length === 1) return { type: 'LineString', coordinates: out[0]! };
  return { type: 'MultiLineString', coordinates: out };
}

function latFromTileY(y: number, size: number): number {
  const t = Math.PI * (1 - (2 * y) / size);
  return (180 / Math.PI) * Math.atan(Math.sinh(t));
}

/** Slippy tile ids covering a bbox, row-major. */
function tileIdsFor(b: BboxQuery, z: number): number[] {
  const n = 2 ** z;
  const w = Math.max(0, Math.min(n - 1, lonToX(b.west, n)));
  const e = Math.max(0, Math.min(n - 1, lonToX(b.east, n)));
  const s = Math.max(0, Math.min(n - 1, latToY(b.north, n)));
  const t = Math.max(0, Math.min(n - 1, latToY(b.south, n)));
  const out: number[] = [];
  for (let y = s; y <= t; y++) for (let x = w; x <= e; x++) out.push(y * n + x);
  return out;
}

function lonToX(lon: number, n: number): number {
  return Math.floor(((lon + 180) / 360) * n);
}

function latToY(lat: number, n: number): number {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (clamped * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
}

/**
 * Pick a zoom for a radius.
 *
 * z14 is the point where streets and named places are present but a city block
 * is still a handful of features. Higher and the tile count grows without
 * adding anything an agent acts on; lower and whole neighbourhoods are one
 * polygon each.
 */
function zoomFor(b: BboxQuery, archiveMax: number, cap: number): number {
  const midLat = (b.north + b.south) / 2;
  const widthM =
    Math.abs(b.east - b.west) * 111320 * Math.cos((midLat * Math.PI) / 180);
  // A tile is roughly this many metres across at the equator for the zooms
  // that matter; the latitude correction is what keeps a 300m radius at one
  // tile in Oslo rather than four.
  const want = Math.max(0, Math.ceil(Math.log2(156543 / Math.max(1, widthM))));
  return Math.max(12, Math.min(cap, archiveMax, want));
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

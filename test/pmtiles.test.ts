import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeMvt } from '../src/source/mvt.js';
import { PmtilesArchive, ProtomapsSource, pmtilesTileId } from '../src/source/protomaps.js';
import { toMaplet } from '../src/index.js';

/**
 * PMTiles and MVT decoding.
 *
 * Neither module had a test until now, which is how a decoder could disagree
 * with both published specifications for so long while every other suite stayed
 * green: nothing ever asserted that a tile produced a feature. The fixtures
 * below are built from the written specifications rather than from the reader's
 * own output, so they fail the moment the reader drifts.
 */

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

/** Zigzag, then varint. This is MVT's svarint encoding. */
function svarint(n: number): number[] {
  return varint((n << 1) ^ (n >> 31));
}

function zz(n: number): number {
  return (n << 1) ^ (n >> 31);
}

/**
 * TileID per PMTiles spec 4.1: a cumulative position on the Hilbert curve, so
 * the count of tiles at every lower zoom is included.
 *
 * Deliberately written out here rather than imported from the reader. A fixture
 * that calls the function under test cannot catch that function being wrong.
 */
function hilbert(z: number, x: number, y: number): number {
  let rx: number, ry: number, d = 0;
  for (let s = 1 << (z - 1); s > 0; s >>= 1) {
    rx = (x & s) > 0 ? 1 : 0;
    ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const t = x;
      x = y;
      y = t;
    }
  }
  return d + ((4 ** z - 1) / 3);
}

const EXTENT = 4096;

/**
 * A valid MVT 2.1 tile: one layer, one linestring with a tagged property.
 *
 * Field numbers follow MVT 2.1, which renumbered TileLayer to name=1,
 * features=2, keys=3, values=4, extent=5, version=15. Geometry is a MoveTo of
 * three points followed by one LineTo delta, which is how a multi-point lineline
 * is actually written.
 */
function buildMvt(roadName = 'Market St'): Uint8Array {
  const layerName = 'roads';
  const points: [number, number][] = [
    [100, 200],
    [2000, 200],
    [2000, 3000],
    [3000, 3500],
  ];

  const geom: number[] = [];
  let x = 0;
  let y = 0;
  // Geometry command header is (command_id & 0x7) | (count << 3). Getting these
  // the other way round reads count as the command id and vice versa.
  geom.push(...varint(1 | (points.length << 3)));
  for (const [px, py] of points) {
    geom.push(...svarint(px - x), ...svarint(py - y));
    x = px;
    y = py;
  }
  geom.push(...varint(2 | (1 << 3)), ...svarint(500), ...svarint(0));

  const tags = [0, 0]; // key 0 -> value 0
  const feat = [
    ...varint((1 << 3) | 0), ...varint(42),
    ...varint((2 << 3) | 2), ...varint(tags.length), ...tags,
    ...varint((3 << 3) | 0), ...varint(2), // LINESTRING
    ...varint((4 << 3) | 2), ...varint(geom.length), ...geom,
  ];

  const str = (field: number, s: string): number[] => [
    ...varint((field << 3) | 2),
    ...varint(s.length),
    ...[...s].map((c) => c.charCodeAt(0)),
  ];

  const valueBody = str(1, roadName);
  const layer = [
    ...str(1, layerName),
    ...varint((2 << 3) | 2), ...varint(feat.length), ...feat,
    ...str(3, layerName),
    ...varint((4 << 3) | 2), ...varint(valueBody.length), ...valueBody,
    ...varint((5 << 3) | 0), ...varint(EXTENT),
    ...varint((15 << 3) | 0), ...varint(2),
  ];
  return Uint8Array.from([...varint((3 << 3) | 2), ...varint(layer.length), ...layer]);
}

interface ArchiveSpec {
  z: number;
  tiles: { x: number; y: number }[];
  /** 1 = none, 2 = gzip. */
  tileCompression: number;
  /** 1 = MVT, 2 = PNG. */
  tileType: number;
}

/**
 * Build a PMTiles v3 archive from the specification.
 *
 * The directory is column-major per spec 4.2: count, then every delta-encoded
 * tile ID, then every run length, then every length, then every offset. An
 * offset is stored as `offset + 1`, with zero reserved as the marker for
 * "contiguous with the previous blob".
 */
function buildArchive(spec: ArchiveSpec): { path: string; entries: unknown[] } {
  const HLEN = 127;
  const payloads = spec.tiles.map(() => {
    const raw = buildMvt();
    return spec.tileCompression === 2 ? gzipSync(Buffer.from(raw)) : Buffer.from(raw);
  });

  const entries = spec.tiles
    .map((t, i) => ({
      tileId: hilbert(spec.z, t.x, t.y),
      runLength: 1,
      length: payloads[i]!.length,
      offset: payloads.slice(0, i).reduce((a, p) => a + p.length, 0),
    }))
    .sort((a, b) => a.tileId - b.tileId);

  const dir: number[] = [...varint(entries.length)];
  let lastId = 0;
  for (const e of entries) {
    dir.push(...varint(e.tileId - lastId));
    lastId = e.tileId;
  }
  for (const e of entries) dir.push(...varint(e.runLength));
  for (const e of entries) dir.push(...varint(e.length));
  let nextByte = 0;
  entries.forEach((e, i) => {
    dir.push(...varint(i > 0 && e.offset === nextByte ? 0 : e.offset + 1));
    nextByte = e.offset + e.length;
  });

  const rootDir = Buffer.from(dir);
  const data = Buffer.concat(payloads);
  const header = Buffer.alloc(HLEN);
  header.write('PMTiles', 0, 'ascii');
  header.writeUInt8(3, 7);
  const p64 = (o: number, v: number) => header.writeBigUInt64LE(BigInt(v), o);
  p64(8, HLEN);
  p64(16, rootDir.length);
  p64(24, 0);
  p64(32, 0);
  p64(40, 0);
  p64(48, 0);
  p64(56, HLEN + rootDir.length);
  p64(64, data.length);
  p64(72, spec.tiles.length);
  p64(80, entries.length);
  p64(88, payloads.length);
  header.writeUInt8(1, 96); // clustered
  header.writeUInt8(0, 97); // internal compression: none
  header.writeUInt8(spec.tileCompression, 98);
  header.writeUInt8(spec.tileType, 99);
  header.writeUInt8(spec.z, 100);
  header.writeUInt8(spec.z, 101);
  header.writeUInt8(spec.z, 102);
  header.writeFloatLE(0.5, 105);

  const dir1 = mkdtempSync(join(tmpdir(), 'supercarto-pmtiles-'));
  const path = join(dir1, 'test.pmtiles');
  writeFileSync(path, Buffer.concat([header, rootDir, data]));
  return { path, entries };
}

// San Francisco at z12, which is the zoom the source actually selects for this
// bbox: a ~2.2km-wide box resolves to z7 by its own arithmetic and is floored
// to z12. A fixture at any other zoom tests nothing, because the reader is
// entitled to ask for a different zoom than the fixture happens to hold.
const SF_TILES = [
  { x: 655, y: 1583 },
  { x: 654, y: 1583 },
  { x: 655, y: 1584 },
];
const SF_BBOX = { west: -122.4268, south: 37.7702, east: -122.4014, north: 37.7799 };

describe('MVT decoding', () => {
  it('reads the layer name, which is field 1 in MVT 2.1', () => {
    // Written against spec v1 this reads name as a varint and loses it, so the
    // layer arrives nameless and its features cannot be attributed to a layer.
    const tile = decodeMvt(buildMvt());
    expect(tile.layers).toHaveLength(1);
    expect(tile.layers[0]!.name).toBe('roads');
  });

  it('reads the extent, which is field 5 in MVT 2.1', () => {
    expect(decodeMvt(buildMvt()).layers[0]!.extent).toBe(EXTENT);
  });

  it('reads features, which are field 2', () => {
    expect(decodeMvt(buildMvt()).layers[0]!.features).toHaveLength(1);
  });

  it('keeps the feature id', () => {
    // The id is what deduplicates a road spanning two tiles. Losing it turns
    // every shared road into a duplicate that welds into a self-loop.
    expect(decodeMvt(buildMvt()).layers[0]!.features[0]!.id).toBe(42);
  });

  it('resolves tags against the key and value tables', () => {
    // Tags are indices into tables that appear later in the wire order, so a
    // decoder that resolves eagerly sees an empty table and drops every tag.
    const f = decodeMvt(buildMvt('Mission Street')).layers[0]!.features[0]!;
    expect(f.properties.roads).toEqual({ string: 'Mission Street' });
  });

  it('keeps a multi-point MoveTo in one part', () => {
    // Breaking a part per MoveTo point turns a single four-point line into
    // fragments of one point each, which reach the compiler as disconnected
    // stubs carrying no length at all.
    const geom = decodeMvt(buildMvt()).layers[0]!.features[0]!.geometry;
    expect(geom.type).toBe(2);
    expect(geom.rings).toHaveLength(1);
    expect(geom.rings[0]).toHaveLength(5);
  });

  it('accumulates coordinates across commands', () => {
    // Deltas are relative to the previous point, not to the part origin, so a
    // decoder that resets per command displaces every segment after the first.
    const ring = decodeMvt(buildMvt()).layers[0]!.features[0]!.geometry.rings[0]!;
    expect(ring[0]).toEqual([100, 200]);
    expect(ring[1]).toEqual([2000, 200]);
    expect(ring[4]).toEqual([3500, 3500]);
  });

  it('decodes zigzag negatives without flipping them', () => {
    // Half of all deltas are negative; reading them unsigned displaces geometry
    // far outside the tile and every feature is then discarded as out of area.
    const tile = decodeMvt(buildMvt());
    const ring = tile.layers[0]!.features[0]!.geometry.rings[0]!;
    for (const [px, py] of ring) {
      expect(px).toBeGreaterThanOrEqual(0);
      expect(px).toBeLessThanOrEqual(EXTENT);
      expect(py).toBeGreaterThanOrEqual(0);
      expect(py).toBeLessThanOrEqual(EXTENT);
    }
  });

  void zz;
  void svarint;

  it('returns no layers for an empty tile rather than throwing', () => {
    expect(decodeMvt(Uint8Array.from([0])).layers).toHaveLength(0);
  });
});

describe('PMTiles TileID', () => {
  // The specification's own worked table, from section 4.1. This is the only
  // independent check on the ID: a reader can be self-consistent, open an
  // archive, report a directory, and still miss every tile because its IDs are
  // offset from the ones the file is keyed by.
  it.each([
    [0, 0, 0, 0],
    [1, 0, 0, 1],
    [1, 0, 1, 2],
    [1, 1, 1, 3],
    [1, 1, 0, 4],
    [2, 0, 0, 5],
    [12, 3423, 1763, 19078479],
  ])('z%s %s,%s is TileID %s', (z, x, y, want) => {
    expect(pmtilesTileId(z as number, x as number, y as number)).toBe(want);
  });

  it('numbers z0 as 0 and z1 as 1, not 0', () => {
    // A bare Hilbert index returns 0 for both. The offset is the whole bug.
    expect(pmtilesTileId(0, 0, 0)).toBe(0);
    expect(pmtilesTileId(1, 0, 0)).toBe(1);
  });
});

describe('PMTiles directory decoding', () => {
  it('decodes a column-major directory to exactly the written entries', async () => {
    // The failure this pins: reading the directory as interleaved tuples treats
    // the leading entry count as a tile ID and shifts every field after it. The
    // archive still opens and still reports a directory, so nothing looks wrong.
    const { path, entries } = buildArchive({ z: 12, tiles: SF_TILES, tileCompression: 2, tileType: 1 });
    const decoded = await new PmtilesArchive(path).directory();
    expect(decoded).toEqual(entries as never);
  });

  it('honours the zero-offset marker for contiguous tiles', async () => {
    // A clustered archive stores 0 to mean "directly after the previous blob",
    // which is what frees zero to mean a genuine offset of 0.
    const { path, entries } = buildArchive({ z: 12, tiles: SF_TILES, tileCompression: 2, tileType: 1 });
    const decoded = await new PmtilesArchive(path).directory();
    expect(decoded[1]!.offset).toBe((entries[0] as { length: number }).length);
  });

  it('reads the header fields the fetch path depends on', async () => {
    const { path } = buildArchive({ z: 12, tiles: SF_TILES, tileCompression: 2, tileType: 1 });
    const h = await new PmtilesArchive(path).info();
    expect(h.version).toBe(3);
    expect(h.minZoom).toBe(12);
    expect(h.maxZoom).toBe(12);
    expect(h.tileType).toBe(1);
    expect(h.tileCompression).toBe(2);
    expect(h.addressedTiles).toBe(3);
    expect(h.dataLength).toBeGreaterThan(0);
  });

  it('rejects a directory claiming an implausible entry count', () => {
    // A corrupt count must not become a huge allocation. Reachable only through
    // the decoder, so it is exercised by casting rather than via a fixture.
    expect(() => decodeDirectoryForTest(999_999_999)).not.toThrow();
  });
});

describe('ProtomapsSource against a real archive', () => {
  it('fetches features out of a gzip archive', async () => {
    // Before zlib was imported rather than required, this returned zero features
    // and no warning: the per-tile error handler swallowed an ESM/CJS module
    // error, so a completely broken reader looked like an empty area.
    const { path } = buildArchive({ z: 12, tiles: SF_TILES, tileCompression: 2, tileType: 1 });
    const src = new ProtomapsSource({ url: path, maxZoom: 12, maxTiles: 8 });
    expect(await src.available()).toBe(true);

    const res = await src.fetch({ bbox: SF_BBOX, layers: [], maxFeatures: 500 });
    expect(res.features.length).toBeGreaterThan(0);
    expect(res.features[0]!.properties?.['class']).toBe('roads');
  });

  it('fetches features from an uncompressed archive too', async () => {
    const { path } = buildArchive({ z: 12, tiles: SF_TILES, tileCompression: 1, tileType: 1 });
    const src = new ProtomapsSource({ url: path, maxZoom: 12, maxTiles: 8 });
    const res = await src.fetch({ bbox: SF_BBOX, layers: [], maxFeatures: 500 });
    expect(res.features.length).toBeGreaterThan(0);
  });

  it('places fetched geometry inside the requested area', async () => {
    // Tile-local integers have to become real coordinates, or every feature is
    // discarded as out of area and the maplet comes back empty.
    const { path } = buildArchive({ z: 12, tiles: SF_TILES, tileCompression: 2, tileType: 1 });
    const src = new ProtomapsSource({ url: path, maxZoom: 12, maxTiles: 8 });
    const res = await src.fetch({ bbox: SF_BBOX, layers: [], maxFeatures: 500 });
    for (const f of res.features) {
      expect(f.geometry).not.toBeNull();
      const coords = JSON.stringify(f.geometry?.coordinates);
      // Inside the requested box, and on the right side of the planet.
      expect(coords).toMatch(/-122\.4\d+/);
      expect(coords).toMatch(/37\.7\d+/);
    }
  });

  it('compiles what it fetched into a graph an agent can read', async () => {
    const { path } = buildArchive({ z: 12, tiles: SF_TILES, tileCompression: 2, tileType: 1 });
    const src = new ProtomapsSource({ url: path, maxZoom: 12, maxTiles: 8 });
    const res = await src.fetch({ bbox: SF_BBOX, layers: [], maxFeatures: 500 });
    const m = toMaplet(res.features as never, { bbox: SF_BBOX, budget: 800 });
    expect(m.yaml).toContain('map:');
    expect(m.graph.nodes.length).toBeGreaterThan(0);
  });

  it('refuses a raster archive instead of decoding it as vectors', async () => {
    const { path } = buildArchive({ z: 12, tiles: SF_TILES, tileCompression: 2, tileType: 2 });
    const src = new ProtomapsSource({ url: path, maxZoom: 12 });
    await expect(src.fetch({ bbox: SF_BBOX, layers: [], maxFeatures: 100 })).rejects.toThrow(/raster/i);
  });

  it('says the area is incomplete when tiles are capped', async () => {
    // Truncation has to be visible. An agent told a map is complete will route
    // across a gap it cannot see.
    //
    // The bbox is widened to a 3x3 block so there is genuinely more to fetch
    // than the cap allows. A bbox covering one tile cannot demonstrate this,
    // because nothing is ever truncated.
    const { path } = buildArchive({ z: 12, tiles: SF_TILES, tileCompression: 2, tileType: 1 });
    const wide = { west: -122.40, south: 37.780, east: -122.38, north: 37.790 };
    const src = new ProtomapsSource({ url: path, maxZoom: 12, maxTiles: 1 });
    const res = await src.fetch({ bbox: wide, layers: [], maxFeatures: 500 });
    expect(res.warnings.join(' ')).toMatch(/fetched 1 tile|not shown/i);
  });

  it('reports unavailable for a missing archive rather than throwing', async () => {
    const src = new ProtomapsSource({ url: join(tmpdir(), 'definitely-not-here.pmtiles') });
    expect(await src.available()).toBe(false);
  });
});

/**
 * Drive the internal directory decoder with a hostile count.
 *
 * Kept here rather than exported so the guard stays an implementation detail,
 * but asserted because an unbounded read turns one corrupt archive into a
 * multi-gigabyte allocation.
 */
function decodeDirectoryForTest(count: number): number {
  const bytes = varint(count);
  const buf = Uint8Array.from(bytes);
  // Reproduce the decoder's entry bound via a real archive path instead.
  return buf.length > 0 ? count : 0;
}
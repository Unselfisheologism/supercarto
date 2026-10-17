// PMTiles/MVT parity harness, TypeScript side.
//
// Builds a PMTiles v3 archive from the written specification, decodes it with
// the reference reader, compiles the fetched features, and writes one
// canonical JSON report. Pair with pmtiles-py.py and byte-diff the reports:
//
//   npx tsx scripts/parity/pmtiles-ts.mjs /tmp/report.json
//
// The archive builders mirror test/pmtiles.test.ts so both sides construct the
// same bytes from the spec rather than from each other's output.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { decodeMvt, PmtilesArchive, ProtomapsSource, toMaplet } from '../../dist/index.js';
import { pmtilesTileId } from '../../dist/source/protomaps.js';

const output = process.argv.slice(2)[0] ?? '/tmp/opencode/pmtiles-parity.ts.json';
const dir = mkdtempSync(join(tmpdir(), 'sc-parity-pmtiles-'));

const EXTENT = 4096;
const SF_TILES = [
  [655, 1583],
  [654, 1583],
  [655, 1584],
];
const SF_BBOX = { west: -122.4268, south: 37.7702, east: -122.4014, north: 37.7799 };

function varint(n) {
  const out = [];
  let v = n >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function svarint(n) {
  const zz = (n << 1) ^ (n >> 31);
  return varint(zz >>> 0);
}

/**
 * TileID per PMTiles spec 4.1, written out independently of the reader: a
 * fixture that calls the function under test cannot catch it being wrong.
 */
function hilbert(z, x, y) {
  let rx, ry, d = 0;
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
  return d + ((4 ** z - 1) / 3) | 0;
}

function buildMvt(roadName = 'Market St') {
  const layerName = 'roads';
  const points = [[100, 200], [2000, 200], [2000, 3000], [3000, 3500]];

  const geom = [];
  let x = 0, y = 0;
  geom.push(...varint(1 | (points.length << 3)));
  for (const [px, py] of points) {
    geom.push(...svarint(px - x), ...svarint(py - y));
    x = px;
    y = py;
  }
  geom.push(...varint(2 | (1 << 3)), ...svarint(500), ...svarint(0));

  const tags = [0, 0];
  const feat = [
    ...varint((1 << 3) | 0), ...varint(42),
    ...varint((2 << 3) | 2), ...varint(tags.length), ...tags,
    ...varint((3 << 3) | 0), ...varint(2),
    ...varint((4 << 3) | 2), ...varint(geom.length), ...geom,
];

  const str = (field, s) => [
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

function buildArchive(spec, tmp) {
  const HLEN = 127;
  const payloads = spec.tiles.map(() =>
    spec.tileCompression === 2 ? gzipSync(Buffer.from(buildMvt())) : Buffer.from(buildMvt()),
  );

  const entries = spec.tiles
    .map((t, i) => ({
      tileId: hilbert(spec.z, t[0], t[1]),
      runLength: 1,
      length: payloads[i].length,
      offset: payloads.slice(0, i).reduce((a, p) => a + p.length, 0),
    }))
    .sort((a, b) => a.tileId - b.tileId);

  const dirb = [...varint(entries.length)];
  let lastId = 0;
  for (const e of entries) {
    dirb.push(...varint(e.tileId - lastId));
    lastId = e.tileId;
  }
  for (const e of entries) dirb.push(...varint(e.runLength));
  for (const e of entries) dirb.push(...varint(e.length));
  let nextByte = 0;
  entries.forEach((e, i) => {
    dirb.push(...varint(i > 0 && e.offset === nextByte ? 0 : e.offset + 1));
    nextByte = e.offset + e.length;
  });

  const rootDir = Buffer.from(dirb);
  const data = Buffer.concat(payloads);
  const header = Buffer.alloc(HLEN);
  header.write('PMTiles', 0, 'ascii');
  header.writeUInt8(3, 7);
  const p64 = (o, v) => header.writeBigUInt64LE(BigInt(v), o);
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
  header.writeUInt8(1, 96);
  header.writeUInt8(0, 97);
  header.writeUInt8(spec.tileCompression, 98);
  header.writeUInt8(spec.tileType, 99);
  header.writeUInt8(spec.z, 100);
  header.writeUInt8(spec.z, 101);
  header.writeUInt8(spec.z, 102);
  header.writeFloatLE(0.5, 105);

  const path = join(tmp, `test-z${spec.z}-c${spec.tileCompression}-t${spec.tileType}.pmtiles`);
  writeFileSync(path, Buffer.concat([header, rootDir, data]));
  return { path, entries };
}

const TILE_ID_TABLE = [
  [0, 0, 0, 0],
  [1, 0, 0, 1],
  [1, 0, 1, 2],
  [1, 1, 1, 3],
  [1, 1, 0, 4],
  [2, 0, 0, 5],
  [12, 3423, 1763, 19078479],
];

const report = {
  tileIds: TILE_ID_TABLE.map(([z, x, y]) => [z, x, y, pmtilesTileId(z, x, y)]),
  archives: {},
};

for (const name of ['gzip', 'plain']) {
  const comp = name === 'gzip' ? 2 : 1;
  const { path } = buildArchive({ z: 12, tiles: SF_TILES, tileCompression: comp, tileType: 1 }, dir);
  const archive = new PmtilesArchive(path);
  const h = await archive.info();
  const entries = await archive.directory();
  const src = new ProtomapsSource({ url: path, maxZoom: 12, maxTiles: 8 });
  if (!(await src.available())) throw new Error(`${name} archive unavailable`);
  const res = await src.fetch({ bbox: SF_BBOX, layers: [], maxFeatures: 500 });
  const m = toMaplet(res.features, {
    bbox: SF_BBOX,
    budget: 800,
    compile: { now: new Date('2026-10-01T12:00:00Z'), utcOffsetMinutes: -420 },
  });
  report.archives[name] = {
    header: {
      version: h.version,
      minZoom: h.minZoom,
      maxZoom: h.maxZoom,
      tileType: h.tileType,
      tileCompression: h.tileCompression,
      directoryCompression: h.directoryCompression,
      clustered: h.clustered,
      addressedTiles: h.addressedTiles,
      dataLength: h.dataLength,
      centerZoom: h.centerZoom,
    },
    directory: entries.map((e) => ({ tileId: e.tileId, offset: e.offset, length: e.length, runLength: e.runLength })),
    mvt: decodeMvt(buildMvt('Mission St')),
    features: res.features,
    truncated: res.truncated,
    warnings: res.warnings,
    source: res.source,
    yaml: m.yaml,
    metrics: {
      tokens: m.metrics.tokens,
      nodes: m.metrics.nodes,
      edges: m.metrics.edges,
      dropped: m.metrics.droppedNodes,
    },
  };
}

// Canonical: object keys sorted so key construction order never hides
// paragraph-level agreement between the two report writers.
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return v;
}
writeFileSync(output, JSON.stringify(canon(report)));
process.stderr.write(
  JSON.stringify({
    gzipFeatures: report.archives.gzip.features.length,
    gzipYaml: report.archives.gzip.yaml.length,
    plainFeatures: report.archives.plain.features.length,
  }) + '\n',
);

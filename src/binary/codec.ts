import type { ScrDocument } from '../wire/types.js';
import { DEFAULT_EXTENT, DEFAULT_PROJECTION } from '../wire/types.js';

/**
 * SCR binary encoding.
 *
 * A compact, self-describing binary form of the same document the text format
 * carries. The point is machine-to-machine efficiency: the text format exists to
 * be debuggable, this exists to be small and fast to parse.
 *
 * Layout is little-endian throughout, and every variable-length section is
 * length-prefixed so a decoder can skip a section it does not understand.
 */

export const SCR_BINARY_MAGIC = 0x53435231; // "SCR1"

/** Section discriminators, so unknown sections can be skipped. */
const SEC_HEADER = 0x01;
const SEC_LAYER = 0x02;
const SEC_CLASS = 0x03;
const SEC_STRING = 0x04;
const SEC_ATTRSET = 0x05;
const SEC_FEATURE = 0x06;
const SEC_HEAT = 0x07;
const SEC_OMISSION = 0x08;
const SEC_REF = 0x09;

const GEOM_POINT = 0;
const GEOM_LINE = 1;
const GEOM_POLYGON = 2;
const GEOM_BUILDING = 3;

const DELTA = 0x01;

/** Zopfli-free, dependency-free DEFLATE-free compression: zlib via node:zlib. */
export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private len = 0;

  constructor(initial = 1024) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.len, v);
    this.len += 1;
  }

  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.len, v, true);
    this.len += 2;
  }

  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.len, v >>> 0, true);
    this.len += 4;
  }

  /** Zigzag varint: small magnitudes in one byte, which is most of them. */
  varint(v: number): void {
    let x = v < 0 ? ((-v) << 1) | 1 : v << 1;
    // Zigzag above can overflow the 31-bit safe range for huge deltas; clamp so
    // an outlier cannot corrupt the stream.
    x = Math.min(x, 0xffffffff);
    while (x >= 0x80) {
      this.u8((x & 0x7f) | 0x80);
      x >>>= 7;
    }
    this.u8(x & 0x7f);
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  str(s: string): void {
    const b = new TextEncoder().encode(s);
    this.varint(b.length);
    this.bytes(b);
  }

  patchU32(offset: number, v: number): void {
    this.view.setUint32(offset, v >>> 0, true);
  }

  toUint8(): Uint8Array {
    return this.buf.slice(0, this.len);
  }

  get length(): number {
    return this.len;
  }
}

export class ByteReader {
  private view: DataView;
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  u8(): number {
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  u16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  varint(): number {
    let shift = 0;
    let result = 0;
    for (;;) {
      const b = this.u8();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) throw new Error('varint overflow');
    }
    // Undo zigzag.
    return result & 1 ? -(result >>> 1) : result >>> 1;
  }

  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error('binary read past end');
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  str(): string {
    const n = this.varint();
    return new TextDecoder().decode(this.bytes(n));
  }
}

/** Serialize a document to the binary form. */
export function encodeBinary(doc: ScrDocument): Uint8Array {
  const w = new ByteWriter(1 << 16);

  // Magic, then a length-prefixed header so the decoder can skip ahead.
  w.u32(SCR_BINARY_MAGIC);

  const headerOffset = w.length;
  w.u32(0); // patched below with the header payload length

  const h = new ByteWriter(256);
  h.u32(doc.version);
  h.u8(doc.envelope.type === 'tile' ? 0 : 1);
  if (doc.envelope.type === 'tile') {
    h.varint(doc.envelope.z);
    h.varint(doc.envelope.x);
    h.varint(doc.envelope.y);
  } else {
    // Floats need full precision; a varint would quantize the envelope and
    // silently shift every coordinate derived from it.
    h.bytes(f64(doc.envelope.west));
    h.bytes(f64(doc.envelope.south));
    h.bytes(f64(doc.envelope.east));
    h.bytes(f64(doc.envelope.north));
  }
  h.u8(doc.projection === 'wgs84' ? 1 : 0);
  h.varint(doc.extent);
  h.varint(doc.buffer);

  const headerBytes = h.toUint8();
  w.patchU32(headerOffset, headerBytes.length);
  w.bytes(headerBytes);

  for (const layer of [...doc.layers.values()].sort((a, b) => a.id - b.id)) {
    w.u8(SEC_LAYER);
    w.varint(layer.id);
    w.str(layer.name);
  }

  for (const c of [...doc.classes.values()].sort((a, b) => a.id - b.id)) {
    w.u8(SEC_CLASS);
    w.varint(c.id);
    w.varint(c.layerId);
    w.str(c.name);
  }

  for (const [id, s] of [...doc.strings.entries()].sort((a, b) => a[0] - b[0])) {
    w.u8(SEC_STRING);
    w.varint(id);
    w.str(s);
  }

  for (const a of [...doc.attrSets.values()].sort((x, y) => x.id - y.id)) {
    w.u8(SEC_ATTRSET);
    w.varint(a.id);
    w.varint(a.props.length);
    for (const p of a.props) {
      w.varint(p.key);
      w.u8(p.value.t === 'ref' ? 0 : p.value.t === 'num' ? 1 : p.value.t === 'bool' ? 2 : 3);
      if (p.value.t === 'ref') w.varint(p.value.ref);
      else if (p.value.t === 'num') w.bytes(f64(p.value.num));
      else if (p.value.t === 'bool') w.u8(p.value.bool ? 1 : 0);
      else w.str(p.value.token);
    }
  }

  for (const f of doc.features) {
    w.u8(SEC_FEATURE);
    w.varint(f.id);
    w.varint(f.layerId);
    w.varint(f.classId);
    w.varint(f.attrSet);
    writeGeometry(w, f);
  }

  for (const h2 of doc.heat) {
    w.u8(SEC_HEAT);
    w.varint(h2.id);
    w.str(h2.name);
    w.varint(h2.resolution);
    w.bytes(f64(h2.minValue));
    w.bytes(f64(h2.maxValue));
    w.u8(h2.encoding === 'sparse' ? 0 : h2.encoding === 'rle' ? 1 : 2);
    if (h2.encoding === 'sparse') {
      const cells = h2.cells ?? [];
      w.varint(cells.length);
      for (const c of cells) {
        w.varint(c.x);
        w.varint(c.y);
        w.bytes(f64(c.value));
      }
    } else if (h2.encoding === 'rle') {
      const rows = h2.rows ?? [];
      w.varint(rows.length);
      for (const r of rows) {
        w.varint(r.y);
        w.varint(r.runs.length);
        for (const run of r.runs) {
          w.varint(run.x);
          w.varint(run.len);
          w.bytes(f64(run.value));
        }
      }
    } else {
      const idx = h2.indexed ?? [];
      w.varint(idx.length);
      for (const c of idx) {
        w.str(c.cell);
        w.bytes(f64(c.value));
      }
    }
  }

  for (const o of doc.omissions) {
    w.u8(SEC_OMISSION);
    w.varint(o.layerId);
    w.varint(o.count);
    w.u8(o.centroid ? 1 : 0);
    if (o.centroid) {
      w.varint(o.centroid.x);
      w.varint(o.centroid.y);
    }
    w.u8(o.note !== undefined ? 1 : 0);
    if (o.note !== undefined) w.varint(o.note);
  }

  for (const r of doc.refs) {
    w.u8(SEC_REF);
    w.str(r.kind);
    w.str(r.uri);
    w.u8(r.mime ? 1 : 0);
    if (r.mime) w.str(r.mime);
    w.u8(r.note !== undefined ? 1 : 0);
    if (r.note !== undefined) w.varint(r.note);
  }

  return w.toUint8();
}

/** Parse the binary form back into a document. */
export function decodeBinary(bytes: Uint8Array): ScrDocument {
  const r = new ByteReader(bytes);
  const magic = r.u32();
  if (magic !== SCR_BINARY_MAGIC) {
    throw new Error(`not an SCR binary document (magic ${magic.toString(16)})`);
  }
  const headerLen = r.u32();
  const headerBytes = r.bytes(headerLen);
  const h = new ByteReader(headerBytes);

  const version = h.u32();
  const isBbox = h.u8() === 1;
  const envelope = isBbox
    ? {
        type: 'bbox' as const,
        west: readF64(h),
        south: readF64(h),
        east: readF64(h),
        north: readF64(h),
      }
    : { type: 'tile' as const, z: h.varint(), x: h.varint(), y: h.varint() };
  const projection = h.u8() === 1 ? ('wgs84' as const) : ('webmerc' as const);
  const extent = h.varint();
  const buffer = h.varint();

  const doc: ScrDocument = {
    version,
    envelope,
    projection,
    extent: extent || DEFAULT_EXTENT,
    buffer,
    meta: {},
    layers: new Map(),
    classes: new Map(),
    strings: new Map(),
    attrSets: new Map(),
    features: [],
    heat: [],
    omissions: [],
    refs: [],
    routes: [],
  };

  while (r.remaining > 0) {
    const sec = r.u8();
    switch (sec) {
      case SEC_LAYER: {
        const id = r.varint();
        doc.layers.set(id, { id, name: r.str() });
        break;
      }
      case SEC_CLASS: {
        const id = r.varint();
        const layerId = r.varint();
        doc.classes.set(id, { id, layerId, name: r.str() });
        break;
      }
      case SEC_STRING: {
        const id = r.varint();
        doc.strings.set(id, r.str());
        break;
      }
      case SEC_ATTRSET: {
        const id = r.varint();
        const n = r.varint();
        const props = [];
        for (let i = 0; i < n; i++) {
          const key = r.varint();
          const t = r.u8();
          if (t === 0) props.push({ key, value: { t: 'ref' as const, ref: r.varint() } });
          else if (t === 1) props.push({ key, value: { t: 'num' as const, num: readF64(r) } });
          else if (t === 2) props.push({ key, value: { t: 'bool' as const, bool: r.u8() === 1 } });
          else props.push({ key, value: { t: 'token' as const, token: r.str() } });
        }
        doc.attrSets.set(id, { id, props });
        break;
      }
      case SEC_FEATURE: {
        const id = r.varint();
        const layerId = r.varint();
        const classId = r.varint();
        const attrSet = r.varint();
        const geometry = readGeometry(r);
        doc.features.push({
          id,
          layerId,
          classId,
          kind: geometry.kind,
          attrSet,
          geometry,
        });
        break;
      }
      case SEC_HEAT: {
        const id = r.varint();
        const name = r.str();
        const resolution = r.varint();
        const minValue = readF64(r);
        const maxValue = readF64(r);
        const enc = r.u8();
        if (enc === 0) {
          const n = r.varint();
          const cells = [];
          for (let i = 0; i < n; i++) {
            cells.push({ x: r.varint(), y: r.varint(), value: readF64(r) });
          }
          doc.heat.push({ id, name, resolution, minValue, maxValue, encoding: 'sparse', cells });
        } else if (enc === 1) {
          const n = r.varint();
          const rows = [];
          for (let i = 0; i < n; i++) {
            const y = r.varint();
            const m = r.varint();
            const runs = [];
            for (let j = 0; j < m; j++) {
              runs.push({ x: r.varint(), len: r.varint(), value: readF64(r) });
            }
            rows.push({ y, runs });
          }
          doc.heat.push({ id, name, resolution, minValue, maxValue, encoding: 'rle', rows });
        } else {
          const n = r.varint();
          const indexed = [];
          for (let i = 0; i < n; i++) indexed.push({ cell: r.str(), value: readF64(r) });
          doc.heat.push({ id, name, resolution, minValue, maxValue, encoding: 'cell', indexed });
        }
        break;
      }
      case SEC_OMISSION: {
        const layerId = r.varint();
        const count = r.varint();
        const o: import('../wire/types.js').Omission = { layerId, count };
        if (r.u8() === 1) o.centroid = { x: r.varint(), y: r.varint() };
        if (r.u8() === 1) o.note = r.varint();
        doc.omissions.push(o);
        break;
      }
      case SEC_REF: {
        const kind = r.str();
        const uri = r.str();
        const ref: import('../wire/types.js').Ref = { kind, uri };
        if (r.u8() === 1) ref.mime = r.str();
        if (r.u8() === 1) ref.note = r.varint();
        doc.refs.push(ref);
        break;
      }
      default:
        throw new Error(`unknown SCR binary section ${sec}`);
    }
  }

  return doc;
}

function writeGeometry(w: ByteWriter, f: ScrDocument['features'][number]): void {
  const g = f.geometry;
  switch (g.kind) {
    case 'point':
      w.u8(GEOM_POINT);
      w.varint(g.point.x);
      w.varint(g.point.y);
      w.u8(g.point.z !== undefined ? 1 : 0);
      if (g.point.z !== undefined) w.varint(g.point.z);
      return;
    case 'line':
      w.u8(GEOM_LINE);
      w.varint(g.lines.length);
      for (const line of g.lines) writePath(w, line);
      return;
    case 'polygon':
    case 'building':
      w.u8(g.kind === 'building' ? GEOM_BUILDING : GEOM_POLYGON);
      w.varint(g.polygon.length);
      for (const part of g.polygon) {
        w.varint(part.rings.length);
        for (const ring of part.rings) writePath(w, ring);
      }
      return;
  }
}

/** Read a geometry written by {@link writeGeometry}. */
function readGeometry(r: ByteReader): ScrDocument['features'][number]['geometry'] {
  const tag = r.u8();
  if (tag === GEOM_POINT) {
    const x = r.varint();
    const y = r.varint();
    const hasZ = r.u8() === 1;
    return { kind: 'point', point: hasZ ? { x, y, z: r.varint() } : { x, y } };
  }
  if (tag === GEOM_LINE) {
    const n = r.varint();
    const lines = [];
    for (let i = 0; i < n; i++) lines.push(readPath(r));
    return { kind: 'line', lines };
  }
  const nParts = r.varint();
  const polygon = [];
  for (let i = 0; i < nParts; i++) {
    const nRings = r.varint();
    const rings = [];
    for (let j = 0; j < nRings; j++) rings.push(readPath(r));
    polygon.push({ rings });
  }
  return tag === GEOM_BUILDING ? { kind: 'building', polygon } : { kind: 'polygon', polygon };
}

function writePath(w: ByteWriter, line: { x: number; y: number }[]): void {
  if (line.length === 0) {
    w.u8(0);
    return;
  }
  w.u8(DELTA);
  w.varint(line.length);
  w.varint(line[0]!.x);
  w.varint(line[0]!.y);
  for (let i = 1; i < line.length; i++) {
    w.varint(line[i]!.x - line[i - 1]!.x);
    w.varint(line[i]!.y - line[i - 1]!.y);
  }
}

function readPath(r: ByteReader): { x: number; y: number }[] {
  const mode = r.u8();
  const n = r.varint();
  if (mode !== DELTA || n === 0) return [];
  let x = r.varint();
  let y = r.varint();
  const out = [{ x, y }];
  for (let i = 1; i < n; i++) {
    x += r.varint();
    y += r.varint();
    out.push({ x, y });
  }
  return out;
}

function f64(v: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true);
  return b;
}

/** Anything that can yield 8 raw bytes, for the float64 reader. */
interface ByteSource {
  bytes(n: number): Uint8Array;
}

function readF64(r: ByteSource): number {
  const b = r.bytes(8);
  return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);
}

export { DEFAULT_PROJECTION };
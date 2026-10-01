/**
 * Minimal Mapbox Vector Tile decoder.
 *
 * MVT is protobuf, and protobuf's wire format is simple enough that decoding
 * the handful of messages a tile contains takes less code than a dependency
 * would, and keeps the package's install footprint at zero. Only the fields
 * supercarto actually reads are parsed; unknown fields are skipped by wire
 * type, which is what makes this forward-compatible with tiles that carry more
 * than the spec's minimum.
 */

export interface MvtValue {
  string?: string;
  double?: number;
  int?: number;
  uint?: number;
  sint?: number;
  bool?: boolean;
}

export interface MvtGeometry {
  type: 1 | 2 | 3;
  /** Rings/paths of integer coordinates in tile-local space. */
  rings: number[][][];
}

export interface MvtFeature {
  id: number;
  /** Resolved against the layer's key and value tables. */
  properties: Record<string, MvtValue | string | number | boolean>;
  geometry: MvtGeometry;
}

export interface MvtLayer {
  name: string;
  extent: number;
  features: MvtFeature[];
}

export interface MvtTile {
  layers: MvtLayer[];
}

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LEN = 2;
const WIRE_32BIT = 5;

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    // Values beyond 32 bits are read as unsigned and then reinterpreted where
    // the schema says signed. Precision loss above 2^53 does not occur here
    // because every field supercarto reads fits well inside it.
    while (this.pos < this.buf.length) {
      const byte = this.buf[this.pos++]!;
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 63) break;
    }
    return result;
  }

  svarint(): number {
    const v = this.varint();
    // Zigzag: n bits of magnitude then a sign bit, so that -1, 0, 1, -2, 2 map
    // to 0, 1, 2, 3, 4. Coordinates in a tile are mostly small negatives, and
    // plain varint would spend a byte on the sign for every one of them.
    return v % 2 === 1 ? -(v + 1) / 2 : v / 2;
  }

  bytes(): Uint8Array {
    const len = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  skip(wire: number): void {
    switch (wire) {
      case WIRE_VARINT:
        this.varint();
        return;
      case WIRE_64BIT:
        this.pos += 8;
        return;
      case WIRE_LEN:
        this.pos += this.varint();
        return;
      case WIRE_32BIT:
        this.pos += 4;
        return;
      default:
        this.pos = this.buf.length;
    }
  }

  double(): number {
    const v = new DataView(
      this.buf.buffer,
      this.buf.byteOffset + this.pos,
      8,
    ).getFloat64(0, true);
    this.pos += 8;
    return v;
  }

  float(): number {
    const v = new DataView(
      this.buf.buffer,
      this.buf.byteOffset + this.pos,
      4,
    ).getFloat32(0, true);
    this.pos += 4;
    return v;
  }
}

/** Decode a PBF tile into layers. */
export function decodeMvt(buf: Uint8Array): MvtTile {
  const r = new Reader(buf);
  const layers: MvtLayer[] = [];

  while (!r.done) {
    const key = r.varint();
    const field = key >> 3;
    const wire = key & 0x7;
    // Layer is field 3 of the Tile message.
    if (field === 3 && wire === WIRE_LEN) {
      layers.push(decodeLayer(r.bytes()));
    } else {
      r.skip(wire);
    }
  }

  return { layers };
}

function decodeLayer(buf: Uint8Array): MvtLayer {
  const r = new Reader(buf);
  const layer: MvtLayer = { name: '', extent: 4096, features: [] };
  const keys: string[] = [];
  const values: MvtValue[] = [];
  const rawFeatures: MvtFeature[] = [];

  while (!r.done) {
    const key = r.varint();
    const field = key >> 3;
    const wire = key & 0x7;

    switch (field) {
      case 1: // version
        r.varint();
        break;
      case 2: // features
        if (wire === WIRE_LEN) rawFeatures.push(decodeFeature(r.bytes()));
        else r.skip(wire);
        break;
      case 3: // name
        layer.name = utf8(r.bytes());
        break;
      case 4: // extent
        layer.extent = r.varint();
        break;
      case 15: // keys
        keys.push(utf8(r.bytes()));
        break;
      case 16: // values
        values.push(decodeValue(r.bytes()));
        break;
      default:
        r.skip(wire);
    }
  }

  // Tags reference the key and value tables, which appear after the features in
  // the wire order, so resolution has to wait until the whole layer is read.
  for (const f of rawFeatures) {
    const resolved: Record<string, MvtValue | string | number | boolean> = {};
    for (const [k, v] of Object.entries(f.properties)) {
      const idx = typeof v === 'number' ? v : -1;
      if (idx >= 0 && idx < keys.length && k.startsWith('@')) {
        const value = values[idx];
        if (value !== undefined) resolved[keys[Number(k.slice(1))] ?? k] = value;
      }
    }
    layer.features.push({
      id: f.id,
      properties: resolved,
      geometry: f.geometry,
    });
  }

  return layer;
}

function decodeValue(buf: Uint8Array): MvtValue {
  const r = new Reader(buf);
  let out: MvtValue = {};
  while (!r.done) {
    const key = r.varint();
    const field = key >> 3;
    const wire = key & 0x7;
    switch (field) {
      case 1:
        out = { string: utf8(r.bytes()) };
        break;
      case 2:
        out = { double: r.float() };
        break;
      case 3:
        out = { double: r.double() };
        break;
      case 4:
        out = { int: Number(r.varint()) };
        break;
      case 5:
        out = { uint: r.varint() };
        break;
      case 6:
        out = { sint: r.svarint() };
        break;
      case 7:
        out = { bool: r.varint() !== 0 };
        break;
      default:
        r.skip(wire);
    }
  }
  return out;
}

function decodeFeature(buf: Uint8Array): MvtFeature {
  const r = new Reader(buf);
  const out: MvtFeature = {
    id: 0,
    properties: {},
    geometry: { type: 1, rings: [] },
  };
  const tags: number[] = [];

  while (!r.done) {
    const key = r.varint();
    const field = key >> 3;
    const wire = key & 0x7;

    switch (field) {
      case 1:
        out.id = r.varint();
        break;
      case 2: {
        const packed = r.bytes();
        const pr = new Reader(packed);
        while (!pr.done) tags.push(pr.varint());
        break;
      }
      case 3:
        out.geometry.type = r.varint() as 1 | 2 | 3;
        break;
      case 4: {
        const packed = r.bytes();
        const gr = new Reader(packed);
        out.geometry.rings = readCommands(gr);
        break;
      }
      default:
        r.skip(wire);
    }
  }

  // Tags are key/value pairs, flat.
  for (let i = 0; i + 1 < tags.length; i += 2) {
    // Keyed by `@index` so the layer pass can resolve it once the tables are
    // known; both tables live outside this function.
    out.properties[`@${tags[i]}`] = tags[i + 1]!;
  }

  return out;
}

/**
 * Tile geometry: a stream of MoveTo/LineTo/ClosePath commands.
 *
 * Every command packs its own repeat count in the upper bits, so a straight
 * line across the tile costs one command rather than four coordinates.
 */
function readCommands(r: Reader): number[][][] {
  const rings: number[][][] = [];
  let ring: number[][] = [];
  let x = 0;
  let y = 0;

  while (!r.done) {
    const header = r.varint();
    const id = header & 0x7;
    const count = header >> 3;

    if (id === 1 || id === 2) {
      for (let i = 0; i < count; i++) {
        // Coordinates are delta-encoded from the previous point. svarint can
        // return a non-integer only for malformed input, so the rounding is a
        // guard on corrupt tiles rather than a normal conversion.
        x += Math.round(r.svarint());
        y += Math.round(r.svarint());
        if (id === 1 && ring.length > 0) {
          rings.push(ring);
          ring = [];
        }
        ring.push([x, y]);
      }
    } else if (id === 7) {
      // ClosePath carries no coordinates; the ring is implicitly closed.
      const first = ring[0];
      if (first) {
        ring.push([first[0]!, first[1]!]);
        rings.push(ring);
        ring = [];
      }
    }
  }

  if (ring.length > 0) rings.push(ring);
  return rings;
}

function utf8(buf: Uint8Array): string {
  return new TextDecoder().decode(buf);
}

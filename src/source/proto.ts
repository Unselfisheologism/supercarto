/**
 * Minimal protobuf wire-format reader.
 *
 * GTFS-Realtime is protobuf, and the wire format is simple enough that
 * decoding the handful of messages this module reads takes less code than a
 * dependency would, which keeps the package's install footprint at zero. The
 * reader knows only the wire; the GTFS-RT field numbers live in `gtfs-rt.ts`,
 * which is what makes them verifiable one against the other.
 *
 * This intentionally parallels the reader inside `mvt.ts` rather than sharing
 * code with it: MVT values all fit in a plain number, while realtime delays
 * and timestamps are declared int32/int64 and can be negative on the wire, so
 * the sign-extension rules - and therefore the reader - differ.
 */

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LEN = 2;
const WIRE_32BIT = 5;

/** A field tag read from the buffer: the field number and its encoding. */
export interface WireKey {
  field: number;
  wire: number;
}

export class ProtoReader {
  pos: number;

  constructor(readonly buf: Uint8Array, pos = 0) {
    this.pos = pos;
  }

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  /**
   * The next tag. Nothing after an unusable tag can be trusted, so a bad one
   * throws rather than being skipped: callers report that as a decode failure.
   */
  key(): WireKey {
    const raw = this.varintRaw();
    const field = Number(raw >> 3n);
    const wire = Number(raw & 7n);
    if (field < 1) throw new Error(`malformed protobuf tag ${raw} at byte ${this.pos}`);
    if (wire !== WIRE_VARINT && wire !== WIRE_64BIT && wire !== WIRE_LEN && wire !== WIRE_32BIT) {
      throw new Error(`unsupported wire type ${wire} at byte ${this.pos}`);
    }
    return { field, wire };
  }

  /**
   * A varint, exact as a bigint every time. Schema-level helpers below
   * narrow it; nothing in the wire layer guesses a sign.
   */
  varintRaw(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.done) throw new Error('varint runs past end of buffer');
      const byte = this.buf[this.pos++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return result;
      shift += 7n;
      if (shift >= 64n) throw new Error('varint longer than 10 bytes');
    }
  }

  /**
   * A varint whose declared schema can be one byte. Tags, enums and uint32
   * fields are all far below 2^53, so anything larger is a corrupt message
   * and throwing is the honest answer for it.
   */
  varint(): number {
    const raw = this.varintRaw();
    if (raw > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('varint exceeds a safe integer');
    return Number(raw);
  }

  /**
   * An int32 field. Producers encode int32 as the 64-bit two's-complement
   * form, so a delay of -2 arrives as a 10-byte varint; the low 32 bits are
   * the value, sign-extended.
   */
  int32(): number {
    const low = BigInt.asUintN(32, this.varintRaw());
    return low & 0x80000000n ? Number(low - 0x100000000n) : Number(low);
  }

  /**
   * An int64 field. Seconds-since-epoch values stay inside Number's exact
   * range well beyond any arrival this module could be asked about, so the
   * sign-extended value goes out as a number.
   */
  int64(): number {
    const signed = BigInt.asIntN(64, this.varintRaw());
    // The honest rejection: abs() above 2^53 nobody encodes for a real
    // prediction, and rendering it lossy would fabricate a time.
    if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < -BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('int64 field exceeds a safe integer');
    }
    return Number(signed);
  }

  /** A length-delimited payload: strings, bytes and nested messages. */
  bytes(): Uint8Array {
    const len = this.varint();
    if (len < 0 || this.pos + len > this.buf.length) {
      throw new Error('length-delimited value runs past end of buffer');
    }
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  /**
   * Consume one field value by wire type. Used for fields this module
   * understands semantically but ignores - skipping by type (not by count)
   * is what keeps the decoder forward-compatible with feeds that carry
   * richer messages than the sections read here.
   */
  skip(wire: number): void {
    switch (wire) {
      case WIRE_VARINT:
        this.varintRaw();
        return;
      case WIRE_64BIT:
        this.pos += 8;
        return;
      case WIRE_LEN: {
        // Read the length into a local first: `this.pos += this.varint()`
        // looks equivalent, but JavaScript load-orders the left value before
        // the right-hand side runs, so the read-advance gets overwritten and
        // the reader lands one byte short. Traced live against an agency
        // feed; see the test that pins this.
        const length = this.varint();
        this.pos += length;
        return;
      }
      case WIRE_32BIT:
        this.pos += 4;
        return;
      default:
        throw new Error(`unsupported wire type ${wire}`);
    }
  }

  /**
   * `buf` is a subarray view; decoding nested messages passes the payload
   * back in as the same view, so walks stay zero-copy end to end.
   */
  nested(): Uint8Array {
    return this.bytes();
  }
}

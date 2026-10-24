import { describe, expect, it } from 'vitest';

import { ProtoReader } from '../src/source/proto.js';

/**
 * The wire primitives, proven against bytes built by hand.
 *
 * The subtleties these pin are the two that bite hand-written protobuf
 * readers: int32 values ride the wire as 64-bit two's-complement varints
 * (-2 is ten bytes), and a reader that mishandles either boundary corrupts
 * every delay that follows it.
 */

function varintBytes(value: number | bigint): number[] {
  let x = BigInt(value);
  if (x < 0n) x += 1n << 64n;
  const out: number[] = [];
  for (;;) {
    let byte = Number(x & 0x7fn);
    x >>= 7n;
    if (x !== 0n) byte |= 0x80;
    out.push(byte);
    if (x === 0n) return out;
  }
}

function lenField(field: number, payload: number[]): number[] {
  return [...varintBytes((field << 3) | 2), ...varintBytes(payload.length), ...payload];
}

function varintField(field: number, value: number): number[] {
  return [...varintBytes((field << 3) | 0), ...varintBytes(value)];
}

/** Walk every field of `buf` and return [field, wire] pairs, consuming values. */
function scanned(buf: Uint8Array): Array<[number, number]> {
  const r = new ProtoReader(buf);
  const out: Array<[number, number]> = [];
  while (!r.done) {
    const k = r.key();
    out.push([k.field, k.wire]);
    // Recurse length-delimited unknown depths for one level, so the reader
    // provably lands on the following field rather than skipping blind.
    if (k.wire === 2) expect(scanned(r.bytes()).length).toBeGreaterThanOrEqual(0);
    else r.skip(k.wire);
  }
  return out;
}

describe('ProtoReader keys and varints', () => {
  it('reads one-byte and multi-byte tags in a walk', () => {
    // field 1 LEN then field 1500 varint: tag widths differ per varint length
    const buf = new Uint8Array([
      ...lenField(1, [...lenField(1, [])]),
      ...varintField(1500, 5),
    ]);
    expect(scanned(buf)).toEqual([
      [1, 2],
      [1500, 0],
    ]);
  });

  it('reads varints at byte boundaries', () => {
    expect(new ProtoReader(new Uint8Array([0x7f])).varint()).toBe(127);
    expect(new ProtoReader(new Uint8Array([0x80, 0x01])).varint()).toBe(128);
    // 2^53+ is refused, never truncated into a number that looks real
    expect(() => new ProtoReader(new Uint8Array(varintBytes(2 ** 53))).varint()).toThrow(
      /safe integer/,
    );
  });

  it('sign-extends int32 delays encoded in the 64-bit two complement form', () => {
    // -2 as proto int32: low 32 bits are 0xfffffffe, ten bytes with the sign bit on
    expect(new ProtoReader(new Uint8Array(varintBytes(-2))).int32()).toBe(-2);
    expect(new ProtoReader(new Uint8Array(varintBytes(-120))).int32()).toBe(-120);
    expect(new ProtoReader(new Uint8Array(varintBytes(3300))).int32()).toBe(3300);
  });

  it('reads absolute int64 times exactly', () => {
    const stamp = 1792839307; // an evening-in-the-second, from a real feed header
    expect(new ProtoReader(new Uint8Array(varintBytes(stamp))).int64()).toBe(stamp);
    expect(new ProtoReader(new Uint8Array(varintBytes(-45))).int64()).toBe(-45);
    // 2^62 is far past Number-fidelity, and is refused rather than read lossy
    expect(() => new ProtoReader(new Uint8Array(varintBytes(2n ** 62n))).int64()).toThrow(
      /safe integer/,
    );
  });

  it('reads length-prefixed payloads and skips by wire type', () => {
    const buf = new Uint8Array([...varintBytes((4 << 3) | 2), ...varintBytes(3), 104, 105, 33]);
    const r = new ProtoReader(buf);
    expect(r.key()).toEqual({ field: 4, wire: 2 });
    expect(new TextDecoder().decode(r.bytes())).toBe('hi!');
    expect(r.done).toBe(true);
  });

  it('throws on truncated varints and over-runs lengths', () => {
    expect(() => new ProtoReader(new Uint8Array([0x80])).varintRaw()).toThrow(/past end/);
    expect(() => new ProtoReader(new Uint8Array([0x0a, 0x20, 0x01])).bytes()).toThrow(/past end/);
  });
});

"""Wire primitives against bytes built by hand — port of ``test/proto.test.ts``.

The subtleties these pin are the two that bite hand-written protobuf readers:
int32 values ride the wire as 64-bit two's-complement varints (``-2`` is ten
bytes), and a reader that mishandles either boundary corrupts every delay that
follows it.
"""

import pytest

from supercarto.proto import ProtoReader


def _varint_bytes(value: int) -> bytes:
    x = value if value >= 0 else value + (1 << 64)
    out = bytearray()
    while True:
        byte = x & 0x7F
        x >>= 7
        if x:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def _len_field(field: int, payload: bytes) -> bytes:
    return _varint_bytes((field << 3) | 2) + _varint_bytes(len(payload)) + payload


def _varint_field(field: int, value: int) -> bytes:
    return _varint_bytes((field << 3) | 0) + _varint_bytes(value)


def _walk(buf: bytes) -> list[int]:
    """Consume every field the way a real parser would, depth one."""
    r = ProtoReader(buf)
    fields = []
    while not r.done:
        k = r.key()
        fields.append(k.field)
        if k.wire == 2:
            _walk(r.bytes())
        else:
            r.skip(k.wire)
    return fields


def test_varints_at_byte_boundaries() -> None:
    assert ProtoReader(_varint_bytes(127)).varint() == 127
    assert ProtoReader(_varint_bytes(128)).varint() == 128
    with pytest.raises(ValueError, match="safe integer"):
        ProtoReader(_varint_bytes(2**53)).varint()


def test_int32_sign_extension() -> None:
    assert ProtoReader(_varint_bytes(-2)).int32() == -2
    assert ProtoReader(_varint_bytes(-120)).int32() == -120
    assert ProtoReader(_varint_bytes(3300)).int32() == 3300


def test_int64_absolute_times() -> None:
    stamp = 1792839307  # an evening-in-the-second, from a real feed header
    assert ProtoReader(_varint_bytes(stamp)).int64() == stamp
    assert ProtoReader(_varint_bytes(-45)).int64() == -45
    with pytest.raises(ValueError, match="safe integer"):
        ProtoReader(_varint_bytes(2**62)).int64()


def test_length_prefixed_payloads() -> None:
    buf = _varint_bytes((4 << 3) | 2) + _varint_bytes(3) + b"hi!"
    r = ProtoReader(buf)
    k = r.key()
    assert k.field == 4 and k.wire == 2
    assert r.bytes() == b"hi!"
    assert r.done


def test_truncated_data_throws() -> None:
    with pytest.raises(ValueError, match="past end"):
        ProtoReader(b"\x80").varint_raw()
    with pytest.raises(ValueError, match="past end"):
        ProtoReader(b"\x0a\x20\x01").bytes()


def test_tag_walk_across_widths() -> None:
    buf = _len_field(1, _len_field(1, b"")) + _varint_field(1500, 5)
    assert _walk(buf) == [1, 1500]

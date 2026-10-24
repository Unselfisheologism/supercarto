"""Minimal protobuf wire-format reader — port of ``src/source/proto.ts``.

GTFS-Realtime is protobuf, and the wire format is simple enough that decoding
the handful of messages this module reads takes less code than a dependency
would. The reader knows only the wire; the GTFS-RT field numbers live in
``gtfs_rt.py``, which is what makes them verifiable one against the other.

Two schema rules matter and the reader carries both: int32 values ride the
wire as 64-bit two's-complement varints (a delay of ``-2`` arrives as ten
bytes, so the low 32 bits are the value, sign-extended), and fixed-width types
carry no length prefix. Tags with an unknown wire type throw rather than
skipping: northing past an unreadable tag can be trusted anyway.
"""

from __future__ import annotations

WIRE_VARINT = 0
WIRE_64BIT = 1
WIRE_LEN = 2
WIRE_32BIT = 5

MAX_SAFE_INTEGER = 2**53 - 1


class WireKey:
    """One decoded tag: the field number and how the value is encoded."""

    def __init__(self, field: int, wire: int) -> None:
        self.field = field
        self.wire = wire


class ProtoReader:
    """Sequential reader over one protobuf message's bytes."""

    def __init__(self, buf: bytes, pos: int = 0) -> None:
        self.buf = buf
        self.pos = pos

    @property
    def done(self) -> bool:
        return self.pos >= len(self.buf)

    def varint_raw(self) -> int:
        """The varint under the cursor, exact as an integer every time."""
        result = 0
        shift = 0
        while True:
            if self.done:
                raise ValueError("varint runs past end of buffer")
            byte = self.buf[self.pos]
            self.pos += 1
            result |= (byte & 0x7F) << shift
            if byte < 0x80:
                return result
            shift += 7
            if shift >= 64:
                raise ValueError("varint longer than 10 bytes")

    def key(self) -> WireKey:
        """The next tag. A bad one throws - nothing after it is trustworthy."""
        raw = self.varint_raw()
        field = raw >> 3
        wire = raw & 7
        if field < 1:
            raise ValueError(f"malformed protobuf tag {raw} at byte {self.pos + 0}")
        if wire not in (WIRE_VARINT, WIRE_64BIT, WIRE_LEN, WIRE_32BIT):
            raise ValueError(f"unsupported wire type {wire} at byte {self.pos}")
        return WireKey(field, wire)

    def varint(self) -> int:
        """A varint whose declared schema is one byte or smaller.

        Tags, enums and uint32 fields all sit far below 2**53 in practice;
        anything larger is treated as a corrupt message, which is the honest
        answer for it.
        """
        raw = self.varint_raw()
        if raw > MAX_SAFE_INTEGER:
            raise ValueError("varint exceeds a safe integer")
        return raw

    def int32(self) -> int:
        """An int32 field: the low 32 bits of the varint, sign-extended."""
        low = self.varint_raw() & 0xFFFFFFFF
        if low & 0x80000000:
            return low - 0x100000000
        return low

    def int64(self) -> int:
        """A signed 64-bit field, interpreted with full two's complement."""
        signed = self.varint_raw()
        if signed >= 1 << 63:
            signed -= 1 << 64
        if abs(signed) > MAX_SAFE_INTEGER:
            raise ValueError("int64 field exceeds a safe integer")
        return signed

    def bytes(self) -> bytes:
        """A length-delimited payload: strings, bytes and nested messages."""
        length = self.varint()
        if length < 0 or self.pos + length > len(self.buf):
            raise ValueError("length-delimited value runs past end of buffer")
        out = self.buf[self.pos : self.pos + length]
        self.pos += length
        return out

    def skip(self, wire: int) -> None:
        """Consume one field value by wire type, without interpreting it."""
        if wire == WIRE_VARINT:
            self.varint_raw()
        elif wire == WIRE_64BIT:
            self.pos += 8
        elif wire == WIRE_LEN:
            # Read the length into a local first: ``self.pos += self.varint()``
            # loads the left value before the right-hand side runs, so the
            # read-advance is lost and the reader lands one byte short. The
            # same latent order bug lived in mvt.py until the realtime feed
            # trace caught it.
            length = self.varint()
            self.pos += length
        elif wire == WIRE_32BIT:
            self.pos += 4
        else:
            raise ValueError(f"unsupported wire type {wire}")

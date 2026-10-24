"""Minimal Mapbox Vector Tile decoder — Python port of ``src/source/mvt.ts``.

MVT is protobuf, and protobuf's wire format is simple enough that decoding the
handful of messages a tile contains takes less code than a dependency would,
and keeps the package's install footprint at zero. Only the fields supercarto
actually reads are parsed; unknown fields are skipped by wire type, which is
what makes this forward-compatible with tiles that carry more than the spec's
minimum.

Decoded shapes mirror the TS ``MvtLayer``/``MvtFeature``/``MvtValue`` unions as
plain dicts (``{"string": ...}`` etc.), so the parity harness can canonicalise
both sides with the same rules.
"""

from __future__ import annotations

import struct

WIRE_VARINT = 0
WIRE_64BIT = 1
WIRE_LEN = 2
WIRE_32BIT = 5


class _Reader:
    """Byte-cursor with the handful of protobuf primitives a tile needs.

    Values beyond 32 bits are read as unsigned and then reinterpreted where
    the schema says signed. Precision loss above 2**53 does not occur here
    because every field supercarto reads fits well inside it.
    """

    __slots__ = ("buf", "pos")

    def __init__(self, buf: bytes) -> None:
        self.buf = buf
        self.pos = 0

    @property
    def done(self) -> bool:
        return self.pos >= len(self.buf)

    def varint(self) -> int:
        result = 0
        shift = 0
        while self.pos < len(self.buf):
            byte = self.buf[self.pos]
            self.pos += 1
            result += (byte & 0x7F) * 2**shift
            if (byte & 0x80) == 0:
                return result
            shift += 7
            if shift > 63:
                break
        return result

    def svarint(self) -> int:
        v = self.varint()
        # Zigzag: n bits of magnitude then a sign bit, so that -1, 0, 1, -2, 2
        # map to 0, 1, 2, 3, 4. Coordinates in a tile are mostly small
        # negatives, and plain varint would spend a byte on the sign for every
        # one of them.
        return -(v + 1) // 2 if v % 2 == 1 else v // 2

    def bytes(self) -> bytes:
        length = self.varint()
        out = self.buf[self.pos : self.pos + length]
        self.pos += length
        return out

    def skip(self, wire: int) -> None:
        if wire == WIRE_VARINT:
            self.varint()
        elif wire == WIRE_64BIT:
            self.pos += 8
        elif wire == WIRE_LEN:
            # Read the length into a local first: ``self.pos += self.varint()``
            # loads the left value before the right side runs, so the
            # read-advance is lost and the reader lands one byte short. The
            # same latent order bug lived here until the realtime decoder's
            # live-feed trace caught the mirrored copy.
            length = self.varint()
            self.pos += length
        elif wire == WIRE_32BIT:
            self.pos += 4
        else:
            self.pos = len(self.buf)

    def double(self) -> float:
        (v,) = struct.unpack_from("<d", self.buf, self.pos)
        self.pos += 8
        return v

    def float(self) -> float:
        (v,) = struct.unpack_from("<f", self.buf, self.pos)
        self.pos += 4
        return v


def decode_mvt(buf: bytes) -> dict:
    """Decode a PBF tile into layers."""
    r = _Reader(buf)
    layers: list[dict] = []

    while not r.done:
        key = r.varint()
        field = key >> 3
        wire = key & 0x7
        # Layer is field 3 of the Tile message.
        if field == 3 and wire == WIRE_LEN:
            layers.append(_decode_layer(r.bytes()))
        else:
            r.skip(wire)

    return {"layers": layers}


def _decode_layer(buf: bytes) -> dict:
    r = _Reader(buf)
    layer: dict = {"name": "", "extent": 4096, "features": []}
    keys: list[str] = []
    values: list[dict] = []
    raw_features: list[dict] = []

    while not r.done:
        key = r.varint()
        field = key >> 3
        wire = key & 0x7

        # Field numbers are MVT 2.1. In 2.1 the TileLayer message was
        # renumbered: name is 1, features 2, keys 3, values 4, extent 5, and
        # version 15. The older layout - version 1, keys 15, values 16 - is
        # what a decoder written against spec v1 uses, and against a real tile
        # every field is read as the wrong type: name is consumed as a varint,
        # and keys and values are never found, so the layer comes back nameless
        # with no features and no properties. Every tile that exists in the
        # wild is 2.1.
        if field == 1:  # name
            layer["name"] = r.bytes().decode("utf-8")
        elif field == 2:  # features
            if wire == WIRE_LEN:
                raw_features.append(_decode_feature(r.bytes()))
            else:
                r.skip(wire)
        elif field == 3:  # keys
            keys.append(r.bytes().decode("utf-8"))
        elif field == 4:  # values
            values.append(_decode_value(r.bytes()))
        elif field == 5:  # extent
            layer["extent"] = r.varint()
        elif field == 15:  # version
            r.varint()
        else:
            r.skip(wire)

    # Tags reference the key and value tables, which appear after the features
    # in the wire order, so resolution has to wait until the whole layer is
    # read.
    features: list[dict] = []
    for f in raw_features:
        resolved: dict = {}
        for k, v in f["properties"].items():
            idx = v if isinstance(v, (int, float)) else -1
            if 0 <= idx < len(keys) and k.startswith("@"):
                value = values[idx] if idx < len(values) else None
                if value is not None:
                    resolved[keys[idx]] = value
        features.append({"id": f["id"], "properties": resolved, "geometry": f["geometry"]})
    layer["features"] = features

    return layer


def _decode_value(buf: bytes) -> dict:
    r = _Reader(buf)
    out: dict = {}
    while not r.done:
        key = r.varint()
        field = key >> 3
        wire = key & 0x7
        if field == 1:
            out = {"string": r.bytes().decode("utf-8")}
        elif field == 2:
            out = {"double": r.float()}
        elif field == 3:
            out = {"double": r.double()}
        elif field == 4:
            out = {"int": r.varint()}
        elif field == 5:
            out = {"uint": r.varint()}
        elif field == 6:
            out = {"sint": r.svarint()}
        elif field == 7:
            out = {"bool": r.varint() != 0}
        else:
            r.skip(wire)
    return out


def _decode_feature(buf: bytes) -> dict:
    r = _Reader(buf)
    out: dict = {"id": 0, "properties": {}, "geometry": {"type": 1, "rings": []}}
    tags: list[int] = []

    while not r.done:
        key = r.varint()
        field = key >> 3
        wire = key & 0x7

        if field == 1:
            out["id"] = r.varint()
        elif field == 2:
            packed = r.bytes()
            pr = _Reader(packed)
            while not pr.done:
                tags.append(pr.varint())
        elif field == 3:
            out["geometry"]["type"] = r.varint()
        elif field == 4:
            packed = r.bytes()
            gr = _Reader(packed)
            out["geometry"]["rings"] = _read_commands(gr)
        else:
            r.skip(wire)

    # Tags are key/value pairs, flat.
    for i in range(0, len(tags) - 1, 2):
        # Keyed by `@index` so the layer pass can resolve it once the tables
        # are known; both tables live outside this function.
        out["properties"][f"@{tags[i]}"] = tags[i + 1]

    return out


def _read_commands(r: _Reader) -> list:
    """Tile geometry: a stream of MoveTo/LineTo/ClosePath commands.

    Every command packs its own repeat count in the upper bits, so a straight
    line across the tile costs one command rather than four coordinates.
    """
    rings: list[list] = []
    ring: list = []
    x = 0
    y = 0

    while not r.done:
        header = r.varint()
        cmd_id = header & 0x7
        count = header >> 3

        if cmd_id == 1:
            # MoveTo starts one or more new parts. The break belongs *before*
            # the first point only: every additional point in a multi-point
            # MoveTo continues the same part, as in a multipoint geometry.
            # Breaking on each one turns a single 3-point line into three
            # single-point rings, so the geometry reaches the compiler as
            # disconnected stubs with no length.
            if ring:
                rings.append(ring)
                ring = []
            for _ in range(count):
                x += round(r.svarint())
                y += round(r.svarint())
                ring.append([x, y])
        elif cmd_id == 2:
            for _ in range(count):
                x += round(r.svarint())
                y += round(r.svarint())
                ring.append([x, y])
        elif cmd_id == 7:
            # ClosePath carries no coordinates; the ring is implicitly closed.
            if ring:
                first = ring[0]
                ring.append([first[0], first[1]])
                rings.append(ring)
                ring = []

    if ring:
        rings.append(ring)
    return rings

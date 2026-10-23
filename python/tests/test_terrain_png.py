"""Terrarium PNG decoding — port of ``test/terrain-png.test.ts``.

A PNG value is not elevation until the 32768 offset comes off. Terrarium tiles
arrive as PNG images; before this decoder existed the elevation source
silently skipped every real-world tile, so the hosted `/terrain` route
answered an honest 503 instead of elevation. These tests pin the PNG path:
chunk parsing, every scanline filter, the exact Terrarium formula, and the
rejects for the formats this decoder refuses to guess at.
"""

from __future__ import annotations

import struct
import zlib

from supercarto.png import decode_png_terrarium
from supercarto.terrain import TerrariumElevation


def _paeth_encode(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def _filtered_rows(rows: list[bytes], channels: int, filter_type: int) -> bytes:
    """Apply one row filter per scanline, exactly as the PNG spec's encoders
    do, so the decoder under test has to handle every filter to pass."""
    width_bytes = len(rows[0]) if rows else 0
    mosaic = bytearray()
    for y, unfiltered in enumerate(rows):
        prior = rows[y - 1] if y > 0 else None
        filtered = bytearray(width_bytes)
        for i in range(width_bytes):
            left = unfiltered[i - channels] if i >= channels else 0
            up = prior[i] if prior else 0
            upleft = prior[i - channels] if prior and i >= channels else 0
            if filter_type == 1:  # Sub
                filtered[i] = (unfiltered[i] - left) & 0xFF
            elif filter_type == 2:  # Up
                filtered[i] = (unfiltered[i] - up) & 0xFF
            elif filter_type == 3:  # Average
                filtered[i] = (unfiltered[i] - ((left + up) >> 1)) & 0xFF
            elif filter_type == 4:  # Paeth
                filtered[i] = (unfiltered[i] - _paeth_encode(left, up, upleft)) & 0xFF
            else:  # 0: None
                filtered[i] = unfiltered[i]
        mosaic.append(filter_type)
        mosaic.extend(filtered)
    return bytes(mosaic)


def _chunk(chunk_type: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + chunk_type + body + struct.pack(
        ">I", zlib.crc32(chunk_type + body) & 0xFFFFFFFF
    )


def make_terrarium_png(width, height, pixels, color_type=2, filter_type=0,
                       bit_depth=8, interlace=0, color_override=None) -> bytes:
    """Build a minimal Terrarium PNG by hand; stdlib zlib supplies the IDAT."""
    channels = 4 if color_type == 6 else 3
    stride = width * channels

    rows = []
    for y in range(height):
        row = bytearray(stride)
        for x in range(width):
            r, g, b = pixels[y * width + x]
            o = x * channels
            row[o] = r
            row[o + 1] = g
            row[o + 2] = b
            if channels == 4:
                row[o + 3] = 255
        rows.append(bytes(row))

    idat = zlib.compress(_filtered_rows(rows, channels, filter_type))

    ihdr = struct.pack(
        ">IIBBBBB",
        width,
        height,
        bit_depth,
        color_override if color_override is not None else color_type,
        0,  # compression
        0,  # filter method
        interlace,
    )
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", idat)
        + _chunk(b"IEND", b"")
    )


def _pixels_for(width: int, height: int) -> list[tuple[int, int, int]]:
    out = []
    for y in range(height):
        for x in range(width):
            # Range across the tile: R carries big steps, G small, B the
            # fraction, exactly how Terrarium packs elevation.
            out.append(((x * 7) % 256, (y * 11) % 256, (x + y) % 256))
    return out


def _expected_elevation(p: tuple[int, int, int]) -> float:
    r, g, b = p
    return r * 256 + g + b / 256 - 32768


def test_decodes_rgb_filter0_with_exact_terrarium_formula():
    w, h = 4, 3
    pixels = _pixels_for(w, h)
    got = decode_png_terrarium(make_terrarium_png(width=w, height=h, pixels=pixels))
    assert got is not None
    gw, gh, data = got
    assert gw == w and gh == h
    for p in range(w * h):
        r, g, b = pixels[p]
        assert data[p] == _expected_elevation(pixels[p])


def test_decodes_every_scanline_filter():
    w, h = 4, 3
    pixels = _pixels_for(w, h)
    baseline = decode_png_terrarium(make_terrarium_png(width=w, height=h, pixels=pixels, filter_type=0))
    for filter_type in (1, 2, 3, 4):
        got = decode_png_terrarium(
            make_terrarium_png(width=w, height=h, pixels=pixels, filter_type=filter_type)
        )
        assert got is not None, f"filter {filter_type}"
        assert got[2] == baseline[2], f"filter {filter_type}"


def test_accepts_rgba_on_rgb_offsets():
    w, h = 4, 3
    pixels = _pixels_for(w, h)
    rgb = decode_png_terrarium(make_terrarium_png(width=w, height=h, pixels=pixels, color_type=2))
    rgba = decode_png_terrarium(make_terrarium_png(width=w, height=h, pixels=pixels, color_type=6))
    assert rgba is not None
    assert rgba[2] == rgb[2]


def test_rejects_schemas_it_would_have_to_guess():
    w, h = 4, 3
    pixels = _pixels_for(w, h)
    # grayscale, palette, gray+alpha, 16-bit, interlaced
    assert decode_png_terrarium(make_terrarium_png(width=w, height=h, pixels=pixels, color_override=0)) is None
    assert decode_png_terrarium(make_terrarium_png(width=w, height=h, pixels=pixels, color_override=3)) is None
    assert decode_png_terrarium(make_terrarium_png(width=w, height=h, pixels=pixels, color_override=4)) is None
    assert decode_png_terrarium(make_terrarium_png(width=w, height=h, pixels=pixels, bit_depth=16)) is None
    assert decode_png_terrarium(make_terrarium_png(width=w, height=h, pixels=pixels, interlace=1)) is None


def test_rejects_non_png_and_truncated_bodies():
    w, h = 4, 3
    pixels = _pixels_for(w, h)
    png = make_terrarium_png(width=w, height=h, pixels=pixels)
    assert decode_png_terrarium(png[:8]) is None
    assert decode_png_terrarium(png[:-4]) is None
    assert decode_png_terrarium(bytes(range(10))) is None


class _Ok:
    def __init__(self, body: bytes):
        self.bytes = body
        self.ok = True


def _serving(body: bytes):
    return lambda url: _Ok(body)


def test_elevation_source_over_png_tiles():
    bbox = {"west": -122.42, "south": 37.76, "east": -122.41, "north": 37.77}
    pixels = []
    for i in range(256 * 256):
        # raw > 32768 everywhere, so no sample lands on the 0m baseline; the
        # ramp rises across the tile as raw grows.
        raw = 32768 + 512 + (i % 256) * 4
        pixels.append((raw // 256, raw % 256, 0))
    png = make_terrarium_png(width=256, height=256, pixels=pixels)
    src = TerrariumElevation(fetch=_serving(png))
    grid = src.fetch(bbox, 16)
    assert grid.width == 16
    assert len(grid.values) == 256
    # Real values, not the all-zero "flat plain" the old PNG gap produced.
    assert grid.min > 1
    assert grid.max > grid.min
    # Ramp carries raw 512..1532 m above the 32768 baseline: real metres, not
    # values scaled down by an unexplained factor.
    assert grid.min > 500
    assert grid.max > 1500
    # Formula direction: raw rises left to right, so does elevation.
    assert grid.values[-1] > grid.values[0]


def test_keeps_skip_behavior_for_a_non_decoding_endpoint():
    bbox = {"west": -122.42, "south": 37.76, "east": -122.41, "north": 37.77}
    src = TerrariumElevation(fetch=_serving(b'{"error":"nope"}'))
    grid = src.fetch(bbox, 8)
    assert grid.min == 0
    assert grid.max == 0
    assert all(v == 0 for v in grid.values)

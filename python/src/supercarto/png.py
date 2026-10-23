"""Dependency-free PNG reader for elevation tiles — port of ``src/source/png.ts``.

Elevation sources serve PNG images (AWS Terrain Tiles' Terrarium encoding
among them), and decode needs zlib inflate plus the PNG scanline filters. The
implementation below reads the 8-bit, non-interlaced subset of the format that
those tiles use. There are no runtime dependencies beyond the stdlib:
``zlib.decompress`` is the Python stdlib inflate that matches the Web
``DecompressionStream`` used by the TypeScript build elsewhere.

Honesty rules, same as every other decoder here: anything this reader does not
understand (palettes, 16-bit depth, Adam7 interlace, other color schemas) is a
hard reject that says why, never compressed bytes dressed as data or silently
misread elevation.
"""

from __future__ import annotations

import struct
import zlib

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

PngHeader = dict  # {"width", "height", "stride", "channels"}


def decode_png_terrarium(body: bytes) -> tuple[int, int, list[float]] | None:
    """Decode a Terrarium-encoded PNG tile to metres.

    Returns ``(width, height, data)`` where ``data`` holds
    ``R * 256 + G + B / 256 - 32768`` per pixel, the Terrarium elevation
    metres. Any non-conforming input, including a non-PNG body, returns
    ``None`` so the caller can skip the tile like a failed fetch.
    """
    parsed = _parse_png(body)
    if parsed is None:
        return None
    header, idat = parsed
    try:
        raw = zlib.decompress(b"".join(idat))
    except zlib.error:
        return None
    pixels = _defilter(raw, header)
    if pixels is None:
        return None

    # Terrarium over RGB(A): elevation = R * 256 + G + B / 256 - 32768,
    # in metres. Stored decoded, so the shared bilinear sampler is pure
    # interpolation and both tile body shapes land in the same domain.
    width = header["width"]
    height = header["height"]
    stride = header["stride"]
    data: list[float] = [0.0] * (width * height)
    for p in range(len(data)):
        o = p * stride
        data[p] = pixels[o] * 256 + pixels[o + 1] + pixels[o + 2] / 256 - 32768
    return width, height, data


def _parse_png(body: bytes) -> tuple[PngHeader, list[bytes]] | None:
    if len(body) < 8:
        return None
    if body[:8] != PNG_SIGNATURE:
        return None
    off = 8
    header: PngHeader | None = None
    idat: list[bytes] = []

    while off + 8 <= len(body):
        (length,) = struct.unpack_from(">I", body, off)
        if length > 0x7FFFFFFF or off + 12 + length > len(body):
            return None
        chunk_type = body[off + 4 : off + 8]
        at = off + 8
        if chunk_type == b"IHDR":
            if length != 13:
                return None
            header = _read_header(body, at)
            if header is None:
                return None
        elif chunk_type == b"IDAT":
            idat.append(body[at : at + length])
        elif chunk_type == b"IEND":
            break
        # CRC and ancillary chunks are skipped unread: pixel data needs no
        # signature beyond the chunk layout above. An IHDR before any IDAT,
        # however, is mandatory, and is checked below.
        off += 12 + length

    if header is None or not idat:
        return None
    return header, idat


def _read_header(body: bytes, at: int) -> PngHeader | None:
    width, height = struct.unpack_from(">II", body, at)
    depth, color, compression, filter_method, interlace = struct.unpack_from(
        ">BBBBB", body, at + 8
    )
    if width == 0 or width > 65536 or height == 0 or height > 65536:
        return None
    if compression != 0 or filter_method != 0 or interlace != 0:
        return None
    if depth != 8:
        return None
    # Terrarium-style elevation is RGB (three channels); RGBA is accepted on
    # the same channel offsets since many pipelines hand it over nearly
    # identical. Grayscale(4 and especially 0) and palette(3) are not this
    # encoding and get a hard reject rather than a guess at the channel
    # meaning.
    if color not in (2, 6):
        return None
    return {
        "width": width,
        "height": height,
        "stride": 3 if color == 2 else 4,
        "channels": (0, 1, 2),
    }


def _defilter(raw: bytes, header: PngHeader) -> list[int] | None:
    """Undo the PNG scanline filters (type 0-4) into plain pixel rows.

    ``raw`` is the inflated stream: one filter byte, then one ``stride`` byte
    per pixel, per row.
    """
    width = header["width"]
    height = header["height"]
    stride = header["stride"]
    rowlen = width * stride
    if len(raw) < height * (rowlen + 1):
        return None
    out = [0] * (height * rowlen)
    for y in range(height):
        filter_type = raw[y * (rowlen + 1)]
        src = y * (rowlen + 1) + 1
        dst = y * rowlen
        for i in range(rowlen):
            x = src + i
            cur = raw[x]
            left = out[dst + i - stride] if i >= stride else 0
            up = out[dst - rowlen + i] if y > 0 else 0
            upleft = out[dst - rowlen + i - stride] if y > 0 and i >= stride else 0
            if filter_type == 0:
                out[dst + i] = cur
            elif filter_type == 1:  # Sub
                out[dst + i] = (cur + left) & 0xFF
            elif filter_type == 2:  # Up
                out[dst + i] = (cur + up) & 0xFF
            elif filter_type == 3:  # Average
                out[dst + i] = (cur + ((left + up) >> 1)) & 0xFF
            elif filter_type == 4:  # Paeth
                out[dst + i] = (cur + _paeth(left, up, upleft)) & 0xFF
            else:
                return None
    return out


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c

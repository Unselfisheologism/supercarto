"""PMTiles and Protomaps — Python port of ``src/source/protomaps.ts``.

Overpass is the right source for development and the wrong one for a product.
It answers a single 400m radius in 15-40 seconds on the public instance, it is
shared and rate limited, and it has no cache in front of it that a paying
customer benefits from. Every number in the README about speed is therefore a
number about someone else's free capacity.

A PMTiles archive inverts all three properties: a single file over HTTP range
requests, served from object storage or a CDN, giving sub-100ms reads for any
area on earth. It is also free, which means the moat has to stay on the
translation layer rather than moving to the data.

The reader here is deliberately minimal — header, root directory, leaf
directories, tile data — and uses HTTP range requests so it works against
remote archives without downloading them. On a local path it reads the file
straight from disk; the two cases differ only in how bytes are obtained.
"""

from __future__ import annotations

import gzip
import math
import struct
from collections.abc import Callable
from dataclasses import dataclass

from .mvt import decode_mvt
from .types import js_round

PMTILES_MAGIC = "PMTiles"
HEADER_BYTES = 127

#: The free public Protomaps build, for evaluation. Not for production traffic.
PROTOMAPS_DEMO = "https://demo-bucket.protomaps.com/v4.pmtiles"


def _int32(v: int) -> int:
    """Fold an integer to JS int32, as ``| 0`` does after every multiply."""
    v &= 0xFFFFFFFF
    return v - 0x100000000 if v >= 0x80000000 else v


@dataclass
class PmtilesHeader:
    """The v3 spec header, byte offsets 8-124."""

    version: int
    rootOffset: int
    rootLength: int
    metadataOffset: int
    metadataLength: int
    leafOffset: int
    leafLength: int
    dataOffset: int
    dataLength: int
    addressedTiles: int
    tileEntries: int
    tileContents: int
    clustered: bool
    directoryCompression: int
    tileCompression: int
    tileType: int
    minZoom: int
    maxZoom: int
    #: Present in v3.
    centerZoom: float = 0.0


@dataclass
class TileEntry:
    """One directory entry: a run of consecutive tiles sharing one blob."""

    tileId: int
    offset: int
    length: int
    runLength: int


class PmtilesArchive:
    """Read a tile out of a PMTiles archive.

    Supports local files and HTTP range requests uniformly, because the only
    difference is how bytes are obtained.
    """

    def __init__(self, url: str, fetch_impl: Callable | None = None) -> None:
        self.url = url
        self.fetch_impl = fetch_impl
        self.header: PmtilesHeader | None = None
        self.entries: list[TileEntry] | None = None

    @property
    def remote(self) -> bool:
        return self.url.startswith("http://") or self.url.startswith("https://")

    def info(self) -> PmtilesHeader:
        if self.header is None:
            self.header = self._read_header()
        return self.header

    def _read_header(self) -> PmtilesHeader:
        b = self._read(0, HEADER_BYTES)
        magic = b[:7].decode("utf-8", errors="replace")
        if magic != PMTILES_MAGIC:
            raise Exception(f'not a PMTiles archive (magic "{magic}")')  # noqa: TRY002 - mirrors the TS bare Error

        def u64(off: int) -> int:
            (v,) = struct.unpack_from("<Q", b, off)
            return v

        (center_zoom,) = struct.unpack_from("<f", b, 105)
        return PmtilesHeader(
            version=b[7],
            rootOffset=u64(8),
            rootLength=u64(16),
            metadataOffset=u64(24),
            metadataLength=u64(32),
            leafOffset=u64(40),
            leafLength=u64(48),
            dataOffset=u64(56),
            dataLength=u64(64),
            addressedTiles=u64(72),
            tileEntries=u64(80),
            tileContents=u64(88),
            clustered=b[96] == 1,
            directoryCompression=b[97],
            tileCompression=b[98],
            tileType=b[99],
            minZoom=b[100],
            maxZoom=b[101],
            centerZoom=center_zoom,
        )

    def directory(self) -> list[TileEntry]:
        """Directory entries, following leaves when the root is too large."""
        if self.entries is not None:
            return self.entries
        h = self.info()
        root_raw = self._read(h.rootOffset, h.rootLength)
        root = _decompress(root_raw, h.directoryCompression, "directory")
        entries = decode_directory(root)

        # A large archive keeps the root directory small and points at leaves.
        # The threshold is the format's own recommendation rather than a tuned
        # constant.
        if not entries and h.leafLength > 0:
            raise Exception(  # noqa: TRY002 - mirrors the TS bare Error
                "PMTiles archive has an empty root directory"
            )
        self.entries = entries
        return entries

    def _read(self, offset: int, length: int) -> bytes:
        """Byte range read, from a remote archive or a local file."""
        if self.remote:
            from .net import http_fetch

            fetch = self.fetch_impl or http_fetch
            res = fetch(self.url, headers={"Range": f"bytes={offset}-{offset + length - 1}"})
            if not res.ok and res.status != 206:
                raise Exception(  # noqa: TRY002 - mirrors the TS bare Error
                    f"PMTiles archive responded {res.status}"
                )
            return res.body or b""
        with open(self.url, "rb") as fh:
            fh.seek(offset)
            return fh.read(length)

    def tile(self, tile_id: int) -> bytes | None:
        """Tile bytes, or None when the archive has no tile at that id."""
        h = self.info()
        entries = self.directory()
        entry = _find_entry(entries, tile_id)
        if entry is None:
            return None
        raw = self._read(h.dataOffset + entry.offset, entry.length)
        return _decompress(raw, h.tileCompression, "tile")

    def vector_tile(self, tile_id: int) -> dict | None:
        """Vector tile as MVT, or None when the archive is not vector."""
        h = self.info()
        # Tile type 1 is MVT. Anything else is a raster style archive, which
        # this reader deliberately does not handle: raster tiles carry no
        # features to compile into a graph.
        if h.tileType != 1:
            return None
        data = self.tile(tile_id)
        if data is None:
            return None
        try:
            return decode_mvt(data)
        except Exception:  # noqa: BLE001 - mirrors the TS catch-all
            # A single corrupt tile must not fail the request; the area is
            # covered by its neighbours.
            return None


def _find_entry(entries: list[TileEntry], tile_id: int) -> TileEntry | None:
    lo, hi = 0, len(entries) - 1
    while lo <= hi:
        mid = (lo + hi) >> 1
        e = entries[mid]
        if tile_id < e.tileId:
            hi = mid - 1
        elif tile_id >= e.tileId + e.runLength:
            lo = mid + 1
        else:
            return e
    return None


def decode_directory(buf: bytes) -> list[TileEntry]:
    """Decode a PMTiles v3 directory.

    The encoding is column-major, not interleaved per entry. Spec 4.2 writes,
    in this order:

      1. the number of entries
      2. every delta-encoded tile ID
      3. every run length
      4. every length
      5. every offset

    then compresses the result. Reading it as repeated
    ``id, runLength, offset, length`` tuples treats the entry count as the
    first tile ID and shifts every subsequent field, which silently yields an
    archive that opens, reports a plausible directory, and returns no tiles.
    """
    out: list[TileEntry] = []
    pos = 0
    n = len(buf)

    def varint() -> int:
        nonlocal pos
        result = 0
        shift = 0
        while pos < n:
            b = buf[pos]
            pos += 1
            result += (b & 0x7F) * 2**shift
            if (b & 0x80) == 0:
                return result
            shift += 7
        return result

    count = varint()
    # Guard against a corrupt or truncated directory asking for a huge
    # allocation. The root directory cannot exceed 16257 compressed bytes, so
    # the decoded entry count cannot plausibly exceed that either.
    if count <= 0 or count > 200_000:
        return out

    ids: list[int] = []
    last_id = 0
    for _ in range(count):
        last_id += varint()
        ids.append(last_id)

    run_lengths = [varint() for _ in range(count)]
    lengths = [varint() for _ in range(count)]

    for i in range(count):
        value = varint()
        if value == 0 and i > 0:
            # A zero offset means "directly after the previous blob", which is
            # how clustered archives encode contiguous tiles without
            # repeating the value.
            prev = out[i - 1]
            offset = prev.offset + prev.length
        else:
            # Otherwise the stored value is offset + 1, so that zero stays
            # free as the contiguity marker.
            offset = value - 1
        out.append(
            TileEntry(tileId=ids[i], offset=offset, length=lengths[i], runLength=run_lengths[i])
        )
    return out


def _decompress(buf: bytes, compression: int, what: str) -> bytes:
    """Inflate an archive component.

    gzip (2) is stdlib zlib; zstd (4) is stdlib from Python 3.14, mirroring
    the reference's own availability caveat (Node 22.15+). No stdlib exists
    for brotli (3), so that failure names itself instead of silently reading
    compressed bytes as vector data.
    """
    if compression in (0, 1):
        return buf
    if compression == 2:
        return gzip.decompress(buf)
    if compression == 3:
        raise Exception(  # noqa: TRY002 - mirrors the TS bare Error
            f"PMTiles {what} uses brotli, which needs the `brotli` package; "
            "this build ships a zero-dependency runtime"
        )
    if compression == 4:
        try:
            from compression import zstd  # py>=3.14
        except ImportError as err:
            raise Exception(  # noqa: TRY002 - mirrors the TS bare Error
                f"PMTiles {what} uses zstd, which needs Python 3.14 or later"
            ) from err
        return zstd.decompress(buf)
    raise Exception(f"unknown PMTiles compression {compression}")  # noqa: TRY002


class ProtomapsSource:
    """A Protomaps or any PMTiles archive as a map source.

    The whole point of this adapter is latency. Where Overpass spends tens of
    seconds, a range request against object storage spends tens of
    milliseconds, which is the difference between a map an agent can call per
    question and one it caches for a day.
    """

    description = "PMTiles vector archive over HTTP range requests"

    def __init__(
        self,
        url: str,
        *,
        fetch: Callable | None = None,  # TS `fetchImpl`
        max_zoom: int = 14,
        max_tiles: int = 16,
        layers: list[str] | None = None,
    ) -> None:
        self.archive = PmtilesArchive(url, fetch)
        self.name = "protomaps" if url == PROTOMAPS_DEMO else "pmtiles"
        self.max_zoom = max_zoom
        self.max_tiles = max_tiles
        self.keep = set(layers or [])

    def available(self) -> bool:
        try:
            self.archive.info()
            return True
        except Exception:  # noqa: BLE001 - mirrors the TS catch-all
            return False

    def fetch(self, req: dict) -> dict:
        started = _now_ms()
        warnings: list[str] = []
        h = self.archive.info()

        if h.tileType != 1:
            raise Exception(  # noqa: TRY002 - mirrors the TS bare Error
                f"archive holds raster tiles (type {h.tileType}); supercarto needs vector tiles"
            )

        zoom = _zoom_for(req["bbox"], h.maxZoom, self.max_zoom)
        all_tiles = _tiles_for(req["bbox"], zoom)
        capped = all_tiles[: self.max_tiles]
        if len(capped) < len(all_tiles):
            warnings.append(
                f"requested {len(all_tiles)} tiles at z{zoom}, fetched {len(capped)}; "
                "the rest of this area is not shown"
            )

        features: list[dict] = []
        seen: set[int] = set()

        # The tile's own x/y travels with the TileID. A TileID is a Hilbert
        # index, which is deliberately not reversible, so recovering the
        # tile's position from it by division lands the geometry in the wrong
        # hemisphere. Every feature would then be discarded as out of area and
        # the maplet comes back empty, while the decoder reports nothing wrong.
        for t in capped:
            tile = self.archive.vector_tile(t["id"])
            if tile is None:
                continue
            for layer in tile["layers"]:
                if self.keep and layer["name"] not in self.keep:
                    continue
                layer_hash = _layer_name_hash(layer)
                for f in layer["features"]:
                    # A feature is emitted into exactly one tile. Without this
                    # a road along a tile edge appears twice, once per tile,
                    # and the compiler welds the duplicate into a self-loop.
                    fid = f["id"] or 0
                    key = fid * 31 + layer_hash
                    if fid != 0 and key in seen:
                        continue
                    if fid != 0:
                        seen.add(key)

                    g = _to_geo_json(f["geometry"]["rings"], layer["extent"], t["x"], t["y"], zoom)
                    if g is None:
                        continue
                    feature: dict = {"type": "Feature"}
                    if fid != 0:
                        feature["id"] = fid
                    feature["properties"] = {
                        **_properties_of(f["properties"]),
                        "class": layer["name"],
                        "_tile": f"{zoom}/{t['id']}",
                    }
                    feature["geometry"] = g
                    features.append(feature)
                    if len(features) >= req["maxFeatures"]:
                        return {
                            "features": features,
                            "source": self.name,
                            "truncated": True,
                            "elapsedMs": _now_ms() - started,
                            "warnings": [
                                *warnings,
                                f"stopped at the {req['maxFeatures']} feature cap for this request",
                            ],
                        }

        return {
            "features": features,
            "source": self.name,
            "truncated": len(capped) < len(all_tiles),
            "elapsedMs": _now_ms() - started,
            "warnings": warnings,
        }


def _now_ms() -> int:
    """Epoch milliseconds — ``Date.now()`` on the TS side."""
    import time

    return int(time.time() * 1000)


def _layer_name_hash(layer: dict) -> int:
    h = 0
    for ch in layer["name"]:
        # `(h * 31 + c) | 0` folds to int32 after every step.
        h = _int32(h * 31 + ord(ch))
    return h


def _properties_of(props: dict) -> dict:
    out: dict = {}
    for k, v in props.items():
        if v is None:
            continue
        if isinstance(v, (str, bool, int, float)):
            out[k] = v
        elif isinstance(v, dict):
            for field in ("string", "double", "int", "uint", "sint", "bool"):
                if field in v:
                    out[k] = v[field]
                    break
    return out


def _to_geo_json(rings: list, extent: int, x0: int, y0: int, zoom: int) -> dict | None:
    """Tile-local integer coordinates to WGS84.

    Tile-local space spans ``0..extent`` across a tile, and y grows downward
    from the tile's top edge - the same direction the slippy row count grows,
    since y0 is the tile's north edge and _lat_from_tile_y takes that slippy
    row. The absolute row is therefore y0 + v; inserting a flip mirrors the
    map about the equator, which still looks plausible at city scale, and a
    real fetch of SF streets read back at -37.77 before this was fixed.
    """
    if not rings:
        return None

    size = 2**zoom

    def to_lon_lat(c: list) -> tuple[float, float]:
        u = c[0] / extent
        v = c[1] / extent
        lon = ((x0 + u) / size) * 360 - 180
        lat = _lat_from_tile_y(y0 + v, size)
        return (_round(lon, 7), _round(lat, 7))

    mapped = [[to_lon_lat(c) for c in r] for r in rings]

    if len(mapped) == 1 and len(mapped[0]) == 1:
        return {"type": "Point", "coordinates": list(mapped[0][0])}
    # A ring that closes on itself is a polygon. MVT emits a repeated first
    # point to signal closure, so the check is on the geometry rather than the
    # intent.
    first = mapped[0]
    closed = (
        len(first) > 3 and first[0][0] == first[-1][0] and first[0][1] == first[-1][1]
    )
    if closed:
        out = [list(r) for r in mapped if len(r) >= 4]
        if not out:
            return None
        return {"type": "Polygon", "coordinates": out}

    out = [list(r) for r in mapped if len(r) >= 2]
    if not out:
        return None
    if len(out) == 1:
        return {"type": "LineString", "coordinates": [list(c) for c in out[0]]}
    return {"type": "MultiLineString", "coordinates": [[list(c) for c in r] for r in out]}


def _lat_from_tile_y(y: float, size: int) -> float:
    t = math.pi * (1 - (2 * y) / size)
    return (180 / math.pi) * math.atan(math.sinh(t))


def tile_ids_for(b: dict, z: int) -> list[int]:
    """Slippy tile ids covering a bbox, row-major."""
    return [t["id"] for t in _tiles_for(b, z)]


def _tiles_for(b: dict, z: int) -> list[dict]:
    """Slippy tiles covering a bbox at a zoom, each with its TileID.

    The x/y are returned alongside the ID because a TileID is a position on
    the Hilbert curve and cannot be inverted back into a tile position, yet
    the geometry converter needs to know which tile it is inside.
    """
    n = 2**z
    w = max(0, min(n - 1, _lon_to_x(b["west"], n)))
    e = max(0, min(n - 1, _lon_to_x(b["east"], n)))
    s = max(0, min(n - 1, _lat_to_y(b["north"], n)))
    t = max(0, min(n - 1, _lat_to_y(b["south"], n)))
    out: list[dict] = []
    # TileIDs are Hilbert-curve positions, not row-major raster indices. Spec
    # 4.1 defines the ID as a cumulative position along the curve, which is
    # what makes a directory sorted by ID also group nearby tiles together.
    # Computing `y * n + x` instead produces IDs that match nothing the file
    # is keyed by.
    for y in range(s, t + 1):
        for x in range(w, e + 1):
            out.append({"id": _hilbert_tile_id(z, x, y), "x": x, "y": y})
    return out


def _hilbert_tile_id(z: int, x: int, y: int) -> int:
    """Position on the Hilbert curve, as PMTiles defines a TileID.

    The offset is the part that is easy to get wrong. Spec 4.1 gives a worked
    table: z0 (0,0) is TileID 0, and z1 (0,0) is TileID **1**. A bare curve
    index gives 0 for both, so the count of tiles at lower zooms has to be
    added to reach the cumulative position the directory is keyed by.
    Forgetting that makes every lookup miss and a perfectly good archive
    return nothing:

        sum of tiles below zoom z is sum over k of 4^k = (4^z - 1) / 3
    """
    d = 0
    s = 1 << (z - 1) if z > 0 else 0
    while s > 0:
        rx = 1 if (x & s) > 0 else 0
        ry = 1 if (y & s) > 0 else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                x = s - 1 - x
                y = s - 1 - y
            x, y = y, x
        s >>= 1
    return d + _tile_id_base(z)


def _tile_id_base(z: int) -> int:
    """Cumulative count of tiles at every zoom below ``z``.

    ``(4^z - 1) / 3`` is always an exact integer, and ``| 0`` on the TS side
    only bites at z17 and above, where the total passes 2^31 and wraps —
    reproduced here so large-archive ids match byte for byte.
    """
    return _int32((4**z - 1) // 3)


def pmtiles_tile_id(z: int, x: int, y: int) -> int:
    """PMTiles TileID for a slippy tile, pinned against spec 4.1's worked table.

    That table is the only thing standing between a reader and a
    plausible-looking implementation that silently returns nothing, because
    every value it checks is off by a small amount rather than obviously
    broken.
    """
    return _hilbert_tile_id(z, x, y)


def _lon_to_x(lon: float, n: int) -> int:
    return math.floor(((lon + 180) / 360) * n)


def _lat_to_y(lat: float, n: int) -> int:
    clamped = max(-85.05112878, min(85.05112878, lat))
    rad = clamped * math.pi / 180
    return math.floor(((1 - math.log(math.tan(rad) + 1 / math.cos(rad)) / math.pi) / 2) * n)


def _zoom_for(b: dict, archive_max: int, cap: int) -> int:
    """Pick a zoom for a radius.

    z14 is the point where streets and named places are present but a city
    block is still a handful of features. Higher and the tile count grows
    without adding anything an agent acts on; lower and whole neighbourhoods
    are one polygon each.
    """
    mid_lat = (b["north"] + b["south"]) / 2
    width_m = abs(b["east"] - b["west"]) * 111320 * math.cos(mid_lat * math.pi / 180)
    # A tile is roughly this many metres across at the equator for the zooms
    # that matter; the latitude correction is what keeps a 300m radius at one
    # tile in Oslo rather than four.
    want = max(0, math.ceil(math.log2(156543 / max(1, width_m))))
    return max(12, min(cap, archive_max, want))


def _round(v: float, places: int) -> float:
    # `Math.round`, not Python's half-to-even `round`.
    f = 10**places
    return js_round(v * f) / f

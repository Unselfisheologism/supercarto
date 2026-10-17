"""PMTiles/MVT parity harness, Python side — mirror of ``pmtiles-ts.mjs``.

Builds the same spec-written PMTiles v3 archive, decodes it with the Python
reader, compiles the fetched features, and writes the same canonical JSON
report. ``bash scripts/parity/check.sh`` byte-diffs the two reports.
"""

import gzip
import json
import struct
import sys
import tempfile
from datetime import UTC, datetime
from math import isnan
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python" / "src"))

from supercarto.mvt import decode_mvt
from supercarto.pipeline import to_maplet
from supercarto.protomaps import PmtilesArchive, ProtomapsSource, pmtiles_tile_id

output_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/opencode/pmtiles-parity.py.json"
tmp = Path(tempfile.mkdtemp(prefix="sc-parity-pmtiles-"))

EXTENT = 4096
SF_TILES = [(655, 1583), (654, 1583), (655, 1584)]
SF_BBOX = {"west": -122.4268, "south": 37.7702, "east": -122.4014, "north": 37.7799}


def varint(n: int) -> list[int]:
    out: list[int] = []
    v = n & 0xFFFFFFFF
    while v >= 0x80:
        out.append((v & 0x7F) | 0x80)
        v >>= 7
    out.append(v)
    return out


def svarint(n: int) -> list[int]:
    return varint(((n << 1) ^ (n >> 31)) & 0xFFFFFFFF)


def hilbert(z: int, x: int, y: int) -> int:
    """TileID per PMTiles spec 4.1, written out independently of the reader."""
    d = 0
    s = 1 << (z - 1) if z > 0 else 0
    while s > 0:
        rx = 1 if (x & s) > 0 else 0
        ry = 1 if (y & s) > 0 else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                x, y = s - 1 - x, s - 1 - y
            x, y = y, x
        s >>= 1
    return d + ((4**z - 1) // 3)


def build_mvt(road_name: str = "Market St") -> bytes:
    layer_name = "roads"
    points = [(100, 200), (2000, 200), (2000, 3000), (3000, 3500)]

    geom: list[int] = []
    x = y = 0
    geom += varint(1 | (len(points) << 3))
    for px, py in points:
        geom += svarint(px - x)
        geom += svarint(py - y)
        x, y = px, py
    geom += varint(2 | (1 << 3))
    geom += svarint(500)
    geom += svarint(0)

    tags = [0, 0]  # key 0 -> value 0
    feat = [
        *varint((1 << 3) | 0),
        *varint(42),
        *varint((2 << 3) | 2),
        *varint(len(tags)),
        *tags,
        *varint((3 << 3) | 0),
        *varint(2),
        *varint((4 << 3) | 2),
        *varint(len(geom)),
        *geom,
    ]

    def string_field(field: int, s: str) -> list[int]:
        return [*varint((field << 3) | 2), *varint(len(s)), *[ord(c) for c in s]]

    value_body = string_field(1, road_name)
    layer = [
        *string_field(1, layer_name),
        *varint((2 << 3) | 2),
        *varint(len(feat)),
        *feat,
        *string_field(3, layer_name),
        *varint((4 << 3) | 2),
        *varint(len(value_body)),
        *value_body,
        *varint((5 << 3) | 0),
        *varint(EXTENT),
        *varint((15 << 3) | 0),
        *varint(2),
    ]
    return bytes([*varint((3 << 3) | 2), *varint(len(layer)), *layer])


def build_archive(z: int, tiles: list, tile_compression: int, tile_type: int) -> Path:
    hlen = 127
    payloads = [
        gzip.compress(build_mvt()) if tile_compression == 2 else build_mvt() for _ in tiles
    ]

    entries = sorted(
        (
            {
                "tileId": hilbert(z, t[0], t[1]),
                "runLength": 1,
                "length": len(payloads[i]),
                "offset": sum(len(p) for p in payloads[:i]),
            }
            for i, t in enumerate(tiles)
        ),
        key=lambda e: e["tileId"],
    )

    dirb: list[int] = [*varint(len(entries))]
    last_id = 0
    for e in entries:
        dirb += varint(e["tileId"] - last_id)
        last_id = e["tileId"]
    for e in entries:
        dirb += varint(e["runLength"])
    for e in entries:
        dirb += varint(e["length"])
    next_byte = 0
    for i, e in enumerate(entries):
        marker = 0 if i > 0 and e["offset"] == next_byte else e["offset"] + 1
        dirb += varint(marker)
        next_byte = e["offset"] + e["length"]

    root_dir = bytes(dirb)
    data = b"".join(payloads)
    header = bytearray(hlen)
    header[0:7] = b"PMTiles"
    header[7] = 3

    def p64(off: int, v: int) -> None:
        header[off : off + 8] = v.to_bytes(8, "little")

    p64(8, hlen)
    p64(16, len(root_dir))
    p64(24, 0)
    p64(32, 0)
    p64(40, 0)
    p64(48, 0)
    p64(56, hlen + len(root_dir))
    p64(64, len(data))
    p64(72, len(tiles))
    p64(80, len(entries))
    p64(88, len(payloads))
    header[96] = 1
    header[97] = 0
    header[98] = tile_compression
    header[99] = tile_type
    header[100] = z
    header[101] = z
    header[102] = z
    header[105:109] = struct.pack("<f", 0.5)

    path = tmp / f"test-z{z}-c{tile_compression}-t{tile_type}.pmtiles"
    path.write_bytes(bytes(header) + root_dir + data)
    return path


TILE_ID_TABLE = [
    (0, 0, 0, 0),
    (1, 0, 0, 1),
    (1, 0, 1, 2),
    (1, 1, 1, 3),
    (1, 1, 0, 4),
    (2, 0, 0, 5),
    (12, 3423, 1763, 19078479),
]

report: dict = {
    "tileIds": [[z, x, y, pmtiles_tile_id(z, x, y)] for z, x, y, _ in TILE_ID_TABLE],
    "archives": {},
}

for name in ("gzip", "plain"):
    comp = 2 if name == "gzip" else 1
    path = build_archive(12, SF_TILES, comp, 1)
    archive = PmtilesArchive(str(path))
    h = archive.info()
    entries = archive.directory()
    src = ProtomapsSource(str(path), max_zoom=12, max_tiles=8)
    if not src.available():
        raise RuntimeError(f"{name} archive unavailable")
    res = src.fetch({"bbox": SF_BBOX, "layers": [], "maxFeatures": 500})
    m = to_maplet(
        res["features"],
        {
            "bbox": dict(SF_BBOX),
            "budget": 800,
            "compile": {
                "now": datetime(2026, 10, 1, 12, 0, 0, tzinfo=UTC),
                "utcOffsetMinutes": -420,
            },
        },
    )
    report["archives"][name] = {
        "header": {
            "version": h.version,
            "minZoom": h.minZoom,
            "maxZoom": h.maxZoom,
            "tileType": h.tileType,
            "tileCompression": h.tileCompression,
            "directoryCompression": h.directoryCompression,
            "clustered": h.clustered,
            "addressedTiles": h.addressedTiles,
            "dataLength": h.dataLength,
            "centerZoom": h.centerZoom,
        },
        "directory": [
            {
                "tileId": e.tileId,
                "offset": e.offset,
                "length": e.length,
                "runLength": e.runLength,
            }
            for e in entries
        ],
        "mvt": decode_mvt(build_mvt("Mission St")),
        "features": res["features"],
        "truncated": res["truncated"],
        "warnings": res["warnings"],
        "source": res["source"],
        "yaml": m["yaml"],
        "metrics": {
            "tokens": m["metrics"]["tokens"],
            "nodes": m["metrics"]["nodes"],
            "edges": m["metrics"]["edges"],
            "dropped": m["metrics"]["droppedNodes"],
        },
    }


def canon(v):
    if isinstance(v, list):
        return [canon(x) for x in v]
    if isinstance(v, dict):
        return {k: canon(v[k]) for k in sorted(v)}
    if isinstance(v, bool):
        return v
    if isinstance(v, float) and isnan(v):
        return "NaN"
    return v


Path(output_path).write_text(
    json.dumps(canon(report), separators=(",", ":"), ensure_ascii=False), encoding="utf-8"
)
print(
    json.dumps(
        {
            "gzipFeatures": len(report["archives"]["gzip"]["features"]),
            "gzipYaml": len(report["archives"]["gzip"]["yaml"]),
            "plainFeatures": len(report["archives"]["plain"]["features"]),
        }
    ),
    file=sys.stderr,
)

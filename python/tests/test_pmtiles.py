"""PMTiles and MVT decoding — port of ``test/pmtiles.test.ts``.

Neither module had a test until now, which is how a decoder could disagree with
both published specifications for so long while every other suite stayed green:
nothing ever asserted that a tile produced a feature. The fixtures below are
built from the written specifications rather than from the reader's own output,
so they fail the moment the reader drifts.
"""

from __future__ import annotations

import gzip
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from supercarto.mvt import decode_mvt
from supercarto.pipeline import to_maplet
from supercarto.protomaps import (
    PmtilesArchive,
    ProtomapsSource,
    pmtiles_tile_id,
)

EXTENT = 4096

# San Francisco at z12, which is the zoom the source actually selects for this
# bbox: a ~2.2km-wide box resolves to z7 by its own arithmetic and is floored
# to z12. A fixture at any other zoom tests nothing, because the reader is
# entitled to ask for a different zoom than the fixture happens to hold.
SF_TILES = [(655, 1583), (654, 1583), (655, 1584)]
SF_BBOX = {"west": -122.4268, "south": 37.7702, "east": -122.4014, "north": 37.7799}


# --- fixture builders (spec-written, independent of the reader) -------------

def varint(n: int) -> list[int]:
    out: list[int] = []
    v = n & 0xFFFFFFFF  # JS `>>>` makes the input unsigned
    while v >= 0x80:
        out.append((v & 0x7F) | 0x80)
        v >>= 7
    out.append(v)
    return out


def zsvarint(n: int) -> list[int]:
    zzv = ((n << 1) ^ (n >> 31)) & 0xFFFFFFFF
    return varint(zzv)


def hilbert(z: int, x: int, y: int) -> int:
    """TileID per PMTiles spec 4.1: cumulative position on the Hilbert curve.

    Deliberately written out here rather than imported from the reader. A
    fixture that calls the function under test cannot catch that function being
    wrong.
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
    return d + ((4**z - 1) // 3)


def build_mvt(road_name: str = "Market St") -> bytes:
    """A valid MVT 2.1 tile: one layer, one linestring with a tagged property.

    Field numbers follow MVT 2.1, which renumbered TileLayer to name=1,
    features=2, keys=3, values=4, extent=5, version=15. Geometry is a MoveTo of
    three points followed by one LineTo delta, which is how a multi-point
    linestring is actually written.
    """
    layer_name = "roads"
    points = [[100, 200], [2000, 200], [2000, 3000], [3000, 3500]]

    geom: list[int] = []
    x = 0
    y = 0
    # Geometry command header is (command_id & 0x7) | (count << 3). Getting
    # these the other way round reads count as the command id and vice versa.
    geom += varint(1 | (len(points) << 3))
    for px, py in points:
        geom += zsvarint(px - x)
        geom += zsvarint(py - y)
        x, y = px, py
    geom += varint(2 | (1 << 3))
    geom += zsvarint(500)
    geom += zsvarint(0)

    tags = [0, 0]  # key 0 -> value 0
    feat = [
        *varint((1 << 3) | 0),
        *varint(42),
        *varint((2 << 3) | 2),
        *varint(len(tags)),
        *tags,
        *varint((3 << 3) | 0),
        *varint(2),  # LINESTRING
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
    return bytes(
        [
            *varint((3 << 3) | 2),
            *varint(len(layer)),
            *layer,
        ]
    )


def build_archive(
    z: int, tiles: list[tuple[int, int]], tile_compression: int, tile_type: int, tmp: Path
) -> tuple[Path, list[dict]]:
    """Build a PMTiles v3 archive from the specification.

    The directory is column-major per spec 4.2: count, then every delta-encoded
    tile ID, then every run length, then every length, then every offset. An
    offset is stored as ``offset + 1``, with zero reserved as the marker for
    "contiguous with the previous blob".
    """
    hlen = 127
    payloads = [
        (gzip.compress(build_mvt()) if tile_compression == 2 else build_mvt())
        for _ in tiles
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

    dir_bytes: list[int] = [*varint(len(entries))]
    last_id = 0
    for e in entries:
        dir_bytes += varint(e["tileId"] - last_id)
        last_id = e["tileId"]
    for e in entries:
        dir_bytes += varint(e["runLength"])
    for e in entries:
        dir_bytes += varint(e["length"])
    next_byte = 0
    for i, e in enumerate(entries):
        marker = 0 if i > 0 and e["offset"] == next_byte else e["offset"] + 1
        dir_bytes += varint(marker)
        next_byte = e["offset"] + e["length"]

    root_dir = bytes(dir_bytes)
    data = b"".join(payloads)
    header = bytearray(hlen)
    header[0:7] = b"PMTiles"
    header[7] = 3  # version

    def p64(off: int, v: int) -> None:
        header[off : off + 8] = v.to_bytes(8, "little")

    p64(8, hlen)
    p64(16, len(root_dir))
    p64(24, 0)  # metadata
    p64(32, 0)
    p64(40, 0)  # leaves
    p64(48, 0)
    p64(56, hlen + len(root_dir))
    p64(64, len(data))
    p64(72, len(tiles))  # addressed tiles
    p64(80, len(entries))  # tile entries
    p64(88, len(payloads))  # tile contents
    header[96] = 1  # clustered
    header[97] = 0  # internal compression: none
    header[98] = tile_compression
    header[99] = tile_type
    header[100] = z  # min zoom
    header[101] = z  # max zoom
    header[102] = z  # center zoom (spec position)
    header[105:109] = struct_pack_float_le(0.5)

    path = tmp / f"test-z{z}-c{tile_compression}-t{tile_type}.pmtiles"
    path.write_bytes(bytes(header) + root_dir + data)
    return path, entries


def struct_pack_float_le(v: float) -> bytes:
    """`writeFloatLE`."""
    return struct.pack("<f", v)


# --- MVT decoding ------------------------------------------------------------

def test_reads_the_layer_name_field_1():
    # Written against spec v1 this reads name as a varint and loses it, so the
    # layer arrives nameless and its features cannot be attributed to a layer.
    tile = decode_mvt(build_mvt())
    assert len(tile["layers"]) == 1
    assert tile["layers"][0]["name"] == "roads"


def test_reads_the_extent_field_5():
    assert decode_mvt(build_mvt())["layers"][0]["extent"] == EXTENT


def test_reads_features_field_2():
    assert len(decode_mvt(build_mvt())["layers"][0]["features"]) == 1


def test_keeps_the_feature_id():
    # The id is what deduplicates a road spanning two tiles. Losing it turns
    # every shared road into a duplicate that welds into a self-loop.
    f = decode_mvt(build_mvt())["layers"][0]["features"][0]
    assert f["id"] == 42


def test_resolves_tags_against_the_key_and_value_tables():
    # Tags are indices into tables that appear later in the wire order, so a
    # decoder that resolves eagerly sees an empty table and drops every tag.
    f = decode_mvt(build_mvt("Mission Street"))["layers"][0]["features"][0]
    assert f["properties"]["roads"] == {"string": "Mission Street"}


def test_keeps_a_multi_point_moveto_in_one_part():
    # Breaking a part per MoveTo point turns a single four-point line into
    # fragments of one point each, which reach the compiler as disconnected
    # stubs carrying no length at all.
    geom = decode_mvt(build_mvt())["layers"][0]["features"][0]["geometry"]
    assert geom["type"] == 2
    assert len(geom["rings"]) == 1
    assert len(geom["rings"][0]) == 5


def test_accumulates_coordinates_across_commands():
    # Deltas are relative to the previous point, not to the part origin, so a
    # decoder that resets per command displaces every segment after the first.
    ring = decode_mvt(build_mvt())["layers"][0]["features"][0]["geometry"]["rings"][0]
    assert ring[0] == [100, 200]
    assert ring[1] == [2000, 200]
    assert ring[4] == [3500, 3500]


def test_decodes_zigzag_negatives_without_flipping_them():
    # Half of all deltas are negative; reading them unsigned displaces geometry
    # far outside the tile and every feature is then discarded as out of area.
    ring = decode_mvt(build_mvt())["layers"][0]["features"][0]["geometry"]["rings"][0]
    for px, py in ring:
        assert 0 <= px <= EXTENT
        assert 0 <= py <= EXTENT


def test_returns_no_layers_for_an_empty_tile_rather_than_throwing():
    assert decode_mvt(bytes([0]))["layers"] == []


# --- PMTiles TileID ----------------------------------------------------------

def test_spec_4_1_worked_table():
    # The specification's own worked table, from section 4.1. This is the only
    # independent check on the ID: a reader can be self-consistent, open an
    # archive, report a directory, and still miss every tile because its IDs
    # are offset from the ones the file is keyed by.
    table = [
        (0, 0, 0, 0),
        (1, 0, 0, 1),
        (1, 0, 1, 2),
        (1, 1, 1, 3),
        (1, 1, 0, 4),
        (2, 0, 0, 5),
        (12, 3423, 1763, 19078479),
    ]
    for z, x, y, want in table:
        assert pmtiles_tile_id(z, x, y) == want, f"z{z} {x},{y}"


def test_numbers_z0_as_0_and_z1_as_1_not_0():
    # A bare Hilbert index returns 0 for both. The offset is the whole bug.
    assert pmtiles_tile_id(0, 0, 0) == 0
    assert pmtiles_tile_id(1, 0, 0) == 1


# --- PMTiles directory decoding ---------------------------------------------

def test_decodes_a_column_major_directory_to_exactly_the_written_entries(tmp_path):
    # The failure this pins: reading the directory as interleaved tuples treats
    # the leading entry count as a tile ID and shifts every field after it. The
    # archive still opens and still reports a directory, so nothing looks wrong.
    path, entries = build_archive(12, SF_TILES, 2, 1, tmp_path)
    decoded = PmtilesArchive(str(path)).directory()
    assert [
        {
            "tileId": e.tileId,
            "runLength": e.runLength,
            "length": e.length,
            "offset": e.offset,
        }
        for e in decoded
    ] == entries


def test_honours_the_zero_offset_marker_for_contiguous_tiles(tmp_path):
    # A clustered archive stores 0 to mean "directly after the previous blob",
    # which is what frees zero to mean a genuine offset of 0.
    path, entries = build_archive(12, SF_TILES, 2, 1, tmp_path)
    decoded = PmtilesArchive(str(path)).directory()
    assert decoded[1].offset == entries[0]["length"]


def test_reads_the_header_fields_the_fetch_path_depends_on(tmp_path):
    path, _ = build_archive(12, SF_TILES, 2, 1, tmp_path)
    h = PmtilesArchive(str(path)).info()
    assert h.version == 3
    assert h.minZoom == 12
    assert h.maxZoom == 12
    assert h.tileType == 1
    assert h.tileCompression == 2
    assert h.addressedTiles == 3
    assert h.dataLength > 0


# --- ProtomapsSource against a real archive ----------------------------------

def test_fetches_features_out_of_a_gzip_archive(tmp_path):
    # Before zlib was imported rather than required, this returned zero features
    # and no warning: the per-tile error handler swallowed an ESM/CJS module
    # error, so a completely broken reader looked like an empty area.
    path, _ = build_archive(12, SF_TILES, 2, 1, tmp_path)
    src = ProtomapsSource(str(path), max_zoom=12, max_tiles=8)
    assert src.available() is True

    res = src.fetch({"bbox": SF_BBOX, "layers": [], "maxFeatures": 500})
    assert len(res["features"]) > 0
    assert res["features"][0]["properties"]["class"] == "roads"


def test_fetches_features_from_an_uncompressed_archive_too(tmp_path):
    path, _ = build_archive(12, SF_TILES, 1, 1, tmp_path)
    src = ProtomapsSource(str(path), max_zoom=12, max_tiles=8)
    res = src.fetch({"bbox": SF_BBOX, "layers": [], "maxFeatures": 500})
    assert len(res["features"]) > 0


def test_places_fetched_geometry_inside_the_requested_area(tmp_path):
    # Tile-local integers have to become real coordinates, or every feature is
    # discarded as out of area and the maplet comes back empty.
    path, _ = build_archive(12, SF_TILES, 2, 1, tmp_path)
    src = ProtomapsSource(str(path), max_zoom=12, max_tiles=8)
    res = src.fetch({"bbox": SF_BBOX, "layers": [], "maxFeatures": 500})
    for f in res["features"]:
        assert f["geometry"] is not None
        coords = json.dumps(f["geometry"]["coordinates"])
        # Inside the requested box, and on the right side of the planet.
        assert "-122.4" in coords
        assert "37.7" in coords


def test_compiles_what_it_fetched_into_a_graph_an_agent_can_read(tmp_path):
    path, _ = build_archive(12, SF_TILES, 2, 1, tmp_path)
    src = ProtomapsSource(str(path), max_zoom=12, max_tiles=8)
    res = src.fetch({"bbox": SF_BBOX, "layers": [], "maxFeatures": 500})
    m = to_maplet(res["features"], {"bbox": dict(SF_BBOX), "budget": 800})
    assert "map:" in m["yaml"]
    assert len(m["graph"].nodes) > 0


def test_refuses_a_raster_archive_instead_of_decoding_it_as_vectors(tmp_path):
    path, _ = build_archive(12, SF_TILES, 2, 2, tmp_path)
    src = ProtomapsSource(str(path), max_zoom=12)
    try:
        src.fetch({"bbox": SF_BBOX, "layers": [], "maxFeatures": 100})
        raised = ""
    except Exception as err:  # noqa: BLE001 - asserted below
        raised = str(err)
    assert "raster" in raised


def test_says_the_area_is_incomplete_when_tiles_are_capped(tmp_path):
    # Truncation has to be visible. An agent told a map is complete will route
    # across a gap it cannot see.
    #
    # The bbox is widened to a 3x3 block so there is genuinely more to fetch
    # than the cap allows. A bbox covering one tile cannot demonstrate this,
    # because nothing is ever truncated.
    path, _ = build_archive(12, SF_TILES, 2, 1, tmp_path)
    wide = {"west": -122.40, "south": 37.780, "east": -122.38, "north": 37.790}
    src = ProtomapsSource(str(path), max_zoom=12, max_tiles=1)
    res = src.fetch({"bbox": wide, "layers": [], "maxFeatures": 500})
    assert "not shown" in " ".join(res["warnings"])


def test_reports_unavailable_for_a_missing_archive_rather_than_throwing(tmp_path):
    src = ProtomapsSource(str(tmp_path / "definitely-not-here.pmtiles"))
    assert src.available() is False

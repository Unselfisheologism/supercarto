"""Unit tests for the SCR wire codec (``supercarto.wire``).

Byte parity against the TypeScript is enforced by the offline/live harnesses;
these pin the codec's own invariants: round-trip fidelity, the encoding
thresholds, and the strict-parsing failure modes.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from supercarto.ingest import from_geojson
from supercarto.pipeline import from_scr, to_maplet
from supercarto.types import AttrBool, AttrNum, AttrRef, AttrToken
from supercarto.wire import (
    DELTA_PREFIX,
    ScrError,
    close_ring,
    decode_delta_path,
    decode_document,
    decode_path,
    decode_path_auto,
    decode_polygon,
    decode_props,
    decode_rle_runs,
    decode_sparse_cells,
    encode_delta_path,
    encode_document,
    encode_heat_body,
    encode_path,
    encode_path_smart,
    encode_polygon,
    encode_props,
    encode_sparse_heat,
    open_ring,
    signed_ring_area,
    strict_int,
    strict_num,
)


def _fixture():
    return json.loads((ROOT.parent / "examples" / "sf-mission-5th.geojson").read_text())


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def test_encode_decode_absolute_path():
    pass  # covered test_path_roundtrip; keep a smoke placeholder free of scaffolding


def test_path_roundtrip():
    from supercarto.types import GridPoint

    pts = [GridPoint(x=100, y=200), GridPoint(x=150, y=180)]
    assert encode_path(pts) == "100,200;150,180"
    assert decode_path("100,200;150,180") == pts


def test_delta_path_roundtrip():
    from supercarto.types import GridPoint

    pts = [GridPoint(x=100, y=100), GridPoint(x=150, y=100), GridPoint(x=150, y=150)]
    out = encode_delta_path(pts)
    assert out == "d:100,100,50,0,0,50"
    assert decode_delta_path(out) == pts


def test_delta_path_rejects_odd_and_empty():
    with pytest.raises(ScrError, match="odd coordinate count"):
        decode_delta_path(f"{DELTA_PREFIX}1,2,3")
    with pytest.raises(ScrError, match="at least one vertex"):
        decode_delta_path(DELTA_PREFIX + "5")
    assert decode_delta_path(DELTA_PREFIX) == []


def test_smart_threshold_is_four():
    from supercarto.types import GridPoint

    three = [GridPoint(x=i, y=i) for i in range(3)]
    four = [GridPoint(x=i, y=i) for i in range(4)]
    assert encode_path_smart(three).startswith("0,0;1,1")
    assert encode_path_smart(four).startswith(DELTA_PREFIX)


def test_decode_path_auto_dispatches_on_prefix():
    assert decode_path_auto("1,2") == decode_path("1,2")
    assert decode_path_auto("d:1,2,3,4") == decode_delta_path("d:1,2,3,4")


# ---------------------------------------------------------------------------
# Rings and polygons
# ---------------------------------------------------------------------------


def test_close_ring_and_open_ring():
    from supercarto.types import GridPoint

    open_ = [GridPoint(x=0, y=0), GridPoint(x=4, y=0)]
    closed = close_ring(open_)
    assert len(closed) == 3 and closed[-1] == GridPoint(x=0, y=0)
    assert close_ring(closed) is closed  # already closed
    assert open_ring(closed) == open_
    assert open_ring(open_) is open_


def test_polygon_roundtrip_with_holes_and_parts():
    from supercarto.types import GridPoint, GridPolygonPart

    poly = [
        GridPolygonPart(rings=[
            [GridPoint(x=0, y=0), GridPoint(x=10, y=0), GridPoint(x=10, y=10)],
            [GridPoint(x=2, y=2), GridPoint(x=4, y=2), GridPoint(x=4, y=4)],
        ]),
        GridPolygonPart(rings=[
            [GridPoint(x=20, y=0), GridPoint(x=30, y=0), GridPoint(x=30, y=10)],
        ]),
    ]
    text = encode_polygon(poly)
    # rings keep their open shape and parts stay separated
    assert text.count("||") == 1
    assert decode_polygon(text) == poly


def test_signed_ring_area_winding():
    from supercarto.types import GridPoint

    ccw = [GridPoint(x=0, y=0), GridPoint(x=4, y=0), GridPoint(x=4, y=4)]
    assert signed_ring_area(ccw) > 0
    assert signed_ring_area(list(reversed(ccw))) < 0


# ---------------------------------------------------------------------------
# Props and attribute values
# ---------------------------------------------------------------------------


def test_props_roundtrip_all_value_kinds():
    from supercarto.types import Prop

    props = [
        Prop(key=10, value=AttrRef(ref=107)),
        Prop(key=12, value=AttrNum(num=18)),
        Prop(key=21, value=AttrBool(bool=True)),
        Prop(key=13, value=AttrToken(token="bank")),
    ]
    text = encode_props(props)
    assert text == "10=s107;12=18;21=true;13=bank"
    out = decode_props(text)
    assert isinstance(out[0].value, AttrRef) and out[0].value.ref == 107
    assert isinstance(out[1].value, AttrNum) and out[1].value.num == 18
    assert isinstance(out[2].value, AttrBool) and out[2].value.bool is True
    assert isinstance(out[3].value, AttrToken) and out[3].value.token == "bank"


def test_decode_props_primitives():
    assert decode_props("") == []
    assert decode_props("0") == []
    with pytest.raises(ScrError, match="malformed property"):
        decode_props("10novalue")


# ---------------------------------------------------------------------------
# Heat
# ---------------------------------------------------------------------------


def test_heat_encodings_roundtrip():
    from supercarto.types import HeatCell, HeatLayer, HeatRow, HeatRun, IndexedHeatCell

    sparse = HeatLayer(id=1, name="poi_density", resolution=32, minValue=1, maxValue=4,
                       encoding="sparse", cells=[HeatCell(x=0, y=1, value=2.5)])
    assert encode_sparse_heat(sparse) == ["X 1 0,1,2.5"]
    body = encode_heat_body(sparse)[0]
    assert decode_sparse_cells(body.split(" ", 2)[2]) == sparse.cells

    rle = HeatLayer(id=2, name="r", resolution=16, minValue=0, maxValue=3,
                    encoding="rle", rows=[HeatRow(y=7, runs=[HeatRun(x=1, len=4, value=1.0)])])
    lines = encode_heat_body(rle)
    assert lines == ["D 2 7 1,4,1"]
    assert decode_rle_runs(lines[0].split(" ", 3)[3]) == rle.rows[0].runs

    cell = HeatLayer(id=3, name="c", resolution=8, minValue=0, maxValue=1,
                     encoding="cell", indexed=[IndexedHeatCell(cell="892fb10", value=0.5)])
    assert encode_heat_body(cell) == ["HC 3 892fb10 0.5"]


# ---------------------------------------------------------------------------
# Scalars
# ---------------------------------------------------------------------------


def test_strict_int_rejects_non_integers():
    assert strict_int("-42") == -42
    for bad in ("1.5", "abc", "1e3", "0x1f", ""):
        with pytest.raises(ScrError, match="expected integer"):
            strict_int(bad)


def test_strict_num_rejects_non_numbers():
    assert strict_num("18.5") == 18.5
    assert strict_num("-0.25") == -0.25
    for bad in ("abc", "NaN", "Infinity", "cafe", "1_0"):
        with pytest.raises(ScrError, match="expected number"):
            strict_num(bad)


# ---------------------------------------------------------------------------
# Document decode: error surfaces
# ---------------------------------------------------------------------------


def test_decode_error_messages_carry_line_numbers():
    with pytest.raises(ScrError) as e:
        decode_document("SCR 1\nBBOX 0 0 1 1\nQ 4096\nOOPS badtag\n")
    assert e.value.line == 4

    with pytest.raises(ScrError, match="missing Q record"):
        decode_document("SCR 1\nBBOX 0 0 1 1\n")

    with pytest.raises(ScrError, match="header"):
        decode_document("X 1\n")

    with pytest.raises(ScrError, match="major version"):
        decode_document("SCR 2\nBBOX 0 0 1 1\nQ 4096\n")

    with pytest.raises(ScrError, match="unknown projection"):
        decode_document("SCR 1\nBBOX 0 0 1 1\nPROJ equirect\nQ 4096\n")


def test_decode_requires_envelope_and_q():
    with pytest.raises(ScrError, match="TILE or BBOX"):
        decode_document("SCR 1\nQ 4096\n")
    with pytest.raises(ScrError, match="quantization extent"):
        decode_document("SCR 1\nBBOX 0 0 1 1\n")


def test_decode_tile_envelope_and_buf():
    doc = decode_document("SCR 1\nTILE 12 1203 1451\nQ 4096\nBUF 32\n")
    assert doc.envelope == {"type": "tile", "z": 12, "x": 1203, "y": 1451} or (
        doc.envelope.type == "tile" and doc.envelope.z == 12
    )
    assert doc.buffer == 32


def test_step_kv_extraction_and_instruction_tail():
    text = (
        "SCR 1\nBBOX 0 0 1 1\nQ 4096\n"
        "STEP 1 dist=12 turn=19th Street head out\n"
        "STEP 2 ref=104 continue on Oak Street\n"
    )
    with pytest.raises(ScrError, match="before any ROUTE record"):
        decode_document(text)


def test_step_requires_instruction():
    with pytest.raises(ScrError, match="needs an instruction"):
        decode_document("SCR 1\nBBOX 0 0 1 1\nQ 4096\nROUTE 1 walk\nSTEP 1\n")


def test_step_instruction_may_contain_streets_and_refs():
    doc = decode_document(
        "SCR 1\nBBOX 0 0 1 1\nQ 4096\n"
        "ROUTE 1 walk dist=156 time=27\n"
        "STEP 1 head out\n"
        "STEP 2 dist=127 turn=19th Street turn right onto 19th Street\n"
    )
    r = doc.routes[0]
    assert r.dist == 156 and r.time == 27
    # Reference quirk, reproduced for parity: the kv parser takes `(\S+)`, so a
    # `turn` whose street name contains a space loses everything after that
    # space into the instruction (`19th` stays turn, `Street...` joins the
    # prose). The encoder emits turn before the free-text tail — this makes
    # such a roundtrip lossy on the TypeScript reference too. Keeping values
    # single-token is a parser contract, to revisit when the reference does.
    assert r.steps[1].instruction == "Street turn right onto 19th Street"
    assert r.steps[1].turn == "19th"


def test_step_instruction_clean_roundtrip_for_single_token_turns():
    """A single-token turn survives the reference regex exactly."""
    doc = decode_document(
        "SCR 1\nBBOX 0 0 1 1\nQ 4096\n"
        "ROUTE 1 walk\nSTEP 1 dist=12 ref=103 turn=cafe arrive on foot\n"
    )
    step = doc.routes[0].steps[0]
    assert (step.dist, step.ref, step.turn) == (12, 103, "cafe")
    assert step.instruction == "arrive on foot"
    scr = encode_document(doc)
    assert "STEP 1 dist=12 ref=103 turn=cafe arrive on foot" in scr


def test_decode_feature_kinds_and_geometry():
    doc = decode_document(
        "SCR 1\nBBOX 0 0 1 1\nQ 4096\n"
        "S 10 name\nA 1 10=s10\n"
        "F 4 1 2 P 1 500,1000\n"
        # delta paths for lines: `d:` prefix survives the L payload
        "F 5 1 3 L 0 d:1,2,3,3,2,4|5,5\n"
        "F 6 2 0 G 1 0,0;4,0;4,4||20,0;30,0;30,10\n"
    )
    assert doc.features[0].geometry.kind == "point"
    assert doc.features[0].geometry.point.x == 500
    assert doc.features[1].geometry.kind == "line"
    lines = doc.features[1].geometry.lines
    assert len(lines) == 2 and lines[0][1].x == 4 and lines[0][1].y == 5
    assert doc.features[2].geometry.kind == "polygon"
    assert len(doc.features[2].geometry.polygon) == 2

    with pytest.raises(ScrError, match="unknown geometry kind"):
        decode_document(
            "SCR 1\nBBOX 0 0 1 1\nQ 4096\nF 4 1 2 Z 0 500,1000\n"
        )

    with pytest.raises(ScrError, match="maxFeatures"):
        decode_document(
            "SCR 1\nBBOX 0 0 1 1\nQ 4096\nF 4 1 2 P 0 5,5\n",
            {"maxFeatures": 0},
        )


# ---------------------------------------------------------------------------
# Pipeline integration
# ---------------------------------------------------------------------------


def test_to_maplet_carries_scr_and_from_scr_recompiles():
    r = to_maplet(_fixture(), budget=1024)
    assert r["scr"].startswith("SCR 1\n")
    assert r["metrics"]["wireBytes"] == len(r["scr"].encode("utf-8"))
    assert r["metrics"]["wireTokens"] == (r["metrics"]["wireBytes"] + 3) // 4

    r2 = from_scr(r["scr"], {"budget": 1024})
    assert r2["yaml"] == r["yaml"]
    assert r2["metrics"]["tokens"] == r["metrics"]["tokens"]


def test_encode_document_roundtrip_is_a_fixed_point():
    """decode(encode(doc)) re-encodes to identical bytes: the dictionary sort
    and the delta-vs-absolute choice are stable across passes."""
    r = to_maplet(_fixture(), budget=1024)
    once = encode_document(decode_document(r["scr"]), {"group": False})
    assert once == r["scr"]
    twice = decode_document(once)
    assert encode_document(twice, {"group": False}) == once
    # grouped form differs in blank lines only
    grouped = encode_document(r["doc"], {"group": True})
    ungrouped = encode_document(r["doc"], {"group": False})
    stripped = "".join(line + "\n" for line in grouped.split("\n") if line != "")
    assert stripped == ungrouped


def test_ingest_document_roundtrips_through_the_codec():
    doc = from_geojson(_fixture())
    text = encode_document(doc)
    back = decode_document(text)
    assert len(back.features) == len(doc.features)
    assert back.meta == doc.meta
    assert {k: v.props for k, v in back.attrSets.items()} == {
        k: v.props for k, v in doc.attrSets.items()
    }
    # and the compiled result is unaffected by the trip: the doc passthrough
    # is how the live path would feed a decoded document back in.
    a = to_maplet({"type": "FeatureCollection", "features": []}, {"doc": doc, "budget": 1024})["yaml"]
    b = to_maplet({"type": "FeatureCollection", "features": []}, {"doc": back, "budget": 1024})["yaml"]
    assert a == b

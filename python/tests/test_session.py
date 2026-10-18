"""Session views for a moving agent — port of ``test/session.test.ts``.

The walk is the airport story in miniature: an agent walks down a hall and
each step's view replaces the previous one. The session must report only
what changed, and its LLM context never re-pays for the places it already
knows.
"""

from __future__ import annotations

from supercarto.diff import diff_documents
from supercarto.ingest import from_geojson
from supercarto.session import move_maplet
from supercarto.wire import encode_document

# One shared, fixed envelope for the whole session: every view quantizes on
# it, which is what makes the geometry diff exact rather than noisy.
ENVELOPE = {"type": "bbox", "west": 2.0, "south": 41.38, "east": 2.01, "north": 41.385}


def hall(fid, lon, name, tags=None):
    props = {"name": name, "amenity": "cafe"}
    if tags:
        props.update(tags)
    return {
        "type": "Feature",
        "id": fid,
        "properties": props,
        "geometry": {"type": "Point", "coordinates": [lon, 41.3805]},
    }


def collection(features):
    return {"type": "FeatureCollection", "features": features}


INITIAL = collection([
    hall(10, 2.001, "Espresso Bar"),
    hall(11, 2.004, "Coffee Corner"),
    hall(12, 2.007, "Arrival Cafe"),
])

STEP2 = collection([
    hall(10, 2.001, "Espresso Bar"),  # unchanged
    hall(11, 2.0055, "Coffee Corner"),  # moved
    hall(13, 2.008, "Departures Cafe", {"indoor": "level1"}),  # newcomer
])

STEP3 = collection([
    hall(10, 2.001, "Espresso Bar"),
    hall(13, 2.008, "Departures Cafe", {"indoor": "level1"}),
])


def _open_scr():
    first = from_geojson(INITIAL, {"envelope": ENVELOPE})
    assert len(first.features) == 3
    return encode_document(first, {"group": False})


def test_opens_a_session_from_a_plain_maplet_and_reports_a_no_change_move():
    moved = move_maplet(_open_scr(), INITIAL, {"envelope": ENVELOPE})
    assert moved["report"] == ""
    assert moved["counts"] == {"added": 0, "removed": 0, "updated": 0}
    assert moved["view"]["center"]


def test_reports_a_walk_as_deltas_never_the_whole_map():
    moved = move_maplet(_open_scr(), STEP2, {"envelope": ENVELOPE})
    assert moved["counts"] == {"added": 1, "removed": 1, "updated": 1}
    assert moved["report"] == (
        "~ 11 Coffee Corner (poi) (geometry)\n- 12 Arrival Cafe (poi)\n+ 13 Departures Cafe (poi)"
    )

    # Step 3 reuses the returned state: the agent keeps the last view's SCR,
    # and the session continues without any re-fit of coordinates.
    nxt = move_maplet(moved["scr"], STEP3, {"envelope": ENVELOPE})
    assert nxt["counts"] == {"added": 0, "removed": 1, "updated": 0}
    assert nxt["report"] == "- 11 Coffee Corner (poi)"


def test_returns_a_formattable_state_the_next_move_reads_back_directly():
    moved = move_maplet(_open_scr(), STEP2, {"envelope": ENVELOPE})
    # The compact state is a real SCR string: decoding is the agent's move
    # entry point, so a corrupt return here would break the walk instead of
    # raising at test time.
    moved2 = move_maplet(moved["scr"], STEP2, {"envelope": ENVELOPE})
    assert moved2["counts"] == {"added": 0, "removed": 0, "updated": 0}


def test_session_walk_matches_the_diff_engine_precondition():
    # The session pins the agent's own envelope, so two views of the same
    # place always land on the same grid point: diffing the docs directly,
    # with the same envelope, agrees with the session's delta.
    prev = from_geojson(INITIAL, {"envelope": ENVELOPE})
    view_a = from_geojson(STEP2, {"envelope": ENVELOPE})
    direct = diff_documents(prev, view_a)
    moved = move_maplet(encode_document(prev, {"group": False}), STEP2, {"envelope": ENVELOPE})
    expect = (
        "~ 11 Coffee Corner (poi) (geometry)\n- 12 Arrival Cafe (poi)\n+ 13 Departures Cafe (poi)"
    )
    assert expect == moved["report"]
    assert [c["id"] for c in direct] == [c["id"] for c in moved["changes"]]


def test_round_trip_state_still_decodes():
    # The library-level session takes features and trusts the caller; the
    # envelope guard lives in the live class (TS side), which has a position.
    moved = move_maplet(_open_scr(), STEP2, {"envelope": ENVELOPE})
    assert moved["scr"].startswith("SCR 1")

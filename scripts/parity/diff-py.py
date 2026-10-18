# Parity harness, diff engine, Python side.
#
# Builds the same two SCR documents as scripts/parity/diff-ts.mjs and prints
# the same report. Byte-identical output (modulo JSON spacing) is the gate
# for the Python diff port.

import json
import sys

sys.path.insert(0, '/root/supercarto/python/src')

from supercarto.diff import diff_documents, render_diff
from supercarto.ingest import from_geojson
from supercarto.session import move_maplet
from supercarto.wire import encode_document


def pt(lon, lat, name, fid, tags=None):
    props = {"name": name, "amenity": "cafe"}
    if tags:
        props.update(tags)
    return {
        "type": "Feature",
        "id": fid,
        "properties": props,
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
    }


# Document A (the map the agent holds).
a = {
    "type": "FeatureCollection",
    "features": [
        pt(2.0, 41.38, "Cafe Alpha", 10),
        pt(2.005, 41.381, "Cafe Beta", 11),
        pt(2.004, 41.3825, "Cafe Gamma", 12, {"wheelchair": "yes"}),
        pt(2.008, 41.383, "Cafe Delta", 13),
    ],
}

# Document B (the next view, moments later): 10 moved, 11 renamed,
# 12 lost its wheelchair tag, 13 left view, 14 entered view, and 15
# differs only by class (amenity vs shop), same name and geometry.
b = {
    "type": "FeatureCollection",
    "features": [
        pt(2.002, 41.3802, "Cafe Alpha", 10),
        pt(2.005, 41.381, "Cafe Beta II", 11),
        pt(2.004, 41.3825, "Cafe Gamma", 12),
        pt(2.006, 41.384, "Cafe Echo", 14),
        {
            "type": "Feature",
            "id": 15,
            "properties": {"name": "Bakery Echo", "shop": "bakery"},
            "geometry": {"type": "Point", "coordinates": [2.0065, 41.3842]},
        },
    ],
}

# One shared envelope, pinned explicitly: both documents must quantize
# identically (the same precondition the session enforces by re-ingesting
# every move under the session's envelope), and the harness must mirror it.
ENVELOPE = {"type": "bbox", "west": 2.0, "south": 41.38, "east": 2.01, "north": 41.385}

# The harness compiles at a fixed instant so the sun line is deterministic:
# session moves re-compile, and a live clock on each side would only agree
# by luck. Python compile takes a datetime; the TS harness passes a Date.
from datetime import UTC, datetime

COMPILE = {"now": datetime(2026, 10, 18, 12, 0, tzinfo=UTC), "utcOffsetMinutes": 0}

doc_a = from_geojson(a, {"envelope": ENVELOPE})
doc_b = from_geojson(b, {"envelope": ENVELOPE})

changes = diff_documents(doc_a, doc_b)
report = {"changes": changes, "rendered": render_diff(changes, doc_a, doc_b)}

# Session walk stage, mirrored from diff-ts.mjs: open the agent's state as
# SCR from document A, take a step to view B, then a step to view C (a
# subset: one departed place). Byte-identical JSON is the gate.
scr_a = encode_document(doc_a, {"group": False})

view_c = {
    "type": "FeatureCollection",
    "features": [
        pt(2.002, 41.3802, "Cafe Alpha", 10),
        pt(2.006, 41.384, "Cafe Echo", 14),
    ],
}

move1 = move_maplet(scr_a, b, {"envelope": ENVELOPE, "compile": COMPILE})
move2 = move_maplet(move1["scr"], view_c, {"envelope": ENVELOPE, "compile": COMPILE})

print(
    json.dumps(
        {
            "engine": report,
            "session": [
                {
                    "counts": m["counts"],
                    "report": m["report"],
                    "scr": m["scr"],
                    "yaml": m["yaml"],
                    "metrics": m["metrics"],
                    "view": m["view"],
                }
                for m in (move1, move2)
            ],
        },
        separators=(",", ":"),
    )
)

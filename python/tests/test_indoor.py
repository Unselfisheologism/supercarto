"""Unit tests for the indoor floor-graph builder (``supercarto.indoor``)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from supercarto.compiler import compile as compile_graph
from supercarto.indoor import (
    IndoorFeature,
    build_indoor_graph,
    is_meaningful_indoor,
    level_label,
)


def _fixture():
    return json.loads((ROOT.parent / "examples" / "indoor-mall.geojson").read_text())


def _feature(**kw) -> IndoorFeature:
    defaults = {"id": 1.0, "x": 100.0, "y": 100.0}
    return IndoorFeature(**(defaults | kw))


def test_empty_and_untagged_inputs_yield_the_empty_graph():
    assert build_indoor_graph([], {"metresPerUnit": 0.1}) == build_indoor_graph(
        [], {"metresPerUnit": 0.1}
    )
    untagged = [_feature(level=None)]
    assert build_indoor_graph(untagged, {"metresPerUnit": 0.1}).levels == []


def test_levels_collapse_into_a_multi_storey_graph():
    feats = [
        _feature(id=1.0, level=0.0, indoor="corridor", x=10, y=10),
        _feature(id=2.0, level=1.0, indoor="corridor", x=10, y=10),
        _feature(id=3.0, level=0.0, indoor="room", room=True, name="Cafe", x=20, y=10),
        _feature(id=4.0, level=1.0, indoor="room", room=True, name="Books", x=20, y=10),
    ]
    g = build_indoor_graph(feats, {"metresPerUnit": 0.25, "maxNodesPerLevel": 60, "maxLevels": 8})
    assert g.multiStorey is True
    assert [l.level for l in g.levels] == [0.0, 1.0]
    assert g.levels[0].label == "ground"
    # each room connects to its floor's corridor
    assert len(g.levels[0].edges) >= 1 and len(g.levels[1].edges) >= 1


def test_lift_spans_storeys_and_is_not_a_floor_node():
    feats = [
        _feature(id=1.0, level=0.0, indoor="corridor", x=10, y=10),
        _feature(id=2.0, level=0.0, indoor="lift", x=30, y=10, wheelchair=True),
        _feature(id=3.0, level=1.0, indoor="lift", x=30, y=10, wheelchair=True),
        _feature(id=4.0, level=1.0, indoor="corridor", x=10, y=10),
    ]
    g = build_indoor_graph(feats, {"metresPerUnit": 0.25})
    assert len(g.vertical) == 1
    v = g.vertical[0]
    assert (v.kind, v.levels, v.wheelchair) == ("lift", [0.0, 1.0], True)
    # the shaft features were consumed as vertical links, not per-floor nodes
    for level in g.levels:
        assert all(n.kind != "lift" for n in level.nodes)


def test_storey_without_corridor_is_omitted_with_reason():
    feats = [
        _feature(id=1.0, level=0.0, indoor="corridor", x=10, y=10),
        # fractional half-storey: no corridor up there
        _feature(id=2.0, level=2.5, indoor="room", room=True, x=15, y=10),
    ]
    g = build_indoor_graph(feats, {"metresPerUnit": 0.25})
    assert [o.level for o in g.omitted] == [2.5]
    assert g.omitted[0].reason == "no corridor to connect rooms to"
    # the untagged gap storeys between 0 and 2.5 are reported, not invented
    assert g.missingLevels == [1.0, 2.0]


def test_is_meaningful_indoor_threshold():
    from types import SimpleNamespace

    one_node = SimpleNamespace(levels=[], vertical=[])
    assert not is_meaningful_indoor(one_node)

    g = build_indoor_graph(
        [
            _feature(id=1.0, level=0.0, indoor="corridor", x=0, y=0),
            _feature(id=2.0, level=0.0, indoor="room", room=True, x=1, y=1),
        ],
        {"metresPerUnit": 0.25},
    )
    # corridor + 1 room = 2 floor nodes, no vertical: not an indoor map
    assert g.levels and not is_meaningful_indoor(g)

    full = build_indoor_graph(
        [
            _feature(id=1.0, level=0.0, indoor="corridor", x=0, y=0),
            _feature(id=2.0, level=0.0, indoor="room", room=True, x=1, y=1),
            _feature(id=3.0, level=0.0, indoor="room", room=True, name="X", x=2, y=1),
        ],
        {"metresPerUnit": 0.25},
    )
    assert is_meaningful_indoor(full)


def test_level_labels():
    assert level_label(0) == "ground"
    assert level_label(1) == "1"
    assert level_label(-1) == "basement"
    assert level_label(-3) == "basement 3"
    assert level_label(12) == "12"


def test_compiler_emits_the_indoor_block():
    graph = compile_graph(_fixture_as_doc(), {})
    assert graph.indoor.levels, "fixture must produce per-floor graphs"
    # corridor-bearing storeys make it into the graph...
    assert [l.level for l in graph.indoor.levels] == [0.0, 1.0]
    # ...and the basement/corridor-less half-storey are reported as omitted
    assert [o.level for o in graph.indoor.omitted] == [-1.0, 2.5]
    assert all("no corridor" in o.reason for o in graph.indoor.omitted)
    # both shafts collapsed across storeys
    assert [(v.kind, v.levels) for v in graph.indoor.vertical] == [
        ("lift", [0.0, 1.0]),
        ("stairs", [0.0, 1.0]),
    ]


def _fixture_as_doc():
    from supercarto.ingest import from_geojson

    return from_geojson(_fixture())

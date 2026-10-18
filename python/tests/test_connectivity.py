"""Connectivity guarantees under a real token budget.

Port of ``test/connectivity.test.ts``. The budgeter keeps the network whole
while connected pruning still reaches the budget, and fragments only under
hard pressure (the alternative is landmark deletion; see supercarto issue
#3). Its hard invariants, either way: no surviving landmark is stranded, no
after-component mixes nodes from different pre-prune components, and every
surviving edge still has its mirror so the directed reading stays navigable.
"""

from __future__ import annotations

import json
import math
import re
from itertools import combinations
from pathlib import Path

import pytest

from supercarto.budget import _articulation_points, contract_anonymous_chains
from supercarto.compiler import compile
from supercarto.emit import emit_graph
from supercarto.graph import GraphEdge, GraphMeta, GraphNode, SpatialGraph
from supercarto.ingest import from_geojson
from supercarto.pipeline import to_maplet

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[2] / "examples" / "synthetic-dense.geojson").read_text()
)


def node(id_: str) -> GraphNode:
    return GraphNode(id=id_, kind="intersection", features=[])


def edge(a: str, b: str, dx: float = 1, dy: float = 0) -> GraphEdge:
    return GraphEdge(
        from_=a,
        to=b,
        dx=dx,
        dy=dy,
        dist=math.hypot(dx, dy),
        dir="east",
        path="road",
        features=[],
    )


def pair(a: str, b: str, dx: float = 1, dy: float = 0) -> list[GraphEdge]:
    return [
        edge(a, b, dx, dy),
        GraphEdge(from_=b, to=a, dx=-dx, dy=-dy, dist=math.hypot(dx, dy), dir="west", path="road", features=[]),
    ]


def components(nodes, edges, directed: bool = False) -> dict[str, int]:
    adj: dict[str, list[str]] = {n.id: [] for n in nodes}
    for e in edges:
        adj[e.from_].append(e.to)
        if not directed:
            adj[e.to].append(e.from_)
    labels: dict[str, int] = {}
    count = 0
    for n in nodes:
        if n.id in labels:
            continue
        stack = [n.id]
        while stack:
            id_ = stack.pop()
            if id_ in labels:
                continue
            labels[id_] = count
            stack.extend(adj[id_])
        count += 1
    return labels


@pytest.fixture(scope="module")
def original():
    return compile(from_geojson(FIXTURE, {}))


@pytest.fixture(scope="module")
def labels(original) -> dict[str, int]:
    return components(original.nodes, original.edges)


def test_compiles_actual_reverse_endpoints_and_negative_reverse_deltas(original):
    edges = original.edges
    for e in edges:
        assert any(
            r.from_ == e.to and r.to == e.from_ and r.dx == -e.dx and r.dy == -e.dy
            for r in edges
        )


@pytest.mark.parametrize("budget", [512, 1024, 2048, 4096])
def test_splits_honestly_under_a_real_token_budget(budget: int, labels: dict[str, int]):
    r = to_maplet(FIXTURE, {"budget": budget})
    assert r["metrics"]["tokens"] <= budget
    assert any(n.name is not None for n in r["graph"].nodes)
    assert r["graph"].partial is True
    assert any(o.count > 0 for o in r["graph"].omitted)
    after = components(r["graph"].nodes, r["graph"].edges)
    # The budgeter's promise, tiered (issue #3): connectivity is kept while it
    # still reaches the budget, and fragmentation is the documented escape
    # once connected pruning is exhausted - the alternative being landmark
    # deletion. Three hard invariants hold either way:
    # 1. no stranding: every retained landmark keeps access;
    # 2. no cross-merging: two nodes in the same after-component were in the
    #    same component before pruning (removals and contractions never join
    #    previously-unreachable nodes);
    # 3. mirrored edges agree: every directed statement is reversible.
    for a in r["graph"].nodes:
        if a.name is not None:
            assert any(e.from_ == a.id or e.to == a.id for e in r["graph"].edges)
    for a in r["graph"].nodes:
        for b in r["graph"].nodes:
            if after[a.id] == after[b.id]:
                assert labels[a.id] == labels[b.id]
    for e in r["graph"].edges:
        assert any(r.from_ == e.to and r.to == e.from_ for r in r["graph"].edges)


def test_stays_connected_at_a_budget_the_connected_skeleton_can_afford():
    """At a generous budget the fit never fragments."""
    r = to_maplet(FIXTURE, {"budget": 8192})
    assert r["metrics"]["tokens"] <= 8192
    assert any(n.name is not None for n in r["graph"].nodes)
    after = components(r["graph"].nodes, r["graph"].edges)
    assert len(set(after.values())) == 1


def test_articulation_points_match_brute_force_component_counts():
    """Oracle: every undirected five-node graph."""
    nodes = [node(i) for i in "abcde"]
    ids = [n.id for n in nodes]
    for mask in range(2 ** len(list(combinations(ids, 2)))):
        edges: list[GraphEdge] = []
        for i, (a, b) in enumerate(combinations(ids, 2)):
            if mask & (1 << i):
                edges.extend(pair(a, b))
        keep = {n.id: None for n in nodes}
        count = len(set(components(nodes, edges).values()))
        expected = sorted(
            n.id
            for n in nodes
            if len(
                set(
                    components(
                        [x for x in nodes if x.id != n.id],
                        [e for e in edges if e.from_ != n.id and e.to != n.id],
                    ).values()
                )
            )
            > count
        )
        assert sorted(_articulation_points(nodes, edges, keep)) == expected


def test_skips_asymmetric_candidate_without_skipping_a_later_valid_passage():
    nodes = [node(i) for i in "abcdef"]
    edges = [edge("a", "b"), edge("b", "c"), *pair("d", "e"), *pair("e", "f")]
    contract_anonymous_chains(nodes, edges)
    assert any(n.id == "b" for n in nodes)
    assert not any(n.id == "e" for n in nodes)
    assert any(e.from_ == "f" and e.to == "d" for e in edges)


def test_leaves_restricted_or_differently_labelled_passages_explicit():
    for change in ("blocked", "different-path"):
        nodes = [node(i) for i in "abc"]
        edges = [*pair("a", "b"), *pair("b", "c")]
        if change == "blocked":
            for e in edges:
                e.blocked = True
        else:
            edges[0].path = "stairs"
        assert contract_anonymous_chains(nodes, edges) == 0
        assert len(nodes) == 3


def test_does_not_create_duplicate_directed_yaml_edge_keys_around_a_triangle():
    nodes = [node(i) for i in "abc"]
    edges = [*pair("a", "b"), *pair("b", "c"), *pair("a", "c")]
    assert contract_anonymous_chains(nodes, edges) == 0
    assert len(edges) == 6


def test_preserves_bent_path_lengths_with_anisotropic_scale_and_both_directions():
    nodes = [node(i) for i in "abcd"]
    edges = [*pair("a", "b", 3, 0), *pair("b", "c", 0, 4), *pair("c", "d", 3, 0)]
    assert contract_anonymous_chains(nodes, edges) == 2
    assert len(edges) == 2
    for e in edges:
        assert e.dist == 10
    g = SpatialGraph(
        meta=GraphMeta(center="0,0"),
        nodes=nodes,
        edges=edges,
        obstacles=[],
        heat=[],
        indoor=None,
        omitted=[],
        tools=[],
        pinned=[],
        partial=False,
    )
    yaml = emit_graph(g, {"scale": {"x": 2, "y": 3}, "includeIndoor": False})["yaml"]
    assert len(re.findall(r"dist: 24m", yaml)) == 2
    assert edges[0].dx == -edges[1].dx
    assert edges[0].dy == -edges[1].dy

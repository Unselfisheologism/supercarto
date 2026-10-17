#!/usr/bin/env python3
"""Debug the budget loop: replicate the TS fitToBudget stepwise and log it.

Prints one ITER line per batch removal (current estimate, batch size, first
removed ids), plus a per-candidate decision trace for a chosen iteration so
the first divergent skip between Python and TypeScript can be located.
Pair with ``scripts/parity/budget-dbg.ts``.

    python3 scripts/parity/debug-py.py examples/synthetic-dense.geojson [traceIter]
"""

import json
import math
import sys
import datetime as dt
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python" / "src"))

from supercarto.ingest import from_geojson
from supercarto.compiler import compile
from supercarto.budget import (
    _rank_nodes,
    _articulation_points,
    _incident_count,
    _would_orphan_landmark,
    contract_anonymous_chains,
    DEFAULT_OVERHEAD,
    DEFAULT_LANDMARKS_PER_TOKEN,
)
from supercarto.graph import OmittedEntry

data = json.loads(Path(sys.argv[1]).read_text())
trace_iter = int(sys.argv[2]) if len(sys.argv) > 2 else 3

doc = from_geojson(data, {})
graph = compile(doc, {"now": dt.datetime(2026, 10, 1, 12, tzinfo=dt.timezone.utc), "utcOffsetMinutes": -420})

nodes = list(graph.nodes)
edges = list(graph.edges)
omissions = list(graph.omitted)
# Mirror fitToBudget: the landmark set the budgeter must not strand.
landmarks = set(graph.pinned)
dropped_nodes = 0

dropped_nodes += contract_anonymous_chains(nodes, edges, lambda removed: None)

ranked = _rank_nodes(nodes, edges)
keep = {n.id: None for n in ranked}


def _estimate_graph_tokens(nodes, edges, graph):
    node_chars = len(nodes) * 28
    edge_chars = len(edges) * 46
    overhead_chars = 120 + len(graph.obstacles) * 40 + len(graph.omitted) * 40 + len(graph.heat) * 60
    return math.ceil((node_chars + edge_chars + overhead_chars) / 4)


current = _estimate_graph_tokens(nodes, edges, graph)
guard = 0
batch = max(1, len(nodes) // 8)
stalls = 0
trace = []

while current > math.floor(1024 * (1 - DEFAULT_OVERHEAD)) and guard < 2000:
    guard += 1
    budget = 1024
    target = budget - math.floor(budget * DEFAULT_OVERHEAD)
    cuts = _articulation_points(nodes, edges, keep)
    live_named = sum(1 for n in nodes if n.id in keep and n.name is not None)
    min_landmarks = max(4, math.floor(budget / DEFAULT_LANDMARKS_PER_TOKEN + 0.5))
    remove = {}
    named_left = live_named
    live_edge_count = sum(1 for e in edges if e.from_ in keep and e.to in keep)
    for i in range(len(ranked) - 1, -1, -1):
        n = ranked[i]
        if len(remove) >= batch:
            break
        if n.id not in keep or n.id in remove:
            continue
        if n.id in cuts:
            if guard == trace_iter:
                trace.append(("CUT", n.id))
            continue
        if live_edge_count >= 2 and live_edge_count - _incident_count(edges, n.id) < 2:
            if guard == trace_iter:
                trace.append(("EDGEFLOOR", n.id))
            continue
        if n.name is not None:
            if named_left <= min_landmarks:
                if guard == trace_iter:
                    trace.append(("NAMEDFLOOR", n.id))
                continue
            named_left -= 1
        if _would_orphan_landmark(edges, n.id, landmarks, keep):
            if guard == trace_iter:
                trace.append(("ORPHAN", n.id))
            continue
        if guard == trace_iter:
            trace.append(("TAKE", n.id))
        remove[n.id] = None
    print(f"ITER {guard} current={current} batch={batch} remove={list(remove)[:40]}")
    if len(remove) == 0:
        if batch > 1:
            batch //= 2
            stalls += 1
            if stalls > 8:
                break
            continue
        break
    for id_ in remove:
        keep.pop(id_, None)
    dropped_nodes += len(remove)
    live = [n for n in nodes if n.id in keep]
    live_edges = [e for e in edges if e.from_ in keep and e.to in keep]
    current = _estimate_graph_tokens(live, live_edges, graph)
    nodes[:] = live
    edges[:] = live_edges
    if len(remove) >= batch:
        batch = min(len(live), batch + max(1, batch // 4))
        stalls = 0
    else:
        batch = max(1, min(batch, len(remove) * 2))
        stalls = 0

print(f"END current={current} nodes={len(nodes)} edges={len(edges)} dropped={dropped_nodes}")
print(f"TRACE iter {trace_iter}:")
for kind, id_ in trace[:80]:
    print(kind, id_)

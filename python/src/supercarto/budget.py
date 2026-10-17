"""Token budgeting — port of ``src/budget/budget.ts``.

The problem: an agent's context has a fixed price per token, and a dense city
centre produces a graph far larger than any useful prompt. The naive fix is to
truncate, which produces a confident agent reasoning over a map that lies to
it by omission.

The approach here: rank what matters, keep the subgraph that preserves
connectivity and named landmarks, and report exactly what was dropped.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable

from .geometry import opposite_compass
from .graph import GraphEdge, GraphNode, OmittedEntry, SpatialGraph

DEFAULT_OVERHEAD = 0.12

#: Landmarks guaranteed per 100 tokens of budget. A named place costs roughly
#: 12 tokens in the emitted graph, so this ratio keeps landmarks at about a
#: third of the output.
DEFAULT_LANDMARKS_PER_TOKEN = 100


def score_node(node: GraphNode, degree: int, max_degree: int) -> int:
    """Importance score. Higher survives longer.

    The weights encode what an agent needs: a named cafe matters more than an
    unnamed bend, high connectivity matters more than a dead end, and being
    near the centre matters more than at the fringe.
    """
    score = 0
    if node.name:
        score += 100
    if node.kind == "transit":
        score += 40
    if node.kind == "poi":
        score += 30
    if node.kind == "building":
        score += 20
    if node.kind == "entrance":
        score += 20
    if node.tags and len(node.tags) > 0:
        score += 10
    if node.heightM is not None:
        score += 5
    # Connectivity, normalized so a hub outranks a leaf without dominating.
    score += (degree / max_degree) * 25 if max_degree > 0 else 0
    return score


def fit_to_budget(graph: SpatialGraph, opts: dict) -> dict:
    """Fit a graph to a token budget.

    Drop order is deliberate, and each step is chosen for what an agent would
    least miss:

    1. Anonymous intersection nodes on long chains (the agent needs routes,
       not every bend) - collapsed, not deleted, so edges stay connected.
    2. Edges to already-disconnected, unnamed, non-navigational nodes.
    3. Nodes with no name, no kind significance, and low degree.
    4. As a last resort, landmarks furthest from the centre.

    Returns ``{"graph", "tokens", "droppedNodes", "droppedEdges", "applied"}``.
    """
    budget = max(64, opts.get("budget", 1024))
    overhead = math.floor(budget * opts.get("overheadFraction", DEFAULT_OVERHEAD))
    target = budget - overhead
    # The landmark floor scales with the budget. A flat floor of 8 is right
    # for a 256-token query and wrong for a 2048-token one.
    min_landmarks = opts.get(
        "minLandmarks",
        max(4, _js_round(budget / DEFAULT_LANDMARKS_PER_TOKEN)),
    )

    nodes: list[GraphNode] = list(graph.nodes)
    edges: list[GraphEdge] = list(graph.edges)
    omissions: list[OmittedEntry] = list(graph.omitted)
    # Landmarks the budgeter is allowed to keep even under heavy pressure.
    landmarks: set[str] = set(graph.pinned)

    dropped_nodes = 0
    dropped_edges = 0

    def record_omission(layer: str, count: int) -> None:
        existing = next((o for o in omissions if o.layer == layer), None)
        if existing is not None:
            existing.count += count
        else:
            omissions.append(OmittedEntry(layer=layer, count=count, near="unspecified"))

    # Index for the layer lookup, built once; node objects are reused across
    # passes so references taken now still resolve after refills.
    by_id: dict[str, GraphNode] = {n.id: n for n in nodes}

    # --- Pass 1: chain contraction -----------------------------------------
    # A node with exactly two edges and no name contributes nothing an agent
    # can reference. Contract it and join its neighbours, preserving
    # reachability.
    dropped_nodes += contract_anonymous_chains(
        nodes, edges, lambda removed: record_omission("waypoint", removed)
    )

    # --- Pass 2: iterative pruning by rank ----------------------------------
    ranked = _rank_nodes(nodes, edges)
    keep: dict[str, None] = {}
    for node in ranked:
        keep[node.id] = None

    current = _estimate_graph_tokens(nodes, edges, graph)
    guard = 0
    batch = max(1, len(nodes) // 8)
    stalls = 0

    while current > target and guard < 2000:
        guard += 1
        cuts = _articulation_points(nodes, edges, keep)
        live_named = sum(1 for n in nodes if n.id in keep and n.name is not None)

        remove: dict[str, None] = {}
        named_left = live_named
        # Count the edges that survive the current keep set, so the "keep the
        # last connection" rule below is judged against what is actually left.
        live_edge_count = sum(1 for e in edges if e.from_ in keep and e.to in keep)

        for i in range(len(ranked) - 1, -1, -1):
            n = ranked[i]
            if len(remove) >= batch:
                break
            if n.id not in keep or n.id in remove:
                continue
            if n.id in cuts:
                continue
            # Never take the last connections. A map with no edges advertises
            # places the agent cannot reach, which is worse than a smaller map
            # it can navigate, so the last edge pair is always retained.
            if live_edge_count >= 2 and live_edge_count - _incident_count(edges, n.id) < 2:
                continue
            if n.name is not None:
                if named_left <= min_landmarks:
                    continue
                named_left -= 1
            if _would_orphan_landmark(edges, n.id, landmarks, keep):
                continue
            remove[n.id] = None

        if len(remove) == 0:
            # Nothing safe at this batch size. Halve and retry, which reaches
            # protected nodes individually instead of stalling outright.
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
        # Name the omission by what was actually dropped, grouped by the
        # node's own layer; "features omitted" without names told an agent
        # nothing about what it was missing.
        for id_ in remove:
            node = by_id.get(id_)
            record_omission(node.layer if node and node.layer else "feature", 1)

        live = [n for n in nodes if n.id in keep]
        live_edges = [e for e in edges if e.from_ in keep and e.to in keep]
        dropped_edges = max(dropped_edges, len(edges) - len(live_edges))
        current = _estimate_graph_tokens(live, live_edges, graph)

        nodes[:] = live
        edges[:] = live_edges

        # Adapt the batch to how much the graph actually gives up. Growing on
        # a short batch ratchets into the stall counter; shrinking keeps
        # progress at the achievable rate.
        if len(remove) >= batch:
            batch = min(len(live), batch + max(1, batch // 4))
            stalls = 0
        else:
            batch = max(1, min(batch, len(remove) * 2))
            stalls = 0

    # Pruning can turn a dense mesh into a long thin chain of anonymous
    # intersections. Those are exactly the vertices the first pass removed, so
    # re-run contraction afterwards. Junctions that a landmark hangs off are
    # excluded, because contracting one would delete the landmark's access
    # edge along with it and leave the name stranded with no route.
    if dropped_nodes > 0:
        holders: dict[str, None] = {}
        for e in edges:
            if e.to in landmarks:
                holders[e.from_] = None
            if e.from_ in landmarks:
                holders[e.to] = None
        dropped_nodes += contract_anonymous_chains(
            nodes,
            edges,
            lambda removed: record_omission("waypoint", removed),
            holders,
        )

    final_graph = SpatialGraph(
        meta=graph.meta,
        nodes=nodes,
        edges=edges,
        obstacles=graph.obstacles,
        heat=graph.heat,
        indoor=graph.indoor,
        omitted=omissions,
        tools=graph.tools,
        pinned=list(landmarks),
        partial=graph.partial or dropped_nodes > 0 or dropped_edges > 0,
    )

    applied = dropped_nodes > 0 or dropped_edges > 0
    if opts.get("alwaysReportOmissions") is not False and not applied:
        final_graph.omitted = omissions

    return {
        "graph": final_graph,
        "tokens": current,
        "droppedNodes": dropped_nodes,
        "droppedEdges": dropped_edges,
        "applied": applied,
    }


def _rank_nodes(nodes: list[GraphNode], edges: list[GraphEdge]) -> list[GraphNode]:
    """Rank nodes for survival, worst last.

    The ordering is not purely by semantic value: a named cafe wedged onto the
    street network is worth far more than the same cafe stranded on an island
    with no edges, because the agent can only act on a landmark it can reach.
    """
    degrees = _degree_map(nodes, edges)
    in_network = _nodes_in_main_component(nodes, edges)
    # The road network is what an agent navigates by, so it must not be
    # outranked by landmarks no matter how well-connected they are.
    network_kinds = ("intersection",)
    max_degree = max(degrees.values()) if degrees else 0

    def tier(n: GraphNode) -> int:
        if n.kind in network_kinds:
            return 1
        if n.name is not None:
            return 2
        return 0

    return sorted(
        nodes,
        key=lambda n: (
            1 if n.id in in_network else 0,
            tier(n),
            -score_node(n, degrees.get(n.id, 0), max_degree),
        ),
    )


def _nodes_in_main_component(nodes: list[GraphNode], edges: list[GraphEdge]) -> set[str]:
    """Node ids in the largest connected component, weighted toward the road
    network.

    A plain largest-component search is wrong when landmarks outnumber
    streets: a cluster of shops can be the biggest component by node count
    even though it is not a navigable network. Street nodes are counted with
    extra weight so the component that wins is the one that carries the map.
    """
    adj: dict[str, set[str]] = {n.id: set() for n in nodes}
    for e in edges:
        if e.from_ == e.to:
            continue
        f = adj.get(e.from_)
        if f is not None:
            f.add(e.to)
        t = adj.get(e.to)
        if t is not None:
            t.add(e.from_)

    node_lookup = {n.id: n for n in nodes}

    def weight(id_: str) -> int:
        node = node_lookup.get(id_)
        return 10 if node is not None and node.kind == "intersection" else 1

    best: list[str] = []
    best_score = -1
    seen: set[str] = set()
    for n in nodes:
        if n.id in seen:
            continue
        component: list[str] = []
        stack = [n.id]
        seen.add(n.id)
        score = 0
        while stack:
            id_ = stack.pop()
            component.append(id_)
            score += weight(id_)
            for nb in adj.get(id_) or ():
                if nb not in seen:
                    seen.add(nb)
                    stack.append(nb)
        if score > best_score:
            best_score = score
            best = component
    return set(best)


def _degree_map(nodes: list[GraphNode], edges: list[GraphEdge]) -> dict[str, int]:
    degrees = {n.id: 0 for n in nodes}
    for e in edges:
        degrees[e.from_] = degrees.get(e.from_, 0) + 1
        degrees[e.to] = degrees.get(e.to, 0) + 1
    return degrees


def _incident_count(edges: list[GraphEdge], id_: str) -> int:
    """How many edges touch ``id``."""
    n = 0
    for e in edges:
        if e.from_ == id_ or e.to == id_:
            n += 1
    return n


def _would_orphan_landmark(
    edges: list[GraphEdge],
    id_: str,
    landmarks: Iterable[str] | set[str],
    keep: Iterable[str] | dict,
) -> bool:
    """Whether removing ``id`` would leave a surviving named landmark with no route.

    The compiler attaches each landmark to exactly one junction, so a
    landmark's degree is 2 and losing that junction strands it. This is the
    invariant that keeps the map usable: a name the agent can see but cannot
    walk to is worse than an absent one, because the agent will try.
    """
    keep_set = set(keep)
    landmarks_set = set(landmarks)

    def touching(i: str) -> list[str]:
        out = []
        for e in edges:
            if e.from_ == i:
                out.append(e.to)
            elif e.to == i:
                out.append(e.from_)
        return out

    neighbours = [o for o in touching(id_) if o in keep_set]
    return any(
        o in landmarks_set
        and len([x for x in touching(o) if x != id_ and x in keep_set]) == 0
        for o in neighbours
    )


def _articulation_points(
    nodes: list[GraphNode],
    edges: list[GraphEdge],
    keep: dict | set,  # dict used as ordered set
) -> set[str]:
    """Cut vertices of the graph, ignoring nodes outside ``keep``.

    Iterative Tarjan, because a 50,000-node extract would overflow the stack
    on the recursive form. Undirected, deduplicated adjacency: the graph
    carries mirrored directed edges, so ``n1<->n2`` is one link, not two.
    """
    live = [n for n in nodes if n.id in keep]

    # Dict-as-ordered-set adjacency: the cut rule below reads the parent's low
    # value before it is updated, which makes the result depend on the DFS
    # visit order, so the neighbour order must match the TypeScript's Set
    # insertion order exactly. (A plain Python set iterates in hash order.)
    adj: dict[str, dict[str, None]] = {n.id: {} for n in live}
    for e in edges:
        if e.from_ not in keep or e.to not in keep:
            continue
        if e.from_ == e.to:
            continue
        f = adj.get(e.from_)
        if f is not None:
            f[e.to] = None
        t = adj.get(e.to)
        if t is not None:
            t[e.from_] = None

    disc: dict[str, int] = {}
    low: dict[str, int] = {}
    parent: dict[str, str | None] = {}
    cuts: set[str] = set()
    clock = 0

    for root in live:
        if root.id in disc:
            continue
        # Explicit stack of [node, neighbour iterator], mirroring the TS port.
        stack: list[list] = [[root.id, iter(adj.get(root.id) or {})]]
        disc[root.id] = clock
        low[root.id] = clock
        clock += 1
        parent[root.id] = None

        while stack:
            frame = stack[-1]
            frame_id = frame[0]
            nxt = next(frame[1], None)
            if nxt is None:
                stack.pop()
                p = parent.get(frame_id)
                if p is not None:
                    child_low = low.get(frame_id, 0)
                    parent_low = low.get(p, 0)
                    if child_low < parent_low:
                        low[p] = child_low
                    if parent_low >= disc.get(p, 0):
                        cuts.add(p)
                continue
            v = nxt
            if v == parent.get(frame_id):
                continue
            if v in disc:
                dv = disc[v]
                if dv < low.get(frame_id, dv):
                    low[frame_id] = dv
                continue
            parent[v] = frame_id
            disc[v] = clock
            low[v] = clock
            clock += 1
            stack.append([v, iter(adj.get(v) or {})])

    return cuts


def contract_anonymous_chains(
    nodes: list[GraphNode],
    edges: list[GraphEdge],
    on_remove: Callable[[int], None] | None = None,
    protected_ids: Iterable[str] | None = None,
) -> int:
    """Remove degree-2 unnamed nodes by joining their neighbours.

    Returns the number of nodes contracted.
    """
    removed = 0
    protected = frozenset(protected_ids) if protected_ids is not None else frozenset()
    while True:
        # Judge by *distinct neighbours*, not edge count. Every line
        # contributes two opposite directed edges, so an interior chain node
        # has four incident edges but only two neighbours.
        neighbour_count = _distinct_neighbour_map(nodes, edges)
        victim = next(
            (
                n
                for n in nodes
                if not n.name
                and n.kind == "intersection"
                and n.id not in protected
                and neighbour_count.get(n.id, 0) == 2
            ),
            None,
        )
        if victim is None:
            break

        # The collapsible shape is exactly two distinct neighbours, each
        # reachable both ways. Three or more neighbours is a real junction and
        # must be kept.
        inbound = [e for e in edges if e.to == victim.id]
        outbound = [e for e in edges if e.from_ == victim.id]
        if len(inbound) != 2 or len(outbound) != 2:
            break

        # A neighbour is "before" the victim when an edge runs neighbour ->
        # victim, and "after" when an edge runs victim -> neighbour. Both sets
        # must contain the same two nodes; otherwise the passage is one-way or
        # asymmetric, and collapsing it would invent or destroy a restriction.
        before = _dedupe([e.from_ for e in inbound])
        after = _dedupe([e.to for e in outbound])
        if len(before) != 2 or len(after) != 2:
            break

        before_id = before[0]
        after_id = after[1]
        if before_id == after_id:
            break

        # The through passage is before -> victim -> after. Pairing the
        # inbound leg with the outbound leg to the *same* neighbour would be
        # a backtrack, so the legs join across the victim, not back into it.
        in_leg = next(e for e in inbound if e.from_ == before_id)
        out_leg = next(e for e in outbound if e.to == after_id)

        # Sum the axis deltas so the emitter's per-axis scaling stays correct
        # across a contraction; a straight-line distance would not survive it.
        dx = in_leg.dx + out_leg.dx
        dy = in_leg.dy + out_leg.dy
        dist = math.hypot(dx, dy)
        features = _dedupe(list(in_leg.features) + list(out_leg.features))

        # The through passage, forward: before -> after.
        forward = GraphEdge(
            from_=before_id,
            to=after_id,
            dist=dist,
            dx=dx,
            dy=dy,
            dir=out_leg.dir,
            features=features,
        )
        # The mirror: after -> before, with the axis deltas negated so the
        # reverse traversal is geometrically correct rather than merely
        # relabelled.
        reverse = GraphEdge(
            from_=after_id,
            to=before_id,
            dist=dist,
            dx=-dx,
            dy=-dy,
            dir=opposite_compass(out_leg.dir),
            features=features,
        )
        p = in_leg.path if in_leg.path else out_leg.path
        if p:
            forward.path = p
            reverse.path = p
        if in_leg.crosswalk:
            forward.crosswalk = True
            reverse.crosswalk = True
        if in_leg.blocked:
            forward.blocked = True
            reverse.blocked = True

        # Drop all four incident edges and insert the join in both directions.
        edges[:] = [e for e in edges if e.from_ != victim.id and e.to != victim.id]
        edges.append(forward)
        edges.append(reverse)

        nodes.remove(victim)
        removed += 1
    if removed > 0 and on_remove is not None:
        on_remove(removed)
    return removed


def _dedupe(items: list) -> list:
    """Insertion-ordered dedupe, matching JS ``[...new Set(items)]``."""
    seen: dict = {}
    for it in items:
        seen.setdefault(it)
    return list(seen)


def _distinct_neighbour_map(nodes: list[GraphNode], edges: list[GraphEdge]) -> dict[str, int]:
    """Map each node id to the number of distinct nodes it connects to."""
    sets: dict[str, set] = {n.id: set() for n in nodes}
    for e in edges:
        f = sets.get(e.from_)
        if f is not None:
            f.add(e.to)
        t = sets.get(e.to)
        if t is not None:
            t.add(e.from_)
    return {id_: len(s) for id_, s in sets.items()}


def _estimate_graph_tokens(
    nodes: list[GraphNode],
    edges: list[GraphEdge],
    graph: SpatialGraph,
) -> int:
    """Cheap token estimate for a graph, without building the YAML string.

    Empirically a node line averages ~28 chars and an edge line ~46 in flow
    style. Using a constant is far cheaper than serializing on every
    iteration.
    """
    node_chars = len(nodes) * 28
    edge_chars = len(edges) * 46
    overhead_chars = (
        120
        + len(graph.obstacles) * 40
        + len(graph.omitted) * 40
        + len(graph.heat) * 60
    )
    return math.ceil((node_chars + edge_chars + overhead_chars) / 4)


def _js_round(x: float) -> float:
    from .types import js_round

    return js_round(x)


estimate_graph_tokens = _estimate_graph_tokens

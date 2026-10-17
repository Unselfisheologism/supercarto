"""The one-call path — port of ``src/pipeline.ts``.

GeoJSON in, token-budgeted YAML out. Every stage is also exported
individually, but this is what a server should call, because the stages have
a required order and one meaningful set of defaults.

Milestone-1 note: the SCR wire codec is not ported yet, so the ``scr`` field
and the wire metrics (``wireBytes``/``wireTokens``) are None. The YAML and its
token count are fully emitted and budget-verified.
"""

from __future__ import annotations

from typing import Any

from .budget import fit_to_budget
from .compiler import compile
from .emit import emit_graph
from .graph import GraphNode, OmittedEntry, SpatialGraph
from .ingest import from_geojson
from .scale import grid_scale_for
from .types import Omission, ScrDocument


def to_maplet(
    input_: list[dict] | dict | str,
    req: dict[str, Any] | None = None,
    **opts: Any,
) -> dict[str, Any]:
    """The one-call path: GeoJSON in, token-budgeted YAML out.

    ``opts`` top-level kwargs merge over ``req`` keys, so
    ``to_maplet(data, budget=512)`` and
    ``to_maplet(data, {"budget": 512})`` are the same call.
    """
    req = {**(req or {}), **opts}
    envelope = req.get("envelope")
    if envelope is None and req.get("bbox") is not None:
        bbox = req["bbox"]
        envelope = {
            "type": "bbox",
            "west": bbox["west"],
            "south": bbox["south"],
            "east": bbox["east"],
            "north": bbox["north"],
        }

    ingest_opts = {**(req.get("ingest") or {})}
    if envelope is not None:
        ingest_opts.setdefault("envelope", envelope)

    # Callers that already hold a document — chiefly the live path, which
    # attaches derived heat layers to the fetched document — pass it through
    # instead of re-ingesting. Heat lives on the document, not on any feature,
    # so a round trip through features would discard every derived layer.
    doc = req.get("doc")
    if doc is None:
        doc = from_geojson(input_, ingest_opts)

    layers = req.get("layers")
    if layers:
        doc = filter_layers(doc, set(layers))

    compile_opts = {**(req.get("compile") or {})}
    if req.get("radiusLabel"):
        # TS spreads the label *after* req.compile, so it wins.
        compile_opts["radiusLabel"] = req["radiusLabel"]
    compile_opts.setdefault(
        "capabilities",
        req.get("capabilities")
        or {
            "elevation": req.get("hasElevation", False),
            "weather": False,
            "traffic": False,
        },
    )
    graph = compile(doc, compile_opts)

    budget_val = req.get("budget") if req.get("budget") is not None else 1024
    budget_opts = {**(req.get("budgetOpts") or {}), "budget": budget_val}
    fitted = fit_to_budget(graph, budget_opts)

    # Distances become metres only once the document's real-world scale is
    # known. This is what turns `dist: 47u` into `dist: 47m`.
    scale = grid_scale_for(doc)
    # Orphan names survive only on explicit POI-only requests. Everywhere else
    # the safety net stands: a name without a street misleads. Bench fixtures
    # compile without layers, so their behavior is unchanged.
    layer_list = layers or []
    poi_only = bool(layer_list) and not any(
        l in ("road", "highway") for l in layer_list
    )
    emitted = _emit_and_verify(
        fitted,
        {**(req.get("emit") or {}), "keepOrphans": poi_only},
        scale,
        budget_val,
    )

    return {
        "doc": doc,
        "graph": emitted["graph"],
        "yaml": emitted["result"]["yaml"],
        "metrics": {
            "budget": budget_val,
            "tokens": emitted["result"]["tokens"],
            "wireBytes": None,  # SCR codec not ported yet (milestone 2)
            "wireTokens": None,
            "yamlTokens": emitted["result"]["tokens"],
            "nodes": len(emitted["graph"].nodes),
            "edges": len(emitted["graph"].edges),
            "droppedNodes": emitted["dropped"],
            "droppedEdges": 0,
        },
    }


def _emit_and_verify(
    fitted: dict,
    emit_opts: dict | None,
    scale: dict | None,
    budget: int,
) -> dict:
    """Emit, then verify against the real serializer and shrink if needed.

    ``fitToBudget`` works from a cheap linear estimate so it can iterate
    fast, but an estimate is not a guarantee: a graph full of long street
    names can overshoot. This closes the loop by measuring the actual output
    and, if it is over budget, dropping the weakest landmarks until it fits.
    Without this the caller gets a promise the library does not keep.
    """

    def render(g: SpatialGraph) -> dict:
        merged = {**(emit_opts or {})}
        merged["scale"] = (emit_opts or {}).get("scale") or scale
        return emit_graph(g, merged)

    graph = fitted["graph"]
    result = render(graph)
    dropped = fitted["droppedNodes"]

    # Shrink until the real output fits. Removals are batched (re-serializing
    # after every single node is O(V^2)), and the omission list is aggregated.
    batch = max(1, min(8, len(graph.nodes) // 40))
    stalls = 0

    for _guard in range(3000):
        if result["tokens"] <= budget:
            break
        # Keep a minimal but *navigable* skeleton. A map with no nodes
        # answers no question; a map with no edges advertises places the
        # agent cannot reach and it will try.
        if len(graph.nodes) <= 2:
            break
        if len(graph.edges) == 2:
            break  # one pair left: the floor

        holding = _junctions_holding_landmarks(graph)
        cap = (
            batch
            if len(graph.edges) < 2
            else max(1, min(batch, len(graph.nodes) - 3, len(graph.edges) - 2))
        )
        named = {n.id for n in graph.nodes if n.name is not None}
        victims = [
            id_
            for id_ in _pick_batch(graph, holding, cap)
            if len(graph.edges) >= 2 or id_ not in named
        ]
        if not victims:
            # Nothing safe left at this batch size. Shrink the batch and
            # retry, which reaches the protected nodes one at a time instead
            # of stalling.
            if batch > 1:
                batch //= 2
                stalls += 1
                if stalls > 6:
                    break
                continue
            break

        remove = set(victims)
        graph = SpatialGraph(
            meta=graph.meta,
            nodes=[n for n in graph.nodes if n.id not in remove],
            edges=[e for e in graph.edges if e.from_ not in remove and e.to not in remove],
            obstacles=graph.obstacles,
            heat=graph.heat,
            indoor=graph.indoor,
            omitted=_bump_omission(graph.omitted, "landmark", len(victims)),
            tools=graph.tools,
            pinned=graph.pinned,
            partial=True,
        )
        dropped += len(victims)
        result = render(graph)

        # Adapt the batch: grow while a full batch is removable, shrink when
        # the graph stops yielding nodes.
        if len(victims) >= batch:
            batch = min(len(graph.nodes), batch + max(1, batch // 4))
            stalls = 0
        else:
            stalls += 1
            if stalls > 6:
                break

    # Safety net: a named node with no edges is a name the agent can see but
    # cannot route to. It is worse than an absent one, because the agent will
    # confidently try to walk to it. Remove any that survived, and record the
    # loss so the map still reports itself as partial. Skipped for explicitly
    # POI-only requests (keepOrphans): edgelessness there is the answer, not
    # a defect, and stripping it would return an empty map for a question the
    # data does answer.
    if not (emit_opts or {}).get("keepOrphans"):
        touched = set()
        for e in graph.edges:
            touched.add(e.from_)
            touched.add(e.to)
        orphans = [n for n in graph.nodes if n.name is not None and n.id not in touched]
        if orphans:
            remove = {o.id for o in orphans}
            graph = SpatialGraph(
                meta=graph.meta,
                nodes=[n for n in graph.nodes if n.id not in remove],
                edges=[e for e in graph.edges if e.from_ not in remove and e.to not in remove],
                obstacles=graph.obstacles,
                heat=graph.heat,
                indoor=graph.indoor,
                omitted=_bump_omission(graph.omitted, "landmark", len(orphans)),
                tools=graph.tools,
                pinned=graph.pinned,
                partial=True,
            )
            dropped += len(orphans)
            result = render(graph)
    return {"graph": graph, "result": result, "dropped": dropped}


def _pick_batch(graph: SpatialGraph, skip: set, limit: int) -> list[str]:
    """Up to ``limit`` node ids to drop, worst-first, never orphaning a named
    landmark and never taking the last connections.

    Each node takes its incident edges with it, so the surviving edge count
    is tracked while the batch is built rather than checked afterwards.
    Sizing the batch by node count alone is what previously let one batch
    delete the whole network, leaving a map of names with no routes.
    """
    scored = [
        # Higher is more important; sort ascending so the batch takes the worst.
        (id_, (1000 if n.name is not None else 0) + _landmark_score(n))
        for id_, n in ((n.id, n) for n in graph.nodes)
    ]
    scored.sort(key=lambda t: t[1])

    incident: dict[str, int] = {}
    for e in graph.edges:
        incident[e.from_] = incident.get(e.from_, 0) + 1
        incident[e.to] = incident.get(e.to, 0) + 1

    out: list[str] = []
    edges_left = len(graph.edges)
    for id_, _score in scored:
        if len(out) >= limit:
            break
        if id_ in skip:
            continue
        # Keep at least two edges so the map stays navigable.
        cost = incident.get(id_, 0)
        if edges_left >= 2 and edges_left - cost < 2:
            continue
        out.append(id_)
        edges_left -= cost
    return out


def _landmark_score(n: GraphNode) -> int:
    """Value of keeping a landmark. Higher survives longer."""
    score = 0
    if n.heightM is not None:
        score += 2
    score += len(n.tags or []) * 3
    if n.kind == "transit":
        score += 10
    elif n.kind == "poi":
        score += 5
    elif n.kind == "building":
        score += 3
    return score


def _bump_omission(omitted: list[OmittedEntry], layer: str, count: int = 1) -> list[OmittedEntry]:
    """Increment an aggregated omission count, keeping one entry per layer."""
    existing = next((o for o in omitted if o.layer == layer), None)
    if existing is not None:
        return [
            OmittedEntry(layer=o.layer, count=o.count + count, near=o.near, note=o.note)
            if o is existing
            else o
            for o in omitted
        ]
    return list(omitted) + [OmittedEntry(layer=layer, count=count, near="unspecified")]


def _junctions_holding_landmarks(graph: SpatialGraph) -> set:
    """Junctions that are the only remaining access to a named landmark.

    A landmark is reachable only through its neighbours, so any junction on
    the path from a landmark to the rest of the network is load-bearing. The
    cheap approximation is to protect every direct neighbour of a landmark:
    cheap enough to run per iteration, and correct for the access edges the
    compiler creates, which attach each landmark to exactly one junction.
    """
    degree: dict[str, int] = {}
    for n in graph.nodes:
        degree[n.id] = 0
    for e in graph.edges:
        degree[e.from_] = degree.get(e.from_, 0) + 1
        degree[e.to] = degree.get(e.to, 0) + 1
    named = {n.id for n in graph.nodes if n.name is not None}

    # A junction is load-bearing when a named landmark depends on it for all
    # but a trivial share of its connections. As the graph thins, a landmark
    # whose degree has fallen to 2 can still lose its last real route when
    # its second neighbour is cut, so degree-1 protection is not enough.
    holding: set[str] = set()
    for e in graph.edges:
        if e.to in named and degree.get(e.to, 0) <= 2:
            holding.add(e.from_)
        if e.from_ in named and degree.get(e.from_, 0) <= 2:
            holding.add(e.to)
    return holding


def filter_layers(doc: ScrDocument, keep: set) -> ScrDocument:
    """Keep only the named layers, recording the rest as omissions."""
    layer_ids = {id_ for id_, layer in doc.layers.items() if layer.name in keep}

    # Count what is about to be dropped, per layer. This must happen before
    # the layer table is narrowed, otherwise the omission records lose the
    # layer names and the agent is told a count for "layer2" instead of
    # "building".
    dropped: dict[int, int] = {}
    for f in doc.features:
        if f.layerId not in layer_ids:
            dropped[f.layerId] = dropped.get(f.layerId, 0) + 1

    next_ = ScrDocument(
        version=doc.version,
        envelope=doc.envelope,
        projection=doc.projection,
        extent=doc.extent,
        buffer=doc.buffer,
        meta=doc.meta,
        # The layer table is kept whole so the dropped layers still resolve
        # to a human-readable name in the omission records at compile time.
        layers=doc.layers,
        classes={id_: c for id_, c in doc.classes.items() if c.layerId in layer_ids},
        strings=doc.strings,
        attrSets=doc.attrSets,
        features=[f for f in doc.features if f.layerId in layer_ids],
        heat=doc.heat,
        omissions=list(doc.omissions),
        refs=doc.refs,
        routes=doc.routes,
    )

    for layer_id, count in dropped.items():
        next_.omissions.append(Omission(layerId=layer_id, count=count))
    if dropped:
        total = sum(dropped.values())
        next_.meta["omitted_total"] = str(total)
    return next_


def compile_file(path: str, req: dict[str, Any] | None = None, **opts: Any) -> dict[str, Any]:
    """Compile a GeoJSON file straight to a budgeted maplet.

    The offline shape of ``supercarto compile <file> --budget N`` once the
    wire codec is ported. Top-level convenience kwargs are merged into the
    request, so ``compile_file(f, budget=512)`` equals
    ``compile_file(f, {"budget": 512})``.
    """
    import json

    merged = {**(req or {}), **opts}
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return to_maplet(data, merged)

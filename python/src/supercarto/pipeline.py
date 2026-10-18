"""The one-call path — port of ``src/pipeline.ts``.

GeoJSON in, token-budgeted YAML out. Every stage is also exported
individually, but this is what a server should call, because the stages have
a required order and one meaningful set of defaults.

``to_maplet`` also carries the SCR wire document: ``scr`` is the ungrouped
wire text of the post-filter document (byte-parity port of ``encodeDocument``),
and ``fromScr`` compiles an already-encoded document without re-ingesting.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from .budget import (
    _articulation_points,
    apply_removals_validated,
    contract_anonymous_chains,
    fit_to_budget,
)
from .compiler import compile
from .emit import emit_graph
from .graph import GraphNode, OmittedEntry, SpatialGraph
from .ingest import from_geojson
from .scale import grid_scale_for
from .types import Omission, ScrDocument
from .wire import decode_document, encode_document


def utf8_len(s: str) -> int:
    # Buffer.byteLength(scr, 'utf8') on the TS side.
    return len(s.encode("utf-8"))


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

    # SCR text of the (post-filter) document, for machine-side caching and the
    # wire metrics. Emitted ungrouped: group blank lines are a debugging aid,
    # and a wire format that stdio pipes carry should not spend bytes on them.
    scr = encode_document(doc, {"group": False})
    wire_bytes = utf8_len(scr)

    return {
        "doc": doc,
        "scr": scr,
        "graph": emitted["graph"],
        "yaml": emitted["result"]["yaml"],
        "metrics": {
            "budget": budget_val,
            "tokens": emitted["result"]["tokens"],
            "wireBytes": wire_bytes,
            "wireTokens": -(-wire_bytes // 4),  # Math.ceil
            "yamlTokens": emitted["result"]["tokens"],
            "nodes": len(emitted["graph"].nodes),
            "edges": len(emitted["graph"].edges),
            "droppedNodes": emitted["dropped"],
            "droppedEdges": 0,
        },
    }


def from_scr(
    scr: str,
    opts: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Compile an already-encoded SCR document, without re-ingesting.

    Port of TS ``fromScr``.
    """
    opts = opts or {}
    doc = decode_document(scr)
    graph = compile(doc, opts.get("compile"))
    budget_val = opts.get("budget") if opts.get("budget") is not None else 1024
    fitted = fit_to_budget(graph, {**(opts.get("budgetOpts") or {}), "budget": budget_val})
    emitted = _emit_and_verify(
        fitted,
        opts.get("emit"),
        grid_scale_for(doc),
        budget_val,
    )
    wire_bytes = utf8_len(scr)
    return {
        "doc": doc,
        "scr": scr,
        "graph": emitted["graph"],
        "yaml": emitted["result"]["yaml"],
        "metrics": {
            "budget": budget_val,
            "tokens": emitted["result"]["tokens"],
            "wireBytes": wire_bytes,
            "wireTokens": -(-wire_bytes // 4),
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
    # Pressure valve, mirroring fit_to_budget: cut vertices join the candidate
    # pool only after connected pruning is exhausted, so the graph fragments
    # only when staying whole cannot reach the budget.
    allow_cuts = False

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
            for id_ in _pick_batch(graph, holding, cap, allow_cuts)
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
                if batch == 1 and not allow_cuts:
                    # True exhaustion: empty even one at a time, so connected
                    # pruning cannot reach the budget. Open the pressure valve
                    # rather than spend names - mirroring fit_to_budget.
                    allow_cuts = True
                    stalls = 0
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
        # Safe leaf pruning exposes anonymous chains. Collapse those paths
        # rather than spending the remaining budget on their intermediate
        # junctions.
        def on_contract(removed_count: int) -> None:
            nonlocal graph, dropped
            dropped += removed_count
            graph = _with_omitted(
                graph, "waypoint", removed_count, True
            )
        contract_anonymous_chains(
            graph.nodes,
            graph.edges,
            on_contract,
            _junctions_holding_landmarks(graph),
        )
        result = render(graph)

        # Adapt the batch: grow while a full batch is removable, shrink when
        # the graph stops yielding nodes. Growing on a short batch ratchets
        # into the stall counter; capping at what the last batch actually
        # yielded keeps progress at the achievable rate.
        if len(victims) >= batch:
            batch = min(len(graph.nodes), batch + max(1, batch // 4))
            stalls = 0
        else:
            batch = max(1, len(victims))
            stalls = 0

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


def _with_omitted(graph: SpatialGraph, layer: str, count: int, partial: bool) -> SpatialGraph:
    """Clone the graph with one aggregated omission incremented."""
    return replace(
        graph,
        omitted=_bump_omission(graph.omitted, layer, count),
        partial=partial or graph.partial,
    )


def _pick_batch(graph: SpatialGraph, skip: set, limit: int, allow_cuts: bool = False) -> list[str]:
    """Up to ``limit`` node ids to drop, worst-first, never orphaning a named
    landmark and never taking the last connections.

    Harm tiers, lowest first: anonymous junctions before names, connected
    candidates before cut vertices. The sort makes the escalation explicit -
    fragmentation is cheaper than name death, name death is cheaper than
    stranding, and the validator owns stranding outright. The batch is
    validated as one unit rather than per candidate: recomputing cuts after
    every candidate is O(V+E) each and measured in tens of seconds on a dense
    extract.
    """
    incident: dict[str, int] = {}
    for e in graph.edges:
        incident[e.from_] = incident.get(e.from_, 0) + 1
        incident[e.to] = incident.get(e.to, 0) + 1

    keep: dict[str, None] = {n.id: None for n in graph.nodes}
    cuts = _articulation_points(graph.nodes, graph.edges, keep)
    edges_left = len(graph.edges)
    # Harm tiers, lowest first: anonymous junctions before names, connected
    # candidates before cut vertices. The sort makes the escalation explicit -
    # fragmentation is cheaper than name death, name death is cheaper than
    # stranding, and the validator owns stranding outright.
    scored = [
        # Higher is more important; sort ascending so the batch takes the worst.
        (
            n.id,
            (2 if n.name is not None else 0) + (1 if n.id in cuts else 0),
            (1000 if n.name is not None else 0) + _landmark_score(n),
        )
        for n in graph.nodes
    ]
    scored.sort(key=lambda t: (t[1], t[2]))

    candidates: list[str] = []
    for id_, tier, _score in scored:
        if len(candidates) >= limit:
            break
        # Sorted by tier, so with fragmentation withheld the first cut vertex
        # ends the connected supply.
        if not allow_cuts and tier >= 1:
            break
        if id_ in skip:
            continue
        # Keep at least two edges so the map stays navigable. Vacant on
        # edgeless graphs: with nothing to keep connected, unnamed nodes thin
        # freely and named ones are filtered by the caller, never here.
        cost = incident.get(id_, 0)
        if edges_left >= 2 and edges_left - cost < 2:
            continue
        candidates.append(id_)
        keep.pop(id_, None)
        edges_left -= cost

    # Validate the batch on scratch copies of the graph. Every named node is a
    # landmark here, and the name floor does not apply - this stage is the
    # last resort, so a landmark whose whole access dies with the batch may go
    # with it rather than strand. No batch among the candidates may strand a
    # name either way.
    named_ids = {n.id for n in graph.nodes if n.name is not None}
    scratch_nodes = list(graph.nodes)
    scratch_edges = list(graph.edges)
    scratch_keep: dict[str, None] = {n.id: None for n in graph.nodes}
    applied = apply_removals_validated(
        candidates, scratch_nodes, scratch_edges, scratch_keep, named_ids, named_ids, not allow_cuts
    )
    return [id_ for id_ in candidates if id_ in applied]


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

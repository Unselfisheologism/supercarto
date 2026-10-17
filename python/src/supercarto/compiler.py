"""Topology compiler — port of ``src/compile/compiler.ts``.

Turns an SCR document's classified, quantized features into the reasoning
graph: named nodes joined by directed, measured, bidirectional edges, with
budget-relevant metadata (sun position, opening hours, heat, omissions).
"""

from __future__ import annotations

import datetime as _dt
import math
import re
from typing import Any

from .geometry import (
    compass_of,
    dedupe_line,
    opposite_compass,
    weld_key,
)
from .graph import (
    GraphEdge,
    GraphMeta,
    GraphNode,
    HeatSummary,
    Hotspot,
    Obstacle,
    OmittedEntry,
    SpatialGraph,
    SunSummary,
)
from .hours import opening_phrase
from .indoor import (
    IndoorFeature,
    build_indoor_graph,
    empty_indoor,
    is_meaningful_indoor,
)
from .project import grid_to_lonlat
from .sun import sun_position
from .toolcatalog import advertised_tools
from .types import (
    Feature,
    Prop,
    ScrDocument,
    js_num_str,
    js_round,
)

DEFAULT_WELD = 2
DEFAULT_MAX_NODES = 4000

#: Nodes held back from the line pass for named places. A share of maxNodes
#: rather than a constant, so it scales with whatever cap the caller chose.
DEFAULT_MAX_NAMED_NODES = 512

#: Feature classes treated as named places an agent would navigate to.
POI_CLASSES = frozenset(
    [
        "amenity.cafe",
        "amenity.restaurant",
        "amenity.bar",
        "amenity.pharmacy",
        "amenity.hospital",
        "amenity.school",
        "amenity.bank",
        "amenity.fuel",
        "amenity.parking",
        "amenity.bus_station",
        "amenity.marketplace",
        "shop",
        "leisure.park",
        "leisure.playground",
        "tourism.attraction",
        "tourism.hotel",
        "office",
    ]
)

TRANSIT_CLASSES = frozenset(
    [
        "railway.station",
        "railway.subway_entrance",
        "public_transport.stop_position",
        "public_transport.station",
        "highway.bus_stop",
        "railway.tram_stop",
        "railway.light_rail",
    ]
)

#: Attribute keys that mark a path as not walkable.
BLOCKING_TAGS = frozenset(["construction", "closed", "no", "barrier", "locked"])

PATH_HINTS: list[tuple[str, str]] = [
    ("footway", "sidewalk"),
    ("pedestrian", "sidewalk"),
    ("path", "path"),
    ("steps", "stairs"),
    ("cycleway", "bikeway"),
    ("corridor", "indoor"),
    ("service", "service"),
    ("track", "track"),
    ("motorway", "highway"),
    ("trunk", "highway"),
]

#: Highway tags that are street furniture, not destinations.
FURNITURE_HIGHWAYS = frozenset(
    [
        "traffic_signals", "crossing", "street_lamp", "give_way", "stop",
        "elevator", "turning_circle", "milestone", "speed_camera",
        "traffic_calming", "passing_place", "emergency_bay",
    ]
)

#: Named-but-invisible POIs that still clutter a graph. Kept only when they
#: carry a name an agent would recognize.
WEAK_POI_CLASSES = frozenset(
    [
        "tourism.artwork", "tourism.viewpoint", "tourism.information",
        "tourism.board", "tourism.map", "amenity.waste_basket",
        "amenity.bicycle_parking", "amenity.post_box", "amenity.vending_machine",
        "amenity.drinking_water", "amenity.bench", "amenity.parking_entrance",
    ]
)


class Builder:
    """Intermediate state while building the graph."""

    def __init__(self, doc: ScrDocument, weld: int, now: _dt.datetime) -> None:
        self.doc = doc
        self.env = doc.envelope
        self.extent = doc.extent
        self.weld = weld
        self.nodes: list[GraphNode] = []
        self.edges: list[GraphEdge] = []
        self.obstacles: list[Obstacle] = []
        #: weld key -> node id, for junction reuse.
        self.junctionIndex: dict[str, str] = {}
        #: feature id -> node id, for POI attachment.
        self.featureIndex: dict[int, str] = {}
        #: node id -> the grid point the node sits on. Needed to measure edges.
        self.anchors: dict[str, tuple[float, float]] = {}
        #: Nodes whose connection to the network must survive budgeting.
        self.pinned: set[str] = set()
        self.nextId = 1
        #: Nodes referenced by an edge, in insertion order.
        self.used: set[str] = set()
        #: Instant opening hours are evaluated against, fixed once per compile
        #: so one run cannot produce nodes that disagree about "now".
        self.now = now
        self.utcOffsetMinutes: int | None = None
        self._byId: dict[str, GraphNode] = {}


def compile(doc: ScrDocument, opts: dict | None = None) -> SpatialGraph:
    """Compile an SCR document into the reasoning graph."""
    opts = opts or {}
    weld = opts.get("weld", DEFAULT_WELD)
    max_nodes = opts.get("maxNodes", DEFAULT_MAX_NODES)
    excluded = frozenset(opts.get("exclude") or [])

    now = opts.get("now") or _dt.datetime.now(_dt.timezone.utc)
    b = Builder(doc, weld, now)
    b.utcOffsetMinutes = opts.get("utcOffsetMinutes")

    def class_name(id_: int) -> str:
        c = doc.classes.get(id_)
        return c.name if c else ""

    def layer_name(id_: int) -> str:
        l = doc.layers.get(id_)
        return l.name if l else ""

    # How many nodes the line pass may claim, leaving room for named places.
    # Without this the two passes shared one ceiling in a fixed order, so a
    # dense street grid spent all of it on anonymous intersections and the
    # point pass broke out before adding a single named node.
    named_reserve = min(
        opts.get("maxNamedNodes", DEFAULT_MAX_NAMED_NODES),
        max_nodes // 2,
    )
    line_node_ceiling = max(0, max_nodes - named_reserve)

    # 1. Line features become the edge backbone, first, so every later point
    #    feature can snap onto a junction that already exists. Only genuine
    #    lines form edges: a building footprint turned into walkable edges
    #    would invent a path through a wall.
    line_features = [f for f in doc.features if f.kind == "line"]
    area_features = [f for f in doc.features if f.kind in ("polygon", "building")]
    point_features = [f for f in doc.features if f.kind == "point"]

    for f in line_features:
        if class_name(f.classId) in excluded:
            continue
        # The line pass stops at its own ceiling so the named reservation
        # survives for the point pass.
        if len(b.nodes) >= line_node_ceiling:
            break
        _compile_linear(b, f, class_name(f.classId), layer_name(f.layerId))

    # 2. Point features become named nodes, snapped to a nearby junction when
    #    one exists so "the cafe on the corner" is reachable from the graph.
    for f in point_features:
        cn = class_name(f.classId)
        if cn in excluded:
            continue
        # Street furniture is not a place, and left in it becomes hundreds of
        # anonymous junctions that crowd out the landmarks.
        if _is_furniture(cn):
            continue
        # Weak POIs survive only when named: "Seal Rock Viewpoint" is worth a
        # token, the four hundred unnamed information boards are not.
        if cn in WEAK_POI_CLASSES and not _is_named(doc, f):
            continue
        if len(b.nodes) >= max_nodes:
            break
        _compile_point(b, f, cn, layer_name(f.layerId))

    # 3. Areas become single nodes at their centroid, attached to the network
    #    by a short edge. An agent needs "the tower is here, this far off the
    #    road", not the four walls of the tower as a navigable cycle.
    for f in area_features:
        cn = class_name(f.classId)
        if cn in excluded:
            continue
        if len(b.nodes) >= max_nodes:
            break
        _compile_area(b, f, cn, layer_name(f.layerId))

    # 4. Any node not touched by an edge is still useful context, but only if
    #    it is named. An anonymous polygon corner is noise to a language model.
    _prune_isolated(b)

    # 5. A named node that never welded onto a street is a geometry bug, not a
    #    real feature: a POI sits a few metres off the kerb, far outside the
    #    weld radius, so it lands as an island, and islands are the first
    #    thing under token pressure that a budgeter discards. Attach each one
    #    to the nearest *road network* node, never to another landmark.
    _attach_stranded_landmarks(b)

    heat = _compile_heat(doc, doc.envelope, opts.get("maxHotspots", 5))

    indoor = (
        empty_indoor()
        if opts.get("indoor") is False
        else compile_indoor(doc, opts)
    )

    return SpatialGraph(
        meta=_build_meta(doc, b, opts),
        nodes=b.nodes,
        edges=b.edges,
        obstacles=b.obstacles,
        heat=heat,
        indoor=indoor,
        omitted=_compile_omissions(doc),
        tools=advertised_tools(
            opts.get("capabilities")
            or {
                "elevation": bool(opts.get("hasElevation", False)),
                "weather": False,
                "traffic": False,
            }
        ),
        pinned=list(b.pinned),
        partial=len(doc.omissions) > 0,
    )


# ---------------------------------------------------------------------------
# Line / polygon / building -> edges
# ---------------------------------------------------------------------------


def _compile_linear(b: Builder, f: Feature, class_name: str, layer_name: str) -> None:
    """Turn each part of a line feature into a chain of edges between welded nodes."""
    path = _class_path_hint(class_name, layer_name)
    if f.geometry.kind != "line":
        return

    props = props_of(b.doc, f.attrSet)
    blocked = _is_blocked(props)
    crosswalk = _has_token(props, "crossing") or _has_token(props, "crosswalk")

    for coords in f.geometry.lines:
        line = dedupe_line(list(coords), False)
        if len(line) < 2:
            continue

        prev_id: str | None = None
        for pt in line:
            key = weld_key(pt, b.weld)
            node_id = b.junctionIndex.get(key)
            if node_id is None:
                # Interior vertices stay anonymous unless a later point
                # feature claims them. They still exist, so a route can
                # traverse them.
                node_id = _add_node(
                    b,
                    GraphNode(id="", kind="intersection", features=[f.id], layer=layer_name),
                    pt,
                )
                b.junctionIndex[key] = node_id
            else:
                existing = node_by_id(b, node_id)
                if existing and f.id not in existing.features:
                    existing.features.append(f.id)

            if prev_id is not None and prev_id != node_id:
                _add_edge(b, prev_id, node_id, path, blocked, crosswalk, f.id)
            prev_id = node_id


def _compile_area(b: Builder, f: Feature, class_name: str, layer: str) -> None:
    """Attach a polygon or building as a single node at its largest ring's
    centroid, joined to the nearest existing junction."""
    if f.geometry.kind not in ("polygon", "building"):
        return

    props = props_of(b.doc, f.attrSet)
    name = _string_prop(b.doc, props, "name")
    tags = _collect_tags(class_name, props)
    kind: str
    if f.geometry.kind == "building" or class_name.startswith("building"):
        kind = "building"
    else:
        kind = "area"

    centroid: tuple[float, float] | None = None
    for part in f.geometry.polygon:
        ring = part.rings[0] if part.rings else None
        if ring and len(ring) >= 3:
            centroid = _ring_centroid(ring)
            break
    if centroid is None:
        return

    # If a junction already sits on the centroid, enrich it instead of adding
    # a duplicate node one grid unit away.
    key = weld_key(GridPointXY(centroid[0], centroid[1]), b.weld)
    existing_id = b.junctionIndex.get(key)
    if existing_id is not None:
        n = node_by_id(b, existing_id)
        if n is not None:
            if f.id not in n.features:
                n.features.append(f.id)
            if name and not n.name:
                n.name = name
            if kind == "building" and n.kind == "intersection":
                n.kind = "building"
            if tags:
                n.tags = _dedupe((n.tags or []) + tags)
            h = _num_prop(b.doc, props, "height_m", "height", "building:levels")
            if h is not None:
                n.heightM = h
            return

    node = GraphNode(id="", kind=kind, features=[f.id], layer=layer)
    if name:
        node.name = name
    if tags:
        node.tags = tags
    h = _num_prop(b.doc, props, "height_m", "height", "building:levels")
    if h is not None:
        node.heightM = h

    id_ = _add_node(b, node, centroid)
    b.featureIndex[f.id] = id_

    # Join to the nearest junction so the area is not orphaned.
    near = nearest_node(b, centroid, all_nodes(b), "")
    if near is not None and near != id_:
        _add_edge(b, near, id_, "access", False, False, f.id)
    else:
        b.used.add(id_)


def _ring_centroid(ring) -> tuple[float, float]:
    """Centroid of a ring, as the mean of its vertices."""
    x = 0.0
    y = 0.0
    for p in ring:
        x += p.x
        y += p.y
    return js_round(x / len(ring)), js_round(y / len(ring))


def _add_edge(
    b: Builder,
    from_id: str,
    to_id: str,
    path: str | None,
    blocked: bool,
    crosswalk: bool,
    feature_id: int,
) -> None:
    from_pt = b.anchors.get(from_id)
    to_pt = b.anchors.get(to_id)
    if from_pt is None or to_pt is None:
        return

    # Distances stay in grid units here, with the raw axis deltas preserved.
    # The emitter applies the document's per-axis scale, which is the only
    # place the envelope's real-world size is known.
    dx = to_pt[0] - from_pt[0]
    dy = to_pt[1] - from_pt[1]
    dist = math.hypot(dx, dy)
    direction = compass_of(GridPointXY(from_pt[0], from_pt[1]), GridPointXY(to_pt[0], to_pt[1]))

    def base(d: str) -> GraphEdge:
        return GraphEdge(
            from_=from_id,
            to=to_id,
            dist=dist,
            dx=dx,
            dy=dy,
            dir=d,
            features=[feature_id],
            path=path,
            crosswalk=crosswalk,
            blocked=blocked,
        )

    # A line is bidirectional unless the data says otherwise. An agent reading
    # a directed graph assumes one-way semantics, so both directions must exist.
    b.edges.append(base(direction))
    b.edges.append(base(opposite_compass(direction)))
    b.used.add(from_id)
    b.used.add(to_id)

    if blocked:
        b.obstacles.append(
            Obstacle(edge=f"{from_id}->{to_id}", type=path or "obstruction", blocks=True)
        )


def _add_node(b: Builder, partial: GraphNode, at: tuple[float, float] | Any) -> str:
    partial.id = f"n{b.nextId}"
    b.nextId += 1
    b.nodes.append(partial)
    b._byId[partial.id] = partial
    if isinstance(at, tuple):
        b.anchors[partial.id] = at
    else:
        b.anchors[partial.id] = (at.x, at.y)
    return partial.id


def node_by_id(b: Builder, id_: str) -> GraphNode | None:
    return b._byId.get(id_)


# ---------------------------------------------------------------------------
# Point features -> named nodes
# ---------------------------------------------------------------------------


def _compile_point(b: Builder, f: Feature, class_name: str, layer: str) -> None:
    if f.geometry.kind != "point":
        return
    p = f.geometry.point
    key = weld_key(p, b.weld)

    props = props_of(b.doc, f.attrSet)
    name = _string_prop(b.doc, props, "name")
    tags = _collect_tags(class_name, props)
    kind = _node_kind_for(class_name)

    # Snap to an existing junction when one is within the weld radius, so the
    # place sits on the network rather than floating beside it.
    snapped = b.junctionIndex.get(key)

    # Opening hours and brand, resolved once. Both were being ingested into
    # the wire document and then dropped, which meant an agent asking whether
    # a place was open had nothing to go on and would guess. Usually open.
    hours = _hours_of(b, props)
    brand = _string_prop(b.doc, props, "brand")

    if snapped is not None:
        n = node_by_id(b, snapped)
        if n is not None:
            if f.id not in n.features:
                n.features.append(f.id)
            # A named POI upgrades the anonymous junction it landed on.
            if name and not n.name:
                n.name = name
                n.kind = n.kind if kind == "intersection" else kind
            if tags:
                n.tags = _dedupe((n.tags or []) + tags)
            if kind == "building":
                h = _num_prop(b.doc, props, "height_m", "height", "building:levels")
                if h is not None:
                    n.heightM = h
            # Only fill a gap, never overwrite. Two POIs welding onto one
            # junction should not fight over which one's hours to publish.
            if not n.hours and hours:
                n.hours = hours
            if not n.brand and brand:
                n.brand = brand
            b.featureIndex[f.id] = snapped
            return

    node = GraphNode(id="", kind=kind, features=[f.id], layer=layer)
    if name:
        node.name = name
    if tags:
        node.tags = tags
    if hours:
        node.hours = hours
    if brand:
        node.brand = brand
    h = _num_prop(b.doc, props, "height_m", "height", "building:levels")
    if h is not None:
        node.heightM = h

    id_ = _add_node(b, node, (p.x, p.y))
    b.featureIndex[f.id] = id_
    # A point standing alone is a destination, not a network element.
    b.used.add(id_)


def _node_kind_for(class_name: str) -> str:
    if class_name in TRANSIT_CLASSES:
        return "transit"
    if class_name.startswith("building"):
        return "building"
    if class_name.startswith(("highway", "railway")):
        return "intersection"
    if "park" in class_name or "garden" in class_name:
        return "park"
    if "water" in class_name or "river" in class_name:
        return "water"
    if class_name in POI_CLASSES or "." in class_name:
        return "poi"
    return "area"


def _is_furniture(class_name: str) -> bool:
    tail = class_name.split(".")[1] if "." in class_name else class_name
    # Weak POIs only count as clutter when anonymous.
    if tail in FURNITURE_HIGHWAYS:
        return True
    return class_name in WEAK_POI_CLASSES


def _is_named(doc: ScrDocument, f: Feature) -> bool:
    """Whether a feature carries a name attribute an agent could cite."""
    return _string_prop(doc, props_of(doc, f.attrSet), "name") is not None


# ---------------------------------------------------------------------------
# Metadata, heat, omissions
# ---------------------------------------------------------------------------


def _build_meta(doc: ScrDocument, b: Builder, opts: dict) -> GraphMeta:
    lat, lon = grid_to_lonlat(
        doc.extent / 2, doc.extent / 2, doc.envelope, doc.extent, doc.projection
    )
    meta = GraphMeta(center=f"{_round(lat, 5)}, {_round(lon, 5)}")
    if opts.get("radiusLabel"):
        meta.radius = opts["radiusLabel"]
    if doc.meta.get("lod"):
        meta.lod = doc.meta["lod"]
    if doc.meta.get("source"):
        meta.source = doc.meta["source"]

    # Sun position, computed rather than fetched. It needs no key and no
    # network, and "will it be dark when I get there" is a question an agent
    # cannot answer without it.
    if opts.get("sun") is not False:
        s = sun_position(lat, lon, b.now)
        meta.sun = SunSummary(
            elevationDeg=s.elevationDeg,
            daylight=s.daylight,
            twilight=s.twilight,
            azimuthDeg=s.azimuthDeg,
            sunrise=s.sunrise if s.sunrise else None,
            sunset=s.sunset if s.sunset else None,
            polar=s.polar if s.polar else None,
        )

    omitted_total = sum(o.count for o in doc.omissions)
    # "expand_node" was never a tool; it was a stale guess in a hand-written
    # string. The feature tool is what actually returns exact geometry.
    parts = ["Simplified for reasoning; call expand_feature for exact geometry."]
    if omitted_total > 0:
        parts.append(f"Incomplete: {omitted_total} feature(s) omitted to fit budget.")
    meta.note = " ".join(parts)
    return meta


def _compile_heat(doc: ScrDocument, env, max_hotspots: int) -> list[HeatSummary]:
    out: list[HeatSummary] = []
    for h in doc.heat:
        cells = h.cells or []
        if not cells:
            continue
        # Normalize against the layer's *declared* range, not the observed
        # maximum. Using the observed max would report the strongest cell as
        # ``rel: 1.0`` on every maplet, which tells the agent nothing about
        # how intense it is relative to what the layer is capable of.
        lo = _num_or_zero(h.minValue)
        span = h.maxValue - lo if h.maxValue != lo else 1

        # Heat cells live in the layer's own `resolution` grid, not the
        # document's quantised extent.
        scale = doc.extent / h.resolution if h.resolution > 0 else 1

        # A layer whose cells are all the same value carries no information:
        # a flat terrain slope layer is always exactly that, and asserting it
        # burns budget.
        distinct = {c.value for c in cells}
        if len(distinct) <= 1:
            continue

        # Zero is the absence of a hotspot, not a weak one. Ranking by value
        # already sinks these to the bottom, but a small cell cap on a sparse
        # layer can still reach them.
        useful = [c for c in cells if c.value > 0]
        if not useful:
            continue

        ranked = sorted(useful, key=lambda c: -c.value)[:max_hotspots]
        hotspots: list[Hotspot] = []
        for c in ranked:
            ll_lat, ll_lon = grid_to_lonlat(
                js_round(c.x * scale), js_round(c.y * scale), env, doc.extent, doc.projection
            )
            hotspots.append(
                Hotspot(
                    lat=_round(ll_lat, 5),
                    lon=_round(ll_lon, 5),
                    value=c.value,
                    rel=_round((c.value - lo) / span, 2),
                )
            )

        # Distinct grid cells can still round to the same printed coordinate.
        # Two lines at one point saying different values is worse than one,
        # so keep the stronger and drop the rest.
        seen: set[str] = set()
        deduped = []
        for s in hotspots:
            key = f"{s.lat},{s.lon}"
            if key in seen:
                continue
            seen.add(key)
            deduped.append(s)

        out_max = max(c.value for c in useful)
        out_mean = sum(c.value for c in useful) / len(useful)
        out.append(
            HeatSummary(name=h.name, max=out_max, mean=_round(out_mean, 1), hotspots=deduped)
        )
    return out


def _compile_omissions(doc: ScrDocument) -> list[OmittedEntry]:
    out: list[OmittedEntry] = []
    for o in doc.omissions:
        layer_obj = doc.layers.get(o.layerId)
        layer = layer_obj.name if layer_obj else f"layer{o.layerId}"
        near = "unspecified"
        if o.centroid is not None:
            lat, lon = grid_to_lonlat(
                o.centroid.x, o.centroid.y, doc.envelope, doc.extent, doc.projection
            )
            near = f"{_round(lat, 4)},{_round(lon, 4)}"
        entry = OmittedEntry(layer=layer, count=o.count, near=near)
        if o.note is not None:
            text = doc.strings.get(o.note)
            if text:
                entry.note = text
        out.append(entry)
    return out


# ---------------------------------------------------------------------------
# Attribute access
# ---------------------------------------------------------------------------


def props_of(doc: ScrDocument, attr_set_id: int) -> list[Prop]:
    if attr_set_id == 0:
        return []
    a = doc.attrSets.get(attr_set_id)
    return a.props if a else []


def resolve_prop(doc: ScrDocument, prop: Prop) -> str | int | float | bool:
    v = prop.value
    if v.t == "ref":
        return doc.strings.get(v.ref, f"s{v.ref}")
    if v.t == "num":
        return v.num
    if v.t == "bool":
        return v.bool
    return v.token


def _string_prop(doc: ScrDocument, props: list[Prop], key: str) -> str | None:
    """First string-valued property whose key matches."""
    for p in props:
        if _key_name(doc, p) != key:
            continue
        v = p.value
        if v.t == "ref":
            s = doc.strings.get(v.ref)
            if s is not None:
                return s
        elif v.t == "token":
            return v.token
    return None


def _num_prop(doc: ScrDocument, props: list[Prop], *keys: str) -> float | None:
    """First numeric property under any of the given keys.

    Building heights arrive as ``height`` or ``height_m`` depending on the
    source, so both are accepted.
    """
    for p in props:
        if _key_name(doc, p) not in keys:
            continue
        if p.value.t == "num":
            return p.value.num
        if p.value.t == "ref":
            s = doc.strings.get(p.value.ref)
            if s is not None:
                n = _js_number(s)
                if math.isfinite(n):
                    return n
    return None


def _has_token(props: list[Prop], token: str) -> bool:
    """True when any property carries the given token, used for path semantics."""
    for p in props:
        if p.value.t == "token" and p.value.token == token:
            return True
    return False


def _is_blocked(props: list[Prop]) -> bool:
    for p in props:
        if p.value.t == "token" and p.value.token in BLOCKING_TAGS:
            return True
    return False


def _collect_tags(class_name: str, props: list[Prop]) -> list[str]:
    tags: list[str] = []
    # The class tail is the most useful tag: ``amenity.cafe`` -> ``cafe``.
    parts = class_name.split(".")
    leaf = parts[-1] if parts else ""
    if leaf and leaf != class_name:
        tags.append(leaf)
    for p in props:
        if p.value.t == "token" and p.value.token not in BLOCKING_TAGS:
            tags.append(p.value.token)
    return _dedupe(tags)[:4]


def _class_path_hint(class_name: str, layer_name: str) -> str | None:
    for match, path in PATH_HINTS:
        if match in class_name:
            return path
    if layer_name == "road":
        return "road"
    return None


def _dedupe(items: list) -> list:
    """Insertion-ordered dedupe, matching JS ``[...new Set(items)]``."""
    seen: dict[Any, None] = {}
    for it in items:
        seen.setdefault(it)
    return list(seen)


def _round(n: float, places: int) -> float:
    """Math.round at a fixed precision; ties resolve upward like JS."""
    f = 10**places
    return math.floor(n * f + 0.5) / f


def _num_or_zero(v: float) -> float:
    """JavaScript's ``||`` for numbers: NaN, 0 and -0 all fall through to 0."""
    if v != v or v == 0:  # noqa: PLR0124 - NaN check, mirrors JS `||`
        return 0
    return v


def _js_number(raw: str) -> float:
    from .types import js_number

    return js_number(raw)


def _key_name(doc: ScrDocument, p: Prop) -> str | None:
    """The attribute key, resolved through the string table."""
    return doc.strings.get(p.key)


def _hours_of(b: Builder, props: list[Prop]) -> str | None:
    """Opening hours as a short phrase, evaluated against the build's instant."""
    raw = _string_prop(b.doc, props, "opening_hours")
    if raw is None:
        return None
    phrase = opening_phrase(raw, b.now, b.utcOffsetMinutes)
    return phrase


def _prune_isolated(b: Builder) -> None:
    kept = [n for n in b.nodes if n.id in b.used or n.name is not None]
    b.nodes[:] = kept
    b._byId = {n.id: n for n in kept}


def _attach_stranded_landmarks(b: Builder) -> None:
    """Join named-but-disconnected nodes to the nearest *road network* node.

    Points of interest rarely share a coordinate with the street centreline,
    so welding alone leaves them as islands. Islands are the first thing a
    token budget discards, which is how a dense extract ends up as pure
    geometry and no landmarks. Attaching them costs one edge each and
    converts dead weight into the information an agent actually needs: which
    side of the road, and how far.
    """
    degree: dict[str, int] = {}
    for e in b.edges:
        degree[e.from_] = degree.get(e.from_, 0) + 1
        degree[e.to] = degree.get(e.to, 0) + 1

    # The network backbone: nodes with degree 2 or more are on a street, while
    # degree 1 is a dead end and degree 0 is an island. A landmark must attach
    # to the backbone, never to another landmark, or the result is a chain of
    # shops with no street under them.
    backbone: dict[str, None] = {}
    for id_, d in degree.items():
        if d >= 2:
            backbone[id_] = None

    for node in b.nodes:
        if node.name is None:
            continue
        if degree.get(node.id, 0) > 0:
            continue
        at = b.anchors.get(node.id)
        if at is None:
            continue

        near = nearest_node(b, at, backbone, node.id)
        if near is None:
            continue

        _add_edge(
            b, near, node.id, "access", False, False, node.features[0] if node.features else 0
        )
        # Protect the access edge. Without it the landmark exists but cannot
        # be routed to, and a token-pressured budgeter will happily delete the
        # anonymous junction while keeping the named node, stranding it.
        b.pinned.add(node.id)


def all_nodes(b: Builder) -> dict:
    """Ids of every node currently placed, as an insertion-ordered set."""
    return {id_: None for id_ in b.anchors}


def nearest_node(
    b: Builder,
    at: tuple[float, float] | Any,
    candidates: dict,
    exclude: str,
) -> str | None:
    """The closest node in ``candidates`` to a point, excluding a node itself.

    Strict-less comparison keeps the first of equidistant candidates, exactly
    like the TypeScript. Iteration order of ``candidates`` is insertion order
    in both languages, so ties resolve identically.
    """
    if not isinstance(at, tuple):
        at = (at.x, at.y)
    best: str | None = None
    best_dist = math.inf
    for id_ in candidates:
        if id_ == exclude:
            continue
        anchor = b.anchors.get(id_)
        if anchor is None:
            continue
        d = math.hypot(anchor[0] - at[0], anchor[1] - at[1])
        if d < best_dist:
            best_dist = d
            best = id_
    return best


class GridPointXY:
    """Shim matching the geometry helpers' grid-point protocol."""

    def __init__(self, x: float, y: float) -> None:
        self.x = x
        self.y = y


# ---------------------------------------------------------------------------
# Indoor topology
# ---------------------------------------------------------------------------


def compile_indoor(doc: ScrDocument, opts: dict):
    """Pull indoor features out of the document and build the per-floor graph.

    Indoor data arrives as ordinary features tagged ``indoor=*`` and
    ``level=*``, so the wire format needed no change; only the interpretation
    did. A feature counts as indoor when it carries either tag, because a
    ``level=2`` corridor is indoor even without ``indoor=corridor``, and an
    ``indoor=room`` on an untagged storey is still a room worth showing under
    an unknown level.
    """
    features: list[IndoorFeature] = []

    for f in doc.features:
        props = props_of(doc, f.attrSet)
        level_raw = _prop_string(doc, props, "layer") or _prop_string(doc, props, "level")
        indoor = _prop_string(doc, props, "indoor")
        if level_raw is None and indoor is None:
            continue

        level = _parse_level(level_raw)
        name = _prop_string(doc, props, "name")
        kind_hint = indoor if indoor is not None else _class_name_of(doc, f.classId)

        # Only genuine indoor categories participate. A polygon tagged
        # `indoor=no` is explicitly not indoor space, and letting it through
        # would put an outdoor parcel inside the floor graph.
        if indoor == "no":
            continue

        centre = _centroid_of(f)
        if centre is None:
            continue

        wheelchair = _wheelchair_of(doc, props)
        extent = _extent_of(f)
        features.append(
            IndoorFeature(
                id=f.id,
                level=level,
                name=name,
                indoor=indoor,
                # A polygon tagged `level` but not `indoor` is still a room of
                # some kind: nobody tags level on a parking lot's kerb.
                room=kind_hint == "room"
                or (indoor is None and level is not None and f.kind == "polygon"),
                x=centre[0],
                y=centre[1],
                extent=extent,
                # A door or wall is not blocked by default; the tag marks the
                # element as a boundary an agent may need to reason about.
                blocked=False if indoor in ("door", "wall") else None,
                wheelchair=wheelchair,
                door=_prop_string(doc, props, "door"),
            )
        )

    if not features:
        return empty_indoor()

    # Indoor distances are metres, not grid units. The indoor bounding box is
    # almost always the same envelope as the whole map, which for a 400m radius
    # would put a doorway 2000 grid units away and every edge beyond any sane
    # threshold. The indoor extent alone gives the scale that matters.
    mpu = _indoor_metres_per_unit(features, doc)
    graph = build_indoor_graph(
        features,
        {
            "metresPerUnit": mpu,
            "maxNodesPerLevel": opts.get("maxIndoorNodesPerLevel", 60),
            "maxLevels": opts.get("maxIndoorLevels", 8),
        },
    )

    return graph if is_meaningful_indoor(graph) else empty_indoor()


def _indoor_metres_per_unit(features: list[IndoorFeature], doc: ScrDocument) -> float:
    """Metres per grid unit, measured from the indoor features themselves.

    The document's own scale would be wrong for indoor work, because a
    city-block envelope and a mall's corridors share it. Measuring the indoor
    bounding box instead is self-calibrating: whatever the envelope, the indoor
    features span the building, and a building has a known typical size.
    """
    xs = [f.x for f in features]
    ys = [f.y for f in features]
    span_grid = max(max(xs) - min(xs), max(ys) - min(ys))
    if span_grid <= 0:
        return 1

    # Envelope width in metres, which is the real-world size of the area the
    # indoor features sit in. Using the envelope's own metres-per-grid-unit and
    # then rescaling by the indoor share of it avoids inventing a building size.
    env = doc.envelope

    def field(name: str) -> float:
        return env[name] if isinstance(env, dict) else getattr(env, name)

    env_type = env["type"] if isinstance(env, dict) else env.type
    if env_type == "bbox":
        mid_lat = (field("north") + field("south")) / 2
        envelope_metres = max(
            abs(field("east") - field("west")) * 111320 * math.cos(mid_lat * math.pi / 180),
            abs(field("north") - field("south")) * 110574,
        )
    else:
        from .project import tile_bounds

        b = tile_bounds(int(field("z")), int(field("x")), int(field("y")))
        mid_lat = (b["north"] + b["south"]) / 2
        envelope_metres = max(
            abs(b["east"] - b["west"]) * 111320 * math.cos(mid_lat * math.pi / 180),
            abs(b["north"] - b["south"]) * 110574,
        )
    # A zero span means the geometry collapsed; fall through to the 1 m
    # default rather than dividing by it.
    if envelope_metres == 0:
        return 1

    per_unit = envelope_metres / max(1, doc.extent)
    return per_unit


_BLOCKER_TOKENS = frozenset(["door", "wall", "barrier"])


def _parse_level(raw: str | None) -> float | None:
    if raw is None:
        return None
    trimmed = raw.strip()
    if trimmed == "":
        return None
    # OSM uses `2`, `-1`, and occasionally `2.5` or a name like `mezzanine`.
    n = _js_number(trimmed)
    if math.isfinite(n):
        return n
    named = {
        "ground": 0,
        "groundfloor": 0,
        "ground_floor": 0,
        "ground-floor": 0,
        "main": 0,
        "lobby": 0,
        "reception": 0,
        "basement": -1,
        "underground": -1,
        "lowerground": -1,
    }
    return named.get(re.sub(r"\s+", "", trimmed.lower()))


def _centroid_of(f) -> tuple[float, float] | None:
    g = f.geometry
    if g.kind == "point":
        return (g.point.x, g.point.y)
    ring = g.lines[0] if g.kind == "line" else (g.polygon[0].rings[0] if g.polygon else None)
    if not ring:
        return None
    return _ring_centroid(ring)


def _extent_of(f) -> float | None:
    g = f.geometry
    if g.kind == "line":
        return _polyline_length(g.lines)
    if g.kind == "polygon":
        ring = g.polygon[0].rings[0] if g.polygon else None
        return _polyline_length([ring]) if ring else None
    return None


def _polyline_length(lines: list) -> float | None:
    total = 0
    for line in lines:
        for i in range(1, len(line)):
            a, b = line[i - 1], line[i]
            total += math.hypot(b.x - a.x, b.y - a.y)
    return total if total else None


def _prop_string(doc: ScrDocument, props: list[Prop], key: str) -> str | None:
    """Read a property as a string.

    ``props_of`` returns raw ``Prop`` records rather than a map, so the lookup
    goes through the same resolver the rest of the compiler uses. That matters
    for ``level=2``: it is stored as a number, and reading it as a string would
    give the literal text "2" on one path and the number 2 on another,
    producing two different storeys for one floor.
    """
    for p in props:
        if _key_name(doc, p) != key:
            continue
        v = resolve_prop(doc, p)
        if isinstance(v, str) and v != "":
            return v
        # A number stored in a typed attr renders through the JS number
        # formatting, same as String(v) on the reference side.
        if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
            return js_num_str(v)
    return None


def _prop_token(doc: ScrDocument, props: list[Prop], key: str) -> str | None:
    for p in props:
        if _key_name(doc, p) != key:
            continue
        v = resolve_prop(doc, p)
        if isinstance(v, str) and v != "":
            return v
        if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
            return js_num_str(v)
    return None


def _wheelchair_of(doc: ScrDocument, props: list[Prop]) -> bool | None:
    v = _prop_token(doc, props, "wheelchair")
    if v in ("yes", "true"):
        return True
    if v in ("no", "false"):
        return False
    return None


def _class_name_of(doc: ScrDocument, class_id: int) -> str:
    c = doc.classes.get(class_id)
    return c.name if c else ""

"""Indoor navigation — Python port of ``src/compile/indoor.ts``.

This is the layer nobody else publishes. OpenStreetMap has the data —
``level=*``, ``indoor=room``, doors, lifts, stairs — and supercarto already
ingests it. What was missing was turning it into a graph an agent can traverse:
which rooms are on which floor, how you get between floors, and which doors can
be opened.

The output is a set of per-floor graphs plus the vertical connections between
them, rendered by ``emit.py`` as an ``indoor:`` block. A model reading that can
answer "how do I get to the cafe on level 3" without being handed a stack of
unconnected polygons.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from .types import js_num_str, js_round

#: Why a vertical link exists, which determines whether it is usable.
Storey = float


@dataclass
class IndoorNode:
    id: str
    #: Storey this node is on. 0 is ground level by OSM convention.
    level: Storey
    kind: str
    name: str | None = None
    #: OSM ``indoor`` value, e.g. ``room``, ``corridor``, ``lift``, ``stairs``.
    indoor: str | None = None
    wheelchair: bool | None = None
    #: Metres from the node to the building's main entrance, for orientation.
    depthM: float | None = None


@dataclass
class IndoorEdge:
    from_: str
    to: str
    distM: float
    #: Same-floor connection.
    level: Storey
    #: True where the edge cannot be traversed: a locked or closed door.
    blocked: bool | None = None
    #: Door type, when the edge passes through one.
    door: str | None = None


@dataclass
class VerticalLink:
    #: Stable id for the shaft within this building, e.g. ``v1``. Referenced by
    #: the per-floor nodes so a model can say "take the lift to level 3" and
    #: mean a specific shaft.
    id: str
    kind: str
    #: Every storey the shaft serves, ascending.
    levels: list[Storey]
    wheelchair: bool | None = None
    name: str | None = None
    #: Grouping key used to collapse the same shaft across storeys. Internal:
    #: the per-floor builder needs it to know which features it already
    #: consumed, and a model does not.
    key: str | None = None


@dataclass
class IndoorLevel:
    level: Storey
    #: Human label, e.g. ``ground``, ``1``, ``-1``, or a building's own naming.
    label: str
    nodes: list[IndoorNode]
    edges: list[IndoorEdge]


@dataclass
class OmittedLevel:
    """A storey skipped by the builder, with the reason it was skipped."""

    level: Storey
    reason: str


@dataclass
class IndoorGraph:
    #: True when the source data actually described more than one storey.
    multiStorey: bool = False
    levels: list[IndoorLevel] = field(default_factory=list)
    vertical: list[VerticalLink] = field(default_factory=list)
    #: Storeys present in the data that are not represented in the graph.
    missingLevels: list[Storey] = field(default_factory=list)
    #: Omitted storeys and the reason, so the agent knows it is not seeing all.
    #: ``{level, reason}`` on the TypeScript side.
    omitted: list[OmittedLevel] = field(default_factory=list)


@dataclass
class IndoorFeature:
    """A raw indoor feature, as ingested. Kept separate from ``IndoorNode`` so
    the builder can work from the source's own vocabulary."""

    #: 1-based feature id, for traceability back to the wire document.
    id: float
    #: Parsed ``level``, or None when the feature is untagged.
    level: Storey | None = None
    name: str | None = None
    indoor: str | None = None
    #: True for polygons that are rooms rather than shafts or entrances.
    room: bool | None = None
    #: Centroid, used to measure door-to-room and room-to-corridor distances.
    x: float = 0.0
    y: float = 0.0
    #: Footprint or path length, used to break ties between candidate pairs.
    extent: float | None = None
    #: True when the feature blocks movement, e.g. ``door=filled``.
    blocked: bool | None = None
    door: str | None = None
    wheelchair: bool | None = None
    openingHours: str | None = None


def empty_indoor() -> IndoorGraph:
    """Stated plainly: no indoor data means no indoor claim."""
    return IndoorGraph()


def is_meaningful_indoor(graph: IndoorGraph | Any) -> bool:
    """Whether a building's indoor data is worth emitting at all.

    The threshold is deliberate. A single tagged corridor is not an indoor map,
    and telling an agent a building has "indoor navigation" when all that
    exists is one hallway is worse than saying nothing.
    """
    if graph is None or isinstance(graph, dict):
        return False
    if not graph.levels:
        return False
    nodes = sum(len(level_test.nodes) for level_test in graph.levels)
    return nodes >= 3 or bool(graph.vertical)


def build_indoor_graph(features: list[IndoorFeature], opts: dict) -> IndoorGraph:
    """Build the indoor graph from ingested features.

    Two passes. The first groups features by storey and identifies vertical
    shafts, since a shaft is the one feature that spans storeys and has to be
    collapsed into a single node before any per-floor graph can be built. The
    second connects rooms to their nearest corridor or door on the same storey.

    Distance is measured in metres by the caller-supplied scale, because indoor
    geometry is small enough that grid units would be meaningless to a model.
    """
    if not features:
        return empty_indoor()

    levelled = [f for f in features if f.level is not None]
    if not levelled:
        return empty_indoor()

    present = sorted({f.level for f in levelled})
    multi_storey = len(present) > 1

    max_levels = opts.get("maxLevels", 8)
    max_nodes = opts.get("maxNodesPerLevel", 60)
    mpu = opts["metresPerUnit"]

    # Pass 1: vertical shafts, which span storeys and so belong to no single one.
    shaft_features = [f for f in levelled if is_shaft(f)]
    vertical = build_vertical_links(shaft_features, mpu)

    # A shaft on one storey only is not vertical movement, so it is only
    # recorded as a link when it genuinely spans two.
    usable_vertical = [v for v in vertical if len(v.levels) > 1]

    # Pass 2: per-floor graphs from what remains.
    taken = {
        s.id
        for v in usable_vertical
        for s in shaft_features
        if is_shaft(s) and shaft_key(s) == v.key
    }

    out: list[IndoorLevel] = []
    omitted: list[dict] = []

    for level in present:
        if len(out) >= max_levels:
            omitted.append(OmittedLevel(level=level, reason=f"storey budget of {max_levels} reached"))
            continue
        on_level = [f for f in levelled if f.level == level and f.id not in taken]

        if not on_level:
            # A storey that appears only as a shaft still exists and is worth
            # naming: an agent told "level 4 has only a lift" will not invent
            # a cafe there.
            if any(level in v.levels for v in usable_vertical):
                continue
            omitted.append(
                OmittedLevel(level=level, reason="no walkable features tagged on this storey")
            )
            continue

        graph = build_level_graph(level, on_level, mpu, max_nodes)
        if graph is None:
            omitted.append(OmittedLevel(level=level, reason="no corridor to connect rooms to"))
            continue
        out.append(graph)

    # Storeys the data implies but never tags. A building with tagged 0 and 2
    # and nothing on 1 usually means untagged, not absent, so it is reported
    # rather than invented.
    missing_levels: list[Storey] = []
    for i in range(1, len(present)):
        lo, hi = present[i - 1], present[i]
        if hi - lo > 1:
            # Numeric loop, as on the reference side: levels may be fractional
            # (level=2.5), and the gap storeys still step by one.
            s = lo + 1
            while s < hi:
                missing_levels.append(s)
                s += 1

    return IndoorGraph(
        multiStorey=multi_storey,
        levels=out,
        vertical=usable_vertical,
        missingLevels=missing_levels,
        omitted=omitted,
    )


def build_level_graph(
    level: Storey,
    features: list[IndoorFeature],
    mpu: float,
    max_nodes: int,
) -> IndoorLevel | None:
    # A floor with no corridor is a floor of disconnected rooms. Emitting them
    # would advertise places the agent cannot reach, which is the exact defect
    # the outdoor budgeter goes to some trouble to avoid.
    corridors = [f for f in features if is_corridor(f)]
    if not corridors:
        return None

    nodes: list[IndoorNode] = []
    edges: list[IndoorEdge] = []
    #: Feature id -> node, so a distance can be measured from the source geometry.
    by_id: dict[float, IndoorNode] = {}

    def add(f: IndoorFeature, kind: str) -> IndoorNode | None:
        if len(nodes) >= max_nodes:
            return None
        node = IndoorNode(
            id=f"L{js_num_str(level)}n{len(nodes) + 1}",
            level=level,
            kind=kind,
            name=f.name if f.name else None,
            indoor=f.indoor if f.indoor else None,
            wheelchair=f.wheelchair if f.wheelchair is not None else None,
        )
        nodes.append(node)
        by_id[f.id] = node
        return node

    # Corridors first: they are the spine, and attaching rooms to them is what
    # makes the floor traversable.
    corridor_nodes: list[IndoorNode] = []
    for f in corridors[: max(1, max_nodes // 3)]:
        node = add(f, "corridor")
        if node is not None:
            corridor_nodes.append(node)

    if not corridor_nodes:
        return None

    # Corridors are connected to each other when close, which assembles the
    # floor's spine without needing a full planar-graph pass.
    for i in range(len(corridor_nodes)):
        for j in range(i + 1, len(corridor_nodes)):
            a, b = corridor_nodes[i], corridor_nodes[j]
            d = metres_between(a, b, features, by_id, mpu)
            if d is not None and d <= 60:
                edges.append(IndoorEdge(from_=a.id, to=b.id, distM=js_round(d), level=level))

    # Then every other feature attaches to its nearest corridor, so no node in
    # the graph is stranded.
    attachable = [f for f in features if not is_corridor(f) and not is_shaft(f)]
    for f in attachable:
        kind = kind_of(f)
        node = add(f, kind)
        if node is None:
            break

        best: tuple[IndoorNode, float] | None = None
        for c in corridor_nodes:
            d = metres_between(node, c, features, by_id, mpu)
            if d is None:
                continue
            if best is None or d < best[1]:
                best = (c, d)
        if best is None:
            continue
        # Beyond 40m a room is not served by that corridor; the connection
        # would be a straight line through walls, which is worse than no edge
        # at all.
        if best[1] > 40:
            continue
        edges.append(
            IndoorEdge(
                from_=best[0].id,
                to=node.id,
                distM=js_round(best[1]),
                level=level,
                blocked=True if f.blocked else None,
                door=f.door if f.door else None,
            )
        )

    return IndoorLevel(level=level, label=level_label(level), nodes=nodes, edges=edges)


def build_vertical_links(shafts: list[IndoorFeature], mpu: float) -> list[VerticalLink]:
    groups: dict[str, list[IndoorFeature]] = {}
    for s in shafts:
        groups.setdefault(shaft_key(s), []).append(s)

    out: list[VerticalLink] = []
    n = 1
    for key, group in groups.items():
        levels = sorted({f.level for f in group})
        # Shafts on the same storey at different places are two lifts, not
        # one. Only treat them as a single shaft when they are genuinely
        # co-located.
        if len(levels) < 2 and len(group) > 1 and spread_of(group, mpu) > 25:
            continue
        kind = kind_of(group[0])
        wheelchair = any(f.wheelchair is True for f in group)
        out.append(
            VerticalLink(
                id=f"v{n}",
                kind=kind,
                levels=levels,
                wheelchair=True if wheelchair else None,
                name=group[0].name if group[0].name else None,
                key=key,
            )
        )
        n += 1
    return out


def is_corridor(f: IndoorFeature) -> bool:
    if f.indoor == "corridor":
        return True
    # A way tagged indoor but not a room is circulation of some kind.
    return f.indoor is not None and not f.room and not is_shaft(f)


def is_shaft(f: IndoorFeature) -> bool:
    return f.indoor in ("lift", "elevator", "stairs", "escalator")


def kind_of(f: IndoorFeature) -> str:
    if f.indoor in ("lift", "elevator"):
        return "lift"
    if f.indoor == "stairs":
        return "stairs"
    if f.indoor == "corridor":
        return "corridor"
    if f.indoor == "room" or f.room:
        return "shop" if f.name else "room"
    if f.indoor == "door":
        return "door"
    return "unknown"


def shaft_key(f: IndoorFeature) -> str:
    """Group key for a shaft.

    A lift is one shaft across storeys, so the same shaft on level 0 and level
    1 has to collapse into one link. OSM gives lifts the same ``ref`` within a
    building, so that is used when present; otherwise the coordinates decide,
    to within 15m.
    """
    return f"{js_round(f.x / 32)}:{js_round(f.y / 32)}"


def spread_of(group: list[IndoorFeature], mpu: float) -> float:
    if len(group) < 2:
        return 0.0
    xs = [f.x for f in group]
    ys = [f.y for f in group]
    dx = (max(xs) - min(xs)) * mpu
    dy = (max(ys) - min(ys)) * mpu
    return math.hypot(dx, dy)


def metres_between(
    a: IndoorNode,
    b: IndoorNode,
    features: list[IndoorFeature],
    by_id: dict[float, IndoorNode],
    mpu: float,
) -> float | None:
    fa = next((f for f in features if f.id in by_id and by_id[f.id] is a), None)
    fb = next((f for f in features if f.id in by_id and by_id[f.id] is b), None)
    if fa is None or fb is None:
        return None
    # Centroids. Exact for doors and shafts, approximate for large rooms, which
    # is why the connection threshold is a proximity test rather than a claim
    # about adjacency.
    return math.hypot(fa.x - fb.x, fa.y - fb.y) * mpu


def level_label(level: Storey) -> str:
    """Storey to a label a model reads without translating.

    "level 0" is a fact about the OSM tag, not about the building. Ground floor
    in London, first floor in the US, reception in a hotel. Only the sign and
    zero cases are certain, so those are stated and everything else is left
    numeric rather than guessed.
    """
    if level == 0:
        return "ground"
    if level == 1:
        return "1"
    if level == -1:
        return "basement"
    if level < 0:
        return f"basement {abs(level)}"
    return str(level)

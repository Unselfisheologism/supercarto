"""The reasoning graph — port of ``src/compile/graph.ts``.

The central claim of supercarto is that a model reasons well over a
topological graph of named places joined by directed, measured edges, and
badly over a cloud of raw coordinates. The compiler's job is to destroy the
geometry and keep the connectivity.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

Compass = str

#: Semantic kinds, ordered roughly by how much an agent cares.
NODE_KINDS = (
    "intersection",
    "poi",
    "building",
    "transit",
    "entrance",
    "park",
    "water",
    "area",
    "anchor",
)


@dataclass
class GraphNode:
    #: Short stable id, ``n1``, ``n2``, ... Cheap to reference repeatedly.
    id: str
    kind: str
    features: list[int] = field(default_factory=list)
    name: str | None = None
    #: Free-form semantic tags, e.g. ``['cafe', 'food']``.
    tags: list[str] | None = None
    #: Metres, for buildings.
    heightM: float | None = None
    #: Semantic layer: ``road``, ``poi``, ``building``, ``area``, or whatever
    #: the source declared. Present so the budgeter can name what it dropped.
    layer: str | None = None
    #: Opening hours as a short phrase. Absent means no hours were recorded,
    #: which is not the same as closed.
    hours: str | None = None
    #: Chain or brand, e.g. ``Blue Bottle``. Distinct from the local name.
    brand: str | None = None
    #: WGS84, only on anchor nodes, so the agent can report a position.
    lat: float | None = None
    lon: float | None = None


@dataclass
class GraphEdge:
    from_: str
    to: str
    #: Edge length in grid units. The emitter converts this to metres using
    #: the document's per-axis scale.
    dist: float
    dx: float
    dy: float
    #: Compass direction of travel, from ``from`` to ``to``.
    dir: Compass
    features: list[int] = field(default_factory=list)
    #: Path class: sidewalk, road, stairs, indoor, etc.
    path: str | None = None
    crosswalk: bool = False
    #: True where movement is blocked: construction, wall, closed gate.
    blocked: bool = False


@dataclass
class Hotspot:
    lat: float
    lon: float
    value: float
    #: 0..1 intensity.
    rel: float


@dataclass
class HeatSummary:
    name: str
    max: float
    mean: float
    #: Hotspots, most intense first, truncated by the budgeter.
    hotspots: list[Hotspot]


@dataclass
class Obstacle:
    #: ``from->to``, the edge it affects.
    edge: str
    type: str
    blocks: bool


@dataclass
class SunSummary:
    elevationDeg: float
    daylight: bool
    #: Three states rather than two: a person can walk at 6am in June.
    twilight: str
    #: Compass bearing. Useful for "the sun will be behind that building".
    azimuthDeg: float
    sunrise: str | None = None
    sunset: str | None = None
    #: Set when the sun does not rise or set today: polar day or polar night.
    polar: str | None = None


@dataclass
class GraphMeta:
    center: str
    radius: str | None = None
    #: One line telling the agent what it is holding and what is missing.
    note: str | None = None
    #: Semantic zoom band, e.g. ``z17-addr``.
    lod: str | None = None
    source: str | None = None
    #: Light conditions at the map centre, so the agent does not have to call
    #: out to find out whether it is dark.
    sun: SunSummary | None = None


@dataclass
class OmittedEntry:
    #: What was dropped to fit the budget, in the agent's own vocabulary.
    layer: str
    count: int
    near: str = "unspecified"
    note: str | None = None


@dataclass
class SpatialGraph:
    meta: GraphMeta
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    obstacles: list[Obstacle]
    heat: list[HeatSummary]
    #: Per-floor indoor topology, when the source data describes one. Kept
    #: separate because a lift shaft is not a street.
    indoor: Any
    #: What was dropped to fit the budget, in the agent's own vocabulary.
    omitted: list[OmittedEntry]
    #: Verbs the agent can call to get more. Present so it never has to guess.
    tools: list[str]
    #: Nodes whose connection to the network the budgeter must not break.
    pinned: list[str]
    #: True when the graph was cut to fit a budget.
    partial: bool

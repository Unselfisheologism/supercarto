"""Grid geometry helpers — port of ``src/geo/geometry.ts``.

Includes the Visvalingam-Whyatt simplifier with an explicit port of the
TypeScript MinHeap, because pop order between equal priorities is observable
in the simplified output and a different heap would break output parity.
"""

from __future__ import annotations

import math
from collections.abc import Iterable

from .types import GridPoint, js_round

Compass = str

_COMPASS = [
    "north",
    "northeast",
    "east",
    "southeast",
    "south",
    "southwest",
    "west",
    "northwest",
]


# ---------------------------------------------------------------------------
# Bounding boxes
# ---------------------------------------------------------------------------


def bbox_of_line(line: Iterable[GridPoint]) -> dict[str, float]:
    box = {"minX": math.inf, "minY": math.inf, "maxX": -math.inf, "maxY": -math.inf}
    for p in line:
        box["minX"] = min(box["minX"], p.x)
        box["minY"] = min(box["minY"], p.y)
        box["maxX"] = max(box["maxX"], p.x)
        box["maxY"] = max(box["maxY"], p.y)
    return box


def bbox_of_points(points: Iterable[GridPoint]) -> dict[str, float]:
    return bbox_of_line(points)


def bbox_center(box: dict[str, float]) -> GridPoint:
    return GridPoint(
        js_round((box["minX"] + box["maxX"]) / 2),
        js_round((box["minY"] + box["maxY"]) / 2),
    )


def bbox_intersects(a: dict[str, float], b: dict[str, float]) -> bool:
    return not (
        a["maxX"] < b["minX"] or b["maxX"] < a["minX"] or a["maxY"] < b["minY"] or b["maxY"] < a["minY"]
    )


def bbox_contains(outer: dict[str, float], inner: dict[str, float]) -> bool:
    return (
        inner["minX"] >= outer["minX"]
        and inner["minY"] >= outer["minY"]
        and inner["maxX"] <= outer["maxX"]
        and inner["maxY"] <= outer["maxY"]
    )


# ---------------------------------------------------------------------------
# Visvalingam-Whyatt simplification
# ---------------------------------------------------------------------------


def _perp_distance(p: GridPoint, a: GridPoint, b: GridPoint) -> float:
    dx = b.x - a.x
    dy = b.y - a.y
    if dx == 0 and dy == 0:
        return math.hypot(p.x - a.x, p.y - a.y)
    t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)
    clamped = max(0, min(1, t))
    proj_x = a.x + clamped * dx
    proj_y = a.y + clamped * dy
    return math.hypot(p.x - proj_x, p.y - proj_y)


class _MinHeap:
    """Minimal binary min-heap keyed on a numeric priority.

    A line-for-line port of the TypeScript heap: equal priorities pop in the
    same order as it does, which is what keeps simplification output identical.
    """

    def __init__(self) -> None:
        self.prio: list[float] = []
        self.vals: list[int] = []

    @property
    def size(self) -> int:
        return len(self.vals)

    def push(self, priority: float, value: int) -> None:
        self.prio.append(priority)
        self.vals.append(value)
        i = len(self.vals) - 1
        while i > 0:
            parent = (i - 1) >> 1
            if self.prio[parent] <= self.prio[i]:
                break
            self._swap(i, parent)
            i = parent

    def pop(self) -> tuple[float, int] | None:
        if not self.vals:
            return None
        priority = self.prio[0]
        value = self.vals[0]
        last_prio = self.prio.pop()
        last_val = self.vals.pop()
        if self.vals:
            self.prio[0] = last_prio
            self.vals[0] = last_val
            i = 0
            while True:
                l = 2 * i + 1
                r = l + 1
                smallest = i
                if l < len(self.prio) and self.prio[l] < self.prio[smallest]:
                    smallest = l
                if r < len(self.prio) and self.prio[r] < self.prio[smallest]:
                    smallest = r
                if smallest == i:
                    break
                self._swap(i, smallest)
                i = smallest
        return priority, value

    def _swap(self, a: int, b: int) -> None:
        self.prio[a], self.prio[b] = self.prio[b], self.prio[a]
        self.vals[a], self.vals[b] = self.vals[b], self.vals[a]


def _effective_area(
    line: list[GridPoint],
    i: int,
    prev: list[int],
    next_: list[int],
) -> float:
    p = prev[i]
    q = next_[i]
    if p < 0 or q < 0:
        return math.inf
    a = line[p]
    b = line[i]
    c = line[q]
    return abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y))


def simplify_line(line: list[GridPoint], tolerance: float) -> list[GridPoint]:
    """Simplify a line: repeatedly drop the vertex that collapses the least
    area, until every remaining vertex collapses by more than the tolerance.

    Iterative with an explicit heap rather than recursive: real map data hands
    us 50,000-vertex lines, and a recursive version overflows the stack.
    """
    n = len(line)
    if tolerance <= 0 or n <= 2:
        return line

    # Effective (not squared) area threshold, derived from the tolerance.
    tol_area = tolerance * tolerance

    # Doubly-linked list over the live vertices.
    prev = list(range(-1, n - 1))
    next_ = list(range(1, n)) + [-1]

    # A binary min-heap over (effectiveArea, index). Lazy deletion: entries for
    # already-removed vertices are skipped when popped.
    area = [0.0] * n
    for i in range(1, n - 1):
        area[i] = _effective_area(line, i, prev, next_)
    heap = _MinHeap()
    for i in range(1, n - 1):
        heap.push(area[i], i)

    alive = [True] * n

    while heap.size > 0:
        popped = heap.pop()
        assert popped is not None
        priority, i = popped
        # Skip stale entries: the vertex may already be gone, or its area may
        # have changed since it was pushed.
        if not alive[i]:
            continue
        if area[i] > tol_area:
            break
        if priority != area[i]:
            continue

        alive[i] = False
        p = prev[i]
        q = next_[i]

        if p >= 0:
            next_[p] = q
        if q >= 0:
            prev[q] = p

        # The neighbours' collapse areas just changed, so re-push them.
        if 0 < p < n - 1:
            area[p] = _effective_area(line, p, prev, next_)
            heap.push(area[p], p)
        if 0 < q < n - 1:
            area[q] = _effective_area(line, q, prev, next_)
            heap.push(area[q], q)

    out: list[GridPoint] = []
    for i in range(n):
        if alive[i]:
            out.append(line[i])
    return out if len(out) >= 2 else line


def dedupe_line(line: list[GridPoint], closed: bool = False) -> list[GridPoint]:
    """Drop consecutive duplicates, which simplify can create."""
    out: list[GridPoint] = []
    for p in line:
        if out:
            last = out[-1]
            if last.x == p.x and last.y == p.y:
                continue
        out.append(p)
    if closed and len(out) > 1 and out[0].x == out[-1].x and out[0].y == out[-1].y:
        out.pop()
    return out


# ---------------------------------------------------------------------------
# Vertex welding
# ---------------------------------------------------------------------------


def weld_key(p: GridPoint, quantum: float) -> str:
    """Quantize a point to a welding grid.

    Roads that share an intersection arrive with coordinates a fraction of a
    grid unit apart; welding snaps them together so the topology compiler can
    find the junction instead of missing it.
    """
    return f"{js_round(p.x / quantum)},{js_round(p.y / quantum)}"


def cluster_key(p: GridPoint, quantum: float) -> str:
    return weld_key(p, quantum)


# ---------------------------------------------------------------------------
# Cardinal direction
# ---------------------------------------------------------------------------


def bearing(a: GridPoint, b: GridPoint) -> float:
    """Compass bearing in degrees, 0 = north, clockwise.

    Note the grid y axis points south (it follows the screen/tile convention),
    so the sign is flipped relative to the usual math convention.
    """
    dx = b.x - a.x
    dy = -(b.y - a.y)
    deg = math.atan2(dx, dy) * 180 / math.pi
    return (deg + 360) % 360


def compass_of(a: GridPoint, b: GridPoint) -> Compass:
    """Reduce a bearing to one of eight compass words.

    Eight, not sixteen: "north" costs one token, "north by east" costs five,
    and the difference does not change a routing decision.
    """
    deg = bearing(a, b)
    idx = js_round(deg / 45) % 8
    return _COMPASS[idx]


def opposite_compass(c: Compass) -> Compass:
    """The compass word 180 degrees opposite."""
    return {
        "north": "south",
        "northeast": "southwest",
        "east": "west",
        "southeast": "northwest",
        "south": "north",
        "southwest": "northeast",
        "west": "east",
        "northwest": "southeast",
    }[c]


def turn_from(inbound: Compass, outbound: Compass) -> str:
    """Turn taken when arriving on ``from->via`` and leaving via ``via->to``."""
    step = 45
    delta = ((_COMPASS.index(outbound) - _COMPASS.index(inbound)) * step + 360) % 360
    if delta == 0:
        return "straight"
    if delta < 180:
        return "right"
    return "left"


# ---------------------------------------------------------------------------
# Zoom heuristics
# ---------------------------------------------------------------------------


def zoom_for_radius(radius_m: float) -> int:
    """Pick a slippy zoom for a radius in metres.

    Coarse deliberately: an agent reasoning about a neighbourhood wants the
    neighbourhood, and extra zoom costs tokens without adding an answer.
    """
    if radius_m <= 100:
        return 18
    if radius_m <= 250:
        return 17
    if radius_m <= 500:
        return 16
    if radius_m <= 1000:
        return 15
    if radius_m <= 2500:
        return 14
    if radius_m <= 5000:
        return 13
    if radius_m <= 25000:
        return 12
    if radius_m <= 100000:
        return 10
    if radius_m <= 500000:
        return 8
    return 6


def tile_of(lat: float, lon: float, z: int) -> dict[str, int]:
    """Tile containing a lon/lat, clamped into range so a pole never yields NaN."""
    from .project import lonlat_to_tile

    n = 2**z
    t = lonlat_to_tile(lon, lat, z)
    return {"z": z, "x": max(0, min(n - 1, t["x"])), "y": max(0, min(n - 1, t["y"]))}

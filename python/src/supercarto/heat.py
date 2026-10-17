"""Agent-shaped heatmaps — port of ``src/source/heat.ts``.

The plan called for heatmaps and the codec was built for them, but nothing
produced them, so the feature was inert. What follows closes that gap with the
only two kinds worth having for an agent acting for a person.

A pretty traffic heatmap is not one of them. An agent does not need to know a
road is red; it needs to know which walk to take, when to leave, and whether
the ground rises. So the layers here are:

- `poi_density` - where the useful places are, which is what a person choosing
  a meeting point or a dinner location is actually asking.
- `elevation` and `slope` - whether a route climbs, which changes whether a
  wheelchair, a pram, a bike, or a person with a heart condition can take it.

Both are derived from data already in the document, so they cost no extra
network call.
"""

from __future__ import annotations

import math
from typing import Any

from .types import HeatCell, HeatLayer


def density_to_heat(
    points: list[dict],
    envelope: Any = None,
    name: str | None = None,
    resolution: int = 16,
    max_cells: int = 24,
    metres_per_unit: float | None = None,
) -> HeatLayer | None:
    """Count named places into a grid and return a sparse heat layer.

    Sparse rather than dense because a model needs the shape of the
    distribution, not 4096 numbers it will never look at. A 16x16 grid over a
    400m radius is 25m cells, which is finer than the block an agent reasons
    about, so the hotspots it reports are ones it can act on.
    """
    if not points:
        return None

    xs = [p["x"] for p in points]
    ys = [p["y"] for p in points]
    extent = _max_of(xs, _max_of(ys, 1))
    res = resolution

    bins: dict[int, int] = {}
    for p in points:
        cx = min(res - 1, max(0, math.floor((p["x"] / extent) * res)))
        cy = min(res - 1, max(0, math.floor((p["y"] / extent) * res)))
        key = cy * res + cx
        bins[key] = bins.get(key, 0) + p["value"]

    # JS Array#sort is stable, and insertion order in the dict mirrors the JS
    # Map's, so ties fall to whichever bin filled first - same on both sides.
    ranked = sorted(bins.items(), key=lambda kv: -kv[1])[:max_cells]
    if not ranked:
        return None

    values = [v for _, v in ranked]
    cells = [HeatCell(x=key % res, y=math.floor(key / res), value=v) for key, v in ranked]

    return HeatLayer(
        id=1,
        name=name or "poi_density",
        resolution=res,
        minValue=min(values),
        maxValue=max(values),
        encoding="sparse",
        cells=cells,
    )


def slope_to_heat(
    elevations: list[float],
    width: int,
    height: int,
    name: str | None = None,
    max_cells: int = 16,
    metres_per_unit: float | None = None,
) -> HeatLayer | None:
    """Slope from an elevation grid, as a percentage grade.

    Grade rather than absolute gradient because a percentage is the number a
    person uses to judge a ramp: 8% is the usual accessibility limit, 5% is
    comfortable. Metres per metre would make an agent do the conversion.
    """
    if width < 2 or height < 2:
        return None

    mpu = metres_per_unit if metres_per_unit is not None else 1
    res = 16
    bins: dict[int, float] = {}

    grade: dict[int, float] = {}
    for y in range(height):
        for x in range(width):
            here = _val(elevations, y * width + x, 0)
            right = _val(elevations, y * width + min(width - 1, x + 1), here)
            down = _val(elevations, min(height - 1, y + 1) * width + x, here)
            run = mpu
            grade[y * width + x] = math.hypot(right - here, down - here) / run
            # Stored unclamped.
            #
            # Clamping here collapsed every cell steeper than 20% to the same
            # value before ranking, so any terrain with a real gradient
            # produced a flat distribution and was then dropped as carrying no
            # signal. The clamp is a presentation limit - "beyond this nothing
            # is walkable" - so it belongs at emit time, after the hottest
            # cells have already been chosen.
            bins[_cell_key(x, y, width, height, res)] = grade[y * width + x]

    if not bins:
        return None

    # Flat terrain has no slope layer.
    #
    # Every cell grades to 0, so there is no distribution to report and every
    # hotspot it could emit reads `v: 0, rel: 0`. That is the whole layer. A
    # real maplet printed `slope: {max: 0, mean: 0}` followed by five identical
    # zero lines - token budget spent asserting nothing.
    #
    # The range is taken over every cell, not just the ones that survive the
    # cap. Judging the top N meant a ridge whose 16 hottest cells happened to
    # tie was reported as having no variation at all, while its flatter cells
    # existed.
    #
    # An absent layer is also the honest signal: no gradient here, so
    # accessibility is not constrained by terrain.
    raw_max = max(bins.values())
    raw_min = min(bins.values())
    if raw_max - raw_min <= 0:
        return None

    ranked = sorted(bins.items(), key=lambda kv: -kv[1])[:max_cells]
    if not ranked:
        return None

    # Clamped only now, after selection.
    MAX_GRADE_PCT = 20
    values = [min(MAX_GRADE_PCT, v * 100) for _, v in ranked]

    return HeatLayer(
        id=1,
        name=name or "slope_pct",
        resolution=res,
        # The declared range is the layer's own range, over every cell and
        # clamped at the same ceiling the emitted values use. Taking it from
        # the emitted top-N instead reported max == min whenever those happened
        # to tie, which collapsed the compiler's `rel` normalisation to a
        # divide-by-nothing.
        minValue=math.floor(min(MAX_GRADE_PCT, raw_min * 100) + 0.5),
        maxValue=math.floor(min(MAX_GRADE_PCT, raw_max * 100) + 0.5),
        encoding="sparse",
        cells=[
            HeatCell(x=key % res, y=math.floor(key / res), value=math.floor(values[i] + 0.5))
            for i, (key, _) in enumerate(ranked)
        ],
    )


def _cell_key(x: int, y: int, w: int, h: int, res: int) -> int:
    cx = min(res - 1, max(0, math.floor((x / max(1, w - 1)) * res)))
    cy = min(res - 1, max(0, math.floor((y / max(1, h - 1)) * res)))
    return cy * res + cx


def _max_of(xs: list[float], fallback: float) -> float:
    m = fallback
    for x in xs:
        m = max(m, x)
    return m


def _val(arr: list[float], idx: int, default: float) -> float:
    if 0 <= idx < len(arr):
        return arr[idx] if arr[idx] is not None else default
    return default


def cell_to_lon_lat(x: float, y: float, extent: int, envelope: Any, projection: str = "webmerc") -> tuple[float, float]:
    """Project a heat cell back to lon/lat so the emitter can place a hotspot."""
    from .project import grid_to_lonlat

    return grid_to_lonlat(x, y, envelope, extent, projection)

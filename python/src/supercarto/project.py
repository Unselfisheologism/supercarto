"""Web Mercator projection and grid conversion — port of ``src/geo/project.ts``."""

from __future__ import annotations

import math

from .types import BboxEnvelope, Envelope, GridPoint, TileEnvelope, js_round

#: Web Mercator clips at ±85.05112878; beyond that the projection diverges.
MERCATOR_MAX_LAT = 85.0511287798066
ORIGIN_SHIFT = 2 * math.pi * 6378137 / 2  # half the Earth's circumference, metres
DEG = math.pi / 180

_METERS_PER_DEG_LAT = 110574.0


def lon_to_merc_x(lon: float) -> float:
    """Web Mercator easting in metres for a longitude."""
    return lon * ORIGIN_SHIFT / 180


def lat_to_merc_y(lat: float) -> float:
    """Web Mercator northing in metres for a latitude, clamped to the valid range."""
    clamped = max(-MERCATOR_MAX_LAT, min(MERCATOR_MAX_LAT, lat))
    return math.log(math.tan(math.pi / 4 + (clamped * DEG) / 2)) * 6378137


def merc_x_to_lon(x: float) -> float:
    return (x / ORIGIN_SHIFT) * 180


def merc_y_to_lat(y: float) -> float:
    return (2 * math.atan(math.exp(y / 6378137)) - math.pi / 2) / DEG


# ---------------------------------------------------------------------------
# Tile envelopes
# ---------------------------------------------------------------------------


def tile_bounds(z: int, x: int, y: int) -> dict[str, float]:
    """Geographic bounds of a slippy tile at zoom ``z``."""
    n = 2**z
    west = (x / n) * 360 - 180
    east = ((x + 1) / n) * 360 - 180
    north = merc_y_to_lat(lat_to_merc_y(90) - (lat_to_merc_y(90) * 2 * y) / n)
    south = merc_y_to_lat(lat_to_merc_y(90) - (lat_to_merc_y(90) * 2 * (y + 1)) / n)
    return {"west": west, "south": south, "east": east, "north": north}


def lonlat_to_tile(lon: float, lat: float, z: int) -> dict[str, int]:
    """Slippy tile containing a point at zoom ``z``."""
    n = 2**z
    x = math.floor(((lon + 180) / 360) * n)
    clamped = max(-MERCATOR_MAX_LAT, min(MERCATOR_MAX_LAT, lat))
    lat_rad = clamped * DEG
    y = math.floor(((1 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2) * n)
    return {"x": x, "y": y}


def bbox_to_tile(west: float, south: float, east: float, north: float, max_tiles: int = 1) -> dict[str, int]:
    """The tile that contains a bbox, at a zoom high enough to cover it.

    Picks the coarsest zoom whose tile count does not exceed ``max_tiles``,
    which keeps a request for a city from fanning out into thousands of tiles.
    """
    target = max(1, max_tiles)
    for z in range(22, -1, -1):
        a = lonlat_to_tile(west, north, z)
        b = lonlat_to_tile(east, south, z)
        w = abs(b["x"] - a["x"]) + 1
        h = abs(b["y"] - a["y"]) + 1
        if w * h <= target:
            return {"z": z, "x": a["x"], "y": a["y"]}
    return {"z": 0, "x": 0, "y": 0}


# ---------------------------------------------------------------------------
# Grid <-> lon/lat
# ---------------------------------------------------------------------------


def merc_envelope(
    env: Envelope | dict,
    projection: str = "webmerc",
) -> dict[str, float]:
    """Bounds of a grid-quantized envelope in mercator metres.

    ``top_y`` is always greater than ``bottom_y``, because mercator northing
    increases northward. Note the grid's own y axis points *south*, so
    interpolation runs from ``top_y`` down to ``bottom_y`` as grid y increases.
    Getting this pairing backwards silently produces negative scales.

    Callers hand over either the :class:`TileEnvelope`/:class:`BboxEnvelope`
    dataclasses or plain dicts shaped like the TypeScript structural types
    (``{type: 'tile', z, x, y}`` / ``{type: 'bbox', west, south, east, north}``),
    which arrive as dicts straight from a parsed request.
    """
    if isinstance(env, dict):
        if env.get("type") == "tile":
            env = TileEnvelope(int(env["z"]), int(env["x"]), int(env["y"]))
        else:
            env = BboxEnvelope(env["west"], env["south"], env["east"], env["north"])
    if isinstance(env, TileEnvelope):
        b = tile_bounds(env.z, env.x, env.y)
        return {
            "minX": lon_to_merc_x(b["west"]),
            "maxX": lon_to_merc_x(b["east"]),
            "topY": lat_to_merc_y(b["north"]),
            "bottomY": lat_to_merc_y(b["south"]),
        }
    assert isinstance(env, BboxEnvelope)
    return {
        "minX": lon_to_merc_x(env.west),
        "maxX": lon_to_merc_x(env.east),
        "topY": lat_to_merc_y(env.north),
        "bottomY": lat_to_merc_y(env.south),
    }


def grid_to_lonlat(
    x: float,
    y: float,
    env: Envelope,
    extent: int,
    projection: str = "webmerc",
) -> tuple[float, float]:
    """Convert a grid coordinate to lon/lat as ``(lat, lon)``.

    Longitude interpolates linearly; latitude interpolates in Mercator space,
    not in degrees. Linear-in-degrees latitude is the classic slippy-map bug
    and shows up as a consistent north-south bias that grows with tile height.
    """
    e = merc_envelope(env, projection)
    fx = x / extent
    # Grid y increases southward, so the fraction runs from topY down to bottomY.
    fy = y / extent
    merc_x = e["minX"] + fx * (e["maxX"] - e["minX"])
    merc_y = e["topY"] + fy * (e["bottomY"] - e["topY"])
    return merc_y_to_lat(merc_y), merc_x_to_lon(merc_x)


def lonlat_to_grid(
    lat: float,
    lon: float,
    env: Envelope,
    extent: int,
    projection: str = "webmerc",
) -> GridPoint:
    """Convert lon/lat to a grid coordinate, rounding to integers."""
    e = merc_envelope(env, projection)
    fx = (lon_to_merc_x(lon) - e["minX"]) / (e["maxX"] - e["minX"])
    fy = (lat_to_merc_y(lat) - e["topY"]) / (e["bottomY"] - e["topY"])
    return GridPoint(js_round(fx * extent), js_round(fy * extent))


def meters_per_grid_unit(env: Envelope, extent: int, at_lat: float | None = None) -> float:
    """Metres per grid unit at a given latitude, for the mercator scale distortion."""
    e = merc_envelope(env, "webmerc")
    return abs(e["bottomY"] - e["topY"]) / extent


# ---------------------------------------------------------------------------
# Local planar helpers
# ---------------------------------------------------------------------------


def meters_per_deg_lon(lat: float) -> float:
    """Metres per degree of longitude at a latitude.

    Used for edge distances, which is where a planar approximation is accurate
    enough to be useful and cheap.
    """
    return 111320 * math.cos(lat * DEG)


METERS_PER_DEG_LAT = _METERS_PER_DEG_LAT


def haversine(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    """Great-circle distance in metres."""
    d_lat = (b_lat - a_lat) * DEG
    d_lon = (b_lon - a_lon) * DEG
    s = (
        math.sin(d_lat / 2) ** 2
        + math.cos(a_lat * DEG) * math.cos(b_lat * DEG) * math.sin(d_lon / 2) ** 2
    )
    return 2 * 6371008.8 * math.asin(min(1, math.sqrt(s)))


def grid_distance(
    a: GridPoint,
    b: GridPoint,
    env: Envelope,
    extent: int,
    at_lat: float | None = None,
) -> float:
    """Planar distance between two grid points, scaled to metres at a reference latitude."""
    e = merc_envelope(env, "webmerc")
    width_m = e["maxX"] - e["minX"]
    height_m = abs(e["bottomY"] - e["topY"])
    dx = ((b.x - a.x) / extent) * width_m
    dy = ((b.y - a.y) / extent) * height_m
    return math.hypot(dx, dy)


def deg_to_rad(d: float) -> float:
    return d * DEG


def rad_to_deg(r: float) -> float:
    return r / DEG

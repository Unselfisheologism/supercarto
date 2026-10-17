"""OpenStreetMap via Overpass — port of ``src/source/overpass.ts``.

This is the adapter that makes "any location on earth" literally true: it takes
arbitrary coordinates, needs no tile archive or API key, and covers the whole
planet. The cost is that it queries a shared public service, which is
rate-limited and not meant for heavy traffic.

All HTTP goes through :mod:`supercarto.net` (``urllib``, zero dependencies). A
``fetch`` callable can be injected for tests — the parity harness drives this
source from recorded responses, so the live path is verified byte-for-byte
against the TypeScript without a network.
"""

from __future__ import annotations

import json
import math
import re
import time
from collections.abc import Callable
from typing import Any

# ---------------------------------------------------------------------------
# Errors and helpers
# ---------------------------------------------------------------------------

DEFAULT_ENDPOINT = "https://overpass-api.de/api/interpreter"

#: Generous, because the public instance is slow for way-heavy queries: a
#: single ``way[highway]`` over a few city blocks regularly takes 20-40s there,
#: while a self-hosted instance answers in under a second. Set this lower when
#: you control the server.
DEFAULT_TIMEOUT_S = 60.0

DEFAULT_MAX_FEATURES = 50_000
DEFAULT_MAX_ATTEMPTS = 4

#: Required by the public instance; matches the TypeScript agent string.
DEFAULT_USER_AGENT = "supercarto/0.2.0 (LLM spatial middleware; +https://github.com/supercarto)"


def summarize_error(text: str) -> str:
    """Pull the useful sentence out of an Overpass HTML error page.

    These pages open with an OpenStreetMap attribution paragraph before they
    state what actually went wrong, so taking the first ``<p>`` yields
    "The data included in this document is from www.openstreetmap.org" as the
    explanation for a timeout — technically the page's text, but useless. The
    real diagnosis follows the ``Error:`` marker.
    """
    m = re.search(r"<strong[^>]*>Error</strong>\s*:?\s*([^<]*)", text, re.IGNORECASE)
    if m and m.group(1):
        return re.sub(r"\s+", " ", m.group(1)).strip()[:200]
    paragraphs = [mm.group(1).strip() for mm in re.finditer(r"<p>([^<]+)</p>", text)]
    # Attribution/licence boilerplate is never the explanation.
    useful = [p for p in paragraphs if not re.search(r"openstreetmap\.org|ODbL|available under", p)]
    if useful:
        return re.sub(r"\s+", " ", useful[-1])[:200]
    stripped = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text)).strip()
    return stripped[:160] or "no detail"


#: Semantic layers, in descending priority.
#:
#: Order matters three times: what a caller gets first, what survives when the
#: server refuses a query, and - because the retry drops from the *end* - which
#: layers are the first sacrificed. ``highway`` leads so that streets are the
#: last thing to go: losing them leaves an agent with names it cannot navigate
#: between.
DEFAULT_LAYERS = [
    "highway",
    "building",
    "amenity",
    "railway",
    "shop",
    "tourism",
    "office",
    "leisure",
    "natural",
    "waterway",
]

#: Highway subtypes worth requesting.
#:
#: ``traffic_signals``, ``crossing``, ``street_lamp`` and friends are nodes with
#: a ``highway`` tag. There are thousands of them in a city block, they are not
#: places, and each one becomes a junction in the graph - an agent gets a
#: hundred anonymous nodes representing signal posts instead of the streets
#: between two cafes. Only ways and genuinely navigable nodes are requested.
HIGHWAY_TAGS = [
    "motorway", "trunk", "primary", "secondary", "tertiary", "residential",
    "unclassified", "living_street", "pedestrian", "service", "motorway_link",
    "trunk_link", "primary_link", "secondary_link", "tertiary_link",
]

#: Way subtypes excluded from requests.
#:
#: Footways, paths and steps are enormous in count and change little about where
#: anyone actually walks; they are also what makes an unfiltered way query time
#: out on the public Overpass instance.
EXCLUDED_HIGHWAYS = "footway|path|steps|cycleway|track|bridleway|corridor"

LAYER_TAGS = {
    "highway": "highway",
    "railway": "railway",
    "amenity": "amenity",
    "shop": "shop",
    "tourism": "tourism",
    "office": "office",
    "leisure": "leisure",
    "natural": "natural",
    "waterway": "waterway",
    "building": "building",
}

#: Documented names mapped to OSM tags.
#:
#: The MCP schema, the CLI help and the maplet YAML all speak ``road`` and
#: ``poi``, but OSM has neither tag. Without this map, ``layers:
#: ["road","poi"]`` fell through to ``node[road]`` - a query matching nothing on
#: the planet - and a documented call returned nothing, silently. ``poi``
#: expands to the point-source tags; ``road`` rides the highway subtype
#: machinery below.
LAYER_ALIASES = {
    "road": ["highway"],
    "poi": ["amenity", "shop", "tourism"],
}


def normalize_layers(user: list[str]) -> list[str]:
    """Validate, expand and order a caller-supplied layer list.

    Unknown names raise rather than querying nonsense: an unrecognised layer
    previously produced a valid-looking empty result, which reads as "nothing
    is here". Expansion is sorted into priority order so an explicit
    ``[poi, road]`` still surrenders streets last, and deduped so
    ``[poi, amenity]`` does not query amenity twice.
    """
    known = set(LAYER_TAGS) | set(LAYER_ALIASES)
    unknown = [l for l in user if l not in known]
    if unknown:
        raise ValueError(
            "unknown layer(s) "
            + ", ".join(f'"{u}"' for u in unknown)
            + ". Valid: "
            + ", ".join([*LAYER_ALIASES, *LAYER_TAGS])
        )
    order = {l: i for i, l in enumerate(DEFAULT_LAYERS)}
    expanded: list[str] = []
    for l in user:
        for name in LAYER_ALIASES.get(l, [l]):
            if name not in expanded:  # JS Set de-dup: insertion order preserved
                expanded.append(name)
    return sorted(expanded, key=lambda a: order.get(a, 99))


class OverpassError(Exception):
    """Error carrying the HTTP status, so the retry policy can inspect it."""

    def __init__(self, message: str, status: int):
        super().__init__(message)
        self.status = status


def is_retryable(err: BaseException) -> bool:
    """Whether a failure is worth retrying with a smaller query.

    Timeouts, rate limiting and gateway errors say "this was too much", which a
    smaller query can fix. A parse error says "this was wrong", which it
    cannot, so retrying would just repeat the mistake.
    """
    return isinstance(err, OverpassError) and err.status in (429, 504, 502, 503)


#: How many extra attempts an empty-but-successful response is allowed.
#:
#: Kept small and independent of the general retry budget: an empty result over
#: open ocean or polar ice is a legitimate answer, and every retry spent probing
#: it is a request taken from a shared public server on someone else's behalf.
EMPTY_RETRY_BUDGET = 2

#: How many times a request may be retried over a smaller box.
#:
#: The public instance corrupts way geometry rather than refusing a large
#: query, so the only way to get a usable answer is to ask for less. Shrinking
#: is bounded because a request that keeps halving eventually covers an area too
#: small to be worth returning.
MAX_SHRINK_ATTEMPTS = 4

#: Element cap applied server-side.
#:
#: This is not just a politeness limit. The public instance degrades badly above
#: it: a 500m San Francisco box answered with 4,555 ways whose coordinates were
#: all corrupt - every street came back at latitude 37.2 instead of 37.77 - and
#: the response carried no error and no indication that anything was wrong. A
#: smaller box answered correctly and immediately. The cap is what keeps a
#: request on the side of that cliff, so it is a correctness limit, not a tuning
#: knob.
SERVER_SIDE_CAP = 5_000


def sample_outside(features: list[dict]) -> str:
    """A short sample of coordinates that fell outside the requested area.

    Included in the error message because the exact shape of the corruption is
    the useful diagnostic: a transposed latitude reads very differently from a
    sign flip, and both from data from the wrong region entirely.
    """
    parts = []
    for f in features[:3]:
        geom = f.get("geometry")
        if geom:
            coords = all_coordinates(geom)
            if coords:
                parts.append(f"lon={coords[0][0]} lat={coords[0][1]}")
    return ", ".join(parts)


def count_ways(features: list[dict]) -> int:
    """Features that carry street-like geometry, as opposed to points."""
    return sum(1 for f in features if (f.get("geometry") or {}).get("type") == "LineString")


def tighten(bbox: dict[str, float]) -> dict[str, float] | None:
    """A smaller box centred on the same point.

    Shrinks each axis by 40% so the area falls to about 16% - enough to get
    under the result-size cliff without collapsing to nothing. Returns None
    once the box is too small to be worth querying.
    """
    west, south, east, north = bbox["west"], bbox["south"], bbox["east"], bbox["north"]
    cx = (west + east) / 2
    cy = (south + north) / 2
    half_w = ((east - west) / 2) * 0.6
    half_h = ((north - south) / 2) * 0.6
    # Roughly 100m: below this there is nothing left worth mapping.
    if half_h < 0.00045 or half_w < 0.0006:
        return None
    return {
        "west": cx - half_w,
        "south": cy - half_h,
        "east": cx + half_w,
        "north": cy + half_h,
    }


def is_populated_land(bbox: dict[str, float]) -> bool:
    """Whether a box is far enough from any plausible landmass to be genuinely
    empty.

    Used only to decide whether an empty result deserves an error or a retry.
    The test is deliberately conservative - polar ice and the deep Southern
    Ocean are the only places OSM is reliably empty - because guessing wrong in
    the other direction is what turned a healthy San Francisco into an "empty
    map".

    An earlier version tried to detect mid-ocean boxes by longitude, which
    classified coastal cities like San Francisco as ocean. Anything subtler
    than "obviously empty" is not attempted: an occasional retry over open
    water costs one request, whereas a false negative silently deletes a real
    city.
    """
    mid_lat = (bbox["south"] + bbox["north"]) / 2
    if abs(mid_lat) >= 66:  # Arctic/Antarctic circles
        return False
    # The Southern Ocean and the Antarctic interior are genuinely empty. The
    # southern limit is generous because the 60th parallel is open water for
    # most of its length and OSM coverage there is sparse.
    return not mid_lat < -55


def build_query(req: dict) -> str:
    """Overpass QL selecting what an agent actually needs for navigation.

    Two details are load-bearing, and both were found by running against the
    real public instance rather than by reading the docs:

    1. The bbox filter goes *inside* the parentheses in positional form:
       ``node(s,w,n,e)[tag]``. The ``bbox:`` prefixed form parses on the
       public instance for northern boxes but is rejected for negative
       latitudes with a 400 ``bbox-query: n must be >= s`` (measured against
       overpass-api.de on 2026-10-17), which made every live fetch in the
       southern hemisphere fail while northern cities worked.
    2. Unfiltered ``way`` queries time out on the shared public instance - the
       server's read dispatcher gives up well before it has scanned every
       footway and path in a city block. Excluding the micro-pathways and
       capping the result count is what makes the query answerable there, and
       it also drops the least useful features for an agent: a kerb-level
       footway does not change where anyone walks.
    """
    s, w, n, e = req["bbox"]["south"], req["bbox"]["west"], req["bbox"]["north"], req["bbox"]["east"]
    area = f"({s},{w},{n},{e})"

    parts: list[str] = []

    for layer in req["layers"]:
        tag = LAYER_TAGS.get(layer) or layer

        if tag == "highway":
            # Requested explicitly by subtype. A bare `[highway]` match returns
            # every crossing and traffic signal in the area, which is noise in
            # a graph and is the single biggest contributor to an unusable
            # response.
            parts.append("\n".join(f"    way{area}[highway={t}];" for t in HIGHWAY_TAGS))
            parts.append(f"    node{area}[highway=bus_stop];")
            continue

        # `natural=water` and `natural=wood` as separate statements: a bare
        # `[natural]` match also returns `natural=tree` on every way, which in
        # a city is most of them.
        if tag == "natural":
            parts.append(f"    way{area}[natural=water];")
            parts.append(f"    way{area}[natural=wood];")
            parts.append(f"    way{area}[natural=scrub];")
            continue

        # Buildings as ways only: building nodes carry no geometry.
        if tag == "building":
            parts.append(f'    way{area}[building][building!="no"];')
            continue

        if tag == "railway":
            # Only the two things an agent navigates by or waits at. A bare
            # `[railway]` match returns every level_crossing and tram_crossing
            # node on the tramway, which floods the graph with anonymous nodes
            # and starves the landmarks of budget.
            parts.append(f"    node{area}[railway=tram_stop];")
            parts.append(f"    node{area}[railway=subway_entrance];")
            parts.append(f"    node{area}[railway=station];")
            parts.append(f"    node{area}[railway=halt];")
            continue

        parts.append(f"    node{area}[{tag}];")
        # Ways carry parks, shops in complexes, and railways; exclude the
        # micro-pathways that dominate way counts.
        parts.append(f'    way{area}[{tag}][highway!~"^({EXCLUDED_HIGHWAYS})$"];')

    cap = min(req.get("maxFeatures") or SERVER_SIDE_CAP, SERVER_SIDE_CAP)

    # `out geom`, not `out body`: `body` returns ways as a bare list of vertex
    # ids with no coordinates, and since the query selects ways directly -
    # never their constituent nodes - those ids cannot be resolved from the
    # response. Every road therefore came back with an empty coordinate list
    # and was discarded, which is why a San Francisco maplet reported 180
    # places and zero streets. `geom` inlines each way's vertex coordinates,
    # so ways stand alone.
    return (
        "[out:json][timeout:25];\n(\n" + "\n".join(parts) + "\n);\nout geom qt " + str(cap) + ";"
    )


def clip_geometry(f: dict, keep: list[tuple[float, float]]) -> dict:
    """Rebuild a line or polygon from only the vertices that are in range.

    A line whose surviving vertices are non-contiguous is split at the gap
    rather than joined across it, because bridging a corrupt run with a
    straight jump would invent a road that does not exist. Polygons whose
    surviving vertices no longer close are dropped by the caller's type check,
    since a clipped ring is not a valid area and a fake one is worse than none.
    """
    g = f.get("geometry")
    if not g:
        return f
    if g.get("type") == "LineString":
        return {**f, "geometry": {"type": "LineString", "coordinates": [list(c) for c in keep]}}
    if g.get("type") == "MultiLineString":
        # Keep the longest surviving run rather than flattening separate roads
        # into one, which would create edges between places with no connection.
        # Each run maps to its kept vertices; only mapped runs count.
        runs = [
            _in_keep(line, keep)
            for line in (g.get("coordinates") or [])
            if isinstance(line, list)
        ]
        runs = [r for r in runs if len(r) >= 2]
        runs.sort(key=lambda r: -len(r))
        if not runs:
            return {**f, "geometry": {"type": "LineString", "coordinates": []}}
        return {**f, "geometry": {"type": "LineString", "coordinates": runs[0]}}
    if g.get("type") == "Polygon":
        rings = g.get("coordinates") or []
        ring0 = rings[0] if rings else []
        ring = _in_keep(ring0, keep)
        first = ring[0] if ring else None
        last = ring[-1] if ring else None
        closed = bool(first) and bool(last) and first[0] == last[0] and first[1] == last[1]
        return {
            **f,
            "geometry": {
                "type": "Polygon",
                # An unclosed ring is no longer the same shape; an empty ring
                # is rejected downstream rather than reported as a real area.
                "coordinates": [ring] if closed and len(ring) >= 4 else [],
            },
        }
    return f


def _in_keep(line: list, keep: list) -> list:
    """Filter ``line`` to vertices whose coordinates are on ``keep``.

    Matching is by value: ``keep`` holds the copies :func:`all_coordinates`
    built, while ``line`` holds the coordinate arrays referenced by the
    feature's geometry, so a comparison of object identity would match nothing
    and silently empty every polygon. (The reference matched by identity until
    milestone 3 fixed both sides together.)
    """
    return [c for c in line if any(k[0] == c[0] and k[1] == c[1] for k in keep)]


def node_to_feature(el: dict) -> dict:
    """Convert an Overpass node element to GeoJSON.

    Overpass returns three element shapes - node, way, relation - and only
    nodes carry top-level coordinates. Ways carry theirs inline under
    ``geometry`` when the query uses ``out geom``, which is what the built
    query requests; the ``coordsById`` lookup remains as a fallback for
    ``out body`` responses.
    """
    return {
        "type": "Feature",
        "id": el["id"],
        "properties": dict(el.get("tags") or {}),
        "geometry": {"type": "Point", "coordinates": [el["lon"], el["lat"]]},
    }


def all_coordinates(geom: dict) -> list[tuple[float, float]]:
    """Every coordinate pair in any geometry."""
    out: list[tuple[float, float]] = []

    def walk(node: Any) -> None:
        if not isinstance(node, list):
            if isinstance(node, tuple):
                node = list(node)
            else:
                return
        if len(node) >= 2 and isinstance(node[0], (int, float)) and isinstance(node[1], (int, float)):
            out.append((node[0], node[1]))
            return
        for child in node:
            walk(child)

    walk(geom.get("coordinates"))
    return out


#: Tags that make a closed way an area rather than a ring-shaped line.
AREA_KEYS = ["building", "landuse", "natural", "leisure", "amenity", "shop", "tourism", "place", "waterway"]


def is_area_tag(tags: dict[str, str]) -> bool:
    for k in AREA_KEYS:
        v = tags.get(k)
        if v is None:
            continue
        # A closed waterway is a river loop, not a lake; a bare `natural=yes`
        # on a highway ring is not an area either.
        if k == "waterway" and v != "riverbank" and v != "dock":
            return False
        return k != "highway"
    return False


def way_to_feature(el: dict, coords: list[tuple[float, float]]) -> dict | None:
    if len(coords) < 2:
        return None
    coords = [list(c) for c in coords]  # GeoJSON coordinates are JSON arrays
    tags = el.get("tags") or {}
    is_area = len(coords) >= 3 and _is_closed(coords) and is_area_tag(tags)
    return {
        "type": "Feature",
        "id": el["id"],
        "properties": dict(tags),
        "geometry": (
            {"type": "Polygon", "coordinates": [coords]}
            if is_area
            else {"type": "LineString", "coordinates": coords}
        ),
    }


def _is_closed(coords: list[tuple[float, float]]) -> bool:
    """A ring is closed when its first and last vertices match."""
    a, b = coords[0], coords[-1]
    return a[0] == b[0] and a[1] == b[1]


def bbox_around(lat: float, lon: float, radius_m: float) -> dict[str, float]:
    """Bounding box of a circle, used to turn a radius query into a bbox query.

    Longitude degrees shrink with latitude; latitude degrees do not. Getting
    this wrong produces a box that is far too narrow east-west at high
    latitudes, which silently drops everything outside a thin strip.
    """
    # Longitude degrees shrink with latitude; latitude degrees do not.
    d_lat = radius_m / 110574
    d_lon = radius_m / (111320 * math.cos(lat * math.pi / 180))
    return {
        "west": lon - d_lon,
        "south": lat - d_lat,
        "east": lon + d_lon,
        "north": lat + d_lat,
    }


def normalize_bbox(b: dict[str, float]) -> dict[str, float]:
    """Clamp a bbox to valid WGS84, and handle the antimeridian."""
    west = max(-180.0, min(180.0, b["west"]))
    east = max(-180.0, min(180.0, b["east"]))
    return {
        "west": min(west, east),
        "south": max(-85.05112878, min(85.05112878, b["south"])),
        "east": max(west, east),
        "north": max(-85.05112878, min(85.05112878, b["north"])),
    }


def bbox_area_sqm(b: dict[str, float]) -> float:
    """Approximate ground area of a bbox in square metres."""
    mid_lat = (b["north"] + b["south"]) / 2
    width_m = (b["east"] - b["west"]) * 111320 * math.cos(mid_lat * math.pi / 180)
    height_m = (b["north"] - b["south"]) * 110574
    return abs(width_m * height_m)


# ---------------------------------------------------------------------------
# The source
# ---------------------------------------------------------------------------


class OverpassSource:
    """OpenStreetMap via the Overpass API. Any coordinates, no API key."""

    name = "osm-overpass"
    description = "OpenStreetMap via the Overpass API. Any coordinates, no API key."

    def __init__(
        self,
        endpoint: str | None = None,
        timeout_s: float | None = None,
        fetch: Callable | None = None,
        max_features: int | None = None,
        user_agent: str | None = None,
        max_attempts: int | None = None,
    ):
        self.endpoint = endpoint or DEFAULT_ENDPOINT
        self.timeout_s = DEFAULT_TIMEOUT_S if timeout_s is None else timeout_s
        self.fetch_impl = fetch  # resolved lazily so imports stay cheap
        self.max_features = max_features or DEFAULT_MAX_FEATURES
        self.user_agent = user_agent or DEFAULT_USER_AGENT
        self.max_attempts = max(1, max_attempts if max_attempts is not None else DEFAULT_MAX_ATTEMPTS)
        #: The area currently being fetched, used to reject implausible coords.
        self.bbox: dict[str, float] | None = None

    def _fetch(self, url: str, **kw):
        if self.fetch_impl is not None:
            return self.fetch_impl(url, **kw)
        from .net import http_fetch

        return http_fetch(url, **kw)

    def available(self) -> bool:
        return self.fetch_impl is not None or True  # urllib is always available

    def fetch(self, req: dict) -> dict:
        started = time.time() * 1000
        warnings: list[str] = []
        limit = min(req.get("maxFeatures") or self.max_features, self.max_features)
        self.bbox = req["bbox"]

        # The public instance is a shared, rate-limited resource, and a query
        # that asks for every building in a dense city will time out on it.
        # Layers are therefore dropped in priority order when the server
        # refuses, so a caller gets a partial map instead of an exception.
        # Roads and POIs survive longest: they are what an agent actually
        # navigates by.
        layers = normalize_layers(req["layers"]) if len(req["layers"]) > 0 else list(DEFAULT_LAYERS)
        attempts = self.max_attempts
        # The box actually queried. Retrying may shrink it, and both the query
        # text and the coordinate filter have to follow, or a shrunken request
        # is still asked about the original area.
        box = dict(req["bbox"])
        # The best answer seen so far across attempts.
        #
        # Retries exist because the shared instance degrades unpredictably, so
        # a later attempt can easily be worse than an earlier one. Without
        # this, a request that got a perfectly good map on attempt 1 and then
        # hit a busy server would throw away the map and report "exhausted
        # retries" - losing usable data to be strict about a condition that was
        # already satisfied.
        best: dict | None = None
        last_error: BaseException | None = None
        # How many attempts ended in refusal (HTTP error/timeout) rather than a
        # response. Load-bearing below: it distinguishes a degraded server from
        # a genuinely roadless area.
        refusals = 0
        # Whether any attempt ever delivered way elements. A response that
        # never contained ways while the server proved flaky is unwitnessed
        # absence.
        saw_ways = False

        def starved_error() -> OverpassError:
            return OverpassError(
                "Overpass served no road geometry after refusing "
                f"{refusals} attempt(s); the instance is degraded, not the area empty - "
                "retry, shrink the request, or set OVERPASS_ENDPOINT to a self-hosted mirror",
                502,
            )

        for attempt in range(attempts):
            # Each retry drops the lowest-priority layers, so the surviving
            # query gets simpler until the server accepts one. Roadways and
            # their junctions lead the list precisely so that streets are the
            # last thing surrendered.
            kept = layers[: max(1, len(layers) - attempt)]
            query = build_query({**req, "bbox": box, "layers": kept})
            self.bbox = box
            try:
                body = self._request(query, req)
                raw = len(body.get("elements") or [])

                # HTTP 200 with no elements is ambiguous: it can mean a
                # genuinely empty area, but the public instance also returns it
                # when a query is too large for it to serve. Treating that as
                # "nothing is here" produced an empty map for the middle of
                # London. So an empty result is retried with fewer layers
                # before it is believed.
                #
                # The retry budget is deliberately separate from `attempts`:
                # every extra attempt against a shared public server costs
                # someone else's quota, and only the empty-result case needs
                # the re-ask.
                retried_empty = attempt < EMPTY_RETRY_BUDGET
                if raw == 0 and len(req["layers"]) == 0 and retried_empty:
                    warnings.append(
                        "Overpass returned an empty result for a populated area; "
                        "retrying with fewer layers rather than reporting no data"
                    )
                    continue

                # Retries exhausted and still nothing. For a dense land area
                # this is a server failure, not a blank map, and saying so
                # beats handing back an empty graph that reads as "there is
                # nothing here".
                if raw == 0 and len(req["layers"]) == 0 and is_populated_land(box):
                    raise OverpassError(
                        f"Overpass returned no data for a populated area after {attempt + 1} attempts; "
                        "the public instance is degraded - set OVERPASS_ENDPOINT to a self-hosted mirror",
                        502,
                    )

                features = self._build_features(body.get("elements") or [], limit, warnings)
                truncated = len(features) >= limit

                # Detect the response-size cliff: the instance answers with way
                # geometry that is entirely out of area rather than with an
                # error. A result with streets requested and none usable is a
                # city with no roads, which is worse than a smaller map that
                # works - so the request is retried over a tighter box.
                #
                # The trigger is specifically "ways arrived but none survived",
                # not "no ways present". A response that genuinely contained no
                # ways has not demonstrated anything is wrong, and re-asking it
                # would spend shared quota to learn the same thing.
                way_elements = sum(1 for el in body.get("elements") or [] if el.get("type") == "way")
                if way_elements > 0:
                    saw_ways = True
                wants_shrink = (
                    len(req["layers"]) == 0
                    and attempt < MAX_SHRINK_ATTEMPTS
                    and is_populated_land(box)
                    and way_elements > 0
                    # A truncated result stopped reading before it reached the
                    # ways, so the absence of streets says nothing about the
                    # upstream response.
                    and not truncated
                    and count_ways(features) == 0
                )

                if truncated:
                    warnings.append(f"truncated at {limit} features; area is denser than the cap")
                if attempt > 0:
                    kept_names = '", "'.join(layers[len(kept):])
                    warnings.append(
                        f"Overpass refused the full query {attempt} time(s); served without "
                        f"layer{'s' if len(kept) != 1 else ''} \"{kept_names}\""
                    )
                result = {
                    "features": features,
                    "source": self.name,
                    "truncated": truncated,
                    "elapsedMs": time.time() * 1000 - started,
                    "warnings": list(warnings),
                }

                # Remember the best answer before deciding to look for a
                # better one, so that exhausting the retries still leaves the
                # caller with a real map.
                if result["features"] and (
                    best is None
                    or (
                        len(result["features"]) > len(best["features"])
                        and count_ways(result["features"]) >= count_ways(best["features"])
                    )
                ):
                    best = result

                # The sibling failure: highways requested, zero way elements
                # arrived at all. Measured against Tokyo: two refused attempts,
                # then a 200 with nodes only - served as success, yielding a
                # POI map with no streets. Same remedy as a shrink (tighter
                # box, complete response), then give up loudly rather than
                # serving roadlessness as success. Gated on prior refusals so a
                # clean first-attempt empty - a plaza, farmland, a genuinely
                # roadless patch - still serves instead of throwing at honest
                # geography.
                starved = (
                    "highway" in kept
                    and way_elements == 0
                    and not truncated
                    and is_populated_land(box)
                    and refusals > 0
                )
                if starved and attempt < MAX_SHRINK_ATTEMPTS:
                    tightened = tighten(box)
                    if tightened:
                        box = tightened
                        warnings.append(
                            "upstream returned no road geometry after refusing earlier "
                            "attempts; retrying over a smaller box to stay under the instance result limit"
                        )
                        continue
                    raise starved_error()
                # Starved past the shrink budget: falling through would serve
                # the misleading map below, so fail here with the same error.
                if starved:
                    raise starved_error()

                if wants_shrink:
                    tightened = tighten(box)
                    if tightened:
                        box = tightened
                        warnings.append(
                            "upstream returned no usable street geometry for this area; "
                            "retrying over a smaller box to stay under the instance result limit"
                        )
                        continue
                return result
            except Exception as err:  # noqa: BLE001 - mirrors the TS catch-all
                last_error = err
                if is_retryable(err):
                    refusals += 1
                if not is_retryable(err) or attempt == attempts - 1:
                    break
                # Back off briefly. The shared instance rate-limits
                # aggressively, and hammering it makes a transient failure
                # permanent.
                time.sleep(min(2.0 * (attempt + 1), 6.0))

        # Every attempt failed. A partial map from an earlier try is still a
        # real map; throwing it away to report a bare retry failure would be a
        # worse outcome for the caller.
        if best:
            # Same starvation, one level up: every attempt that answered
            # carried no ways while the server proved flaky. Serving the best
            # of those would hand back the misleading POI-only map this whole
            # block exists to prevent.
            if (
                "highway" in layers
                and count_ways(best["features"]) == 0
                and not saw_ways
                and refusals > 0
                and is_populated_land(req["bbox"])
            ):
                raise starved_error()
            best["warnings"].append("later attempts failed; serving the best result obtained")
            return best
        if last_error is not None:
            raise last_error
        raise OverpassError("no attempt was made for this request", 502)

    # ------------------------------------------------------------------
    # HTTP
    # ------------------------------------------------------------------

    def _request(self, query: str, req: dict) -> dict:
        """One HTTP round trip, with the headers and error handling Overpass needs."""
        from .net import HttpError, query_params

        try:
            res = self._fetch(
                self.endpoint,
                method="POST",
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    # Required. The public instance sits behind Apache, which
                    # answers 406 to any request without a User-Agent - a
                    # failure that looks like a bad query but is not one. A
                    # descriptive agent string is also the polite thing to
                    # send to a shared public service.
                    "User-Agent": self.user_agent,
                    "Accept": "*/*",
                },
                body=query_params({"data": query}),
                timeout_s=self.timeout_s,
            )
        except HttpError as err:
            raise OverpassError(f"Overpass request timed out after {self.timeout_s * 1000:.0f}ms", 504) from err

        if not res.ok:
            # Overpass reports rate limiting, slot exhaustion and
            # query-too-heavy as an XML error document with a 4xx status.
            # Parsing it as JSON throws an opaque syntax error, so the status
            # and body are surfaced instead.
            detail = summarize_error(res.text)
            raise OverpassError(f"Overpass responded {res.status}: {detail}", res.status)

        try:
            return json.loads(res.text)
        except (json.JSONDecodeError, ValueError):
            raise OverpassError(
                f"Overpass returned non-JSON: {summarize_error(res.text)}", 502
            ) from None

    # ------------------------------------------------------------------
    # Feature assembly
    # ------------------------------------------------------------------

    def _build_features(self, elements: list[dict], limit: int, warnings: list[str]) -> list[dict]:
        coords_by_id: dict[int, tuple[float, float]] = {}
        features: list[dict] = []

        # Nodes first, so ways can be resolved against the map built from them.
        for el in elements:
            if (
                el.get("type") == "node"
                and _is_num(el.get("lat"))
                and _is_num(el.get("lon"))
            ):
                coords_by_id[el["id"]] = (el["lon"], el["lat"])

        for el in elements:
            if len(features) >= limit:
                break
            if el.get("type") == "node" and _is_num(el.get("lat")) and _is_num(el.get("lon")):
                # A tagged node is a POI. An untagged one is usually a way's
                # vertex, not a place of its own, so it is skipped to save
                # tokens.
                if el.get("tags") and len(el["tags"]) > 0:
                    features.append(node_to_feature(el))
                continue
            if el.get("type") == "way":
                # `out geom` inlines each vertex as {lat,lon}; `out body` gives
                # only vertex ids, resolvable only if those nodes were also
                # selected.
                inline = []
                if isinstance(el.get("geometry"), list):
                    for g in el["geometry"]:
                        if _is_num(g.get("lat")) and _is_num(g.get("lon")):
                            inline.append((g["lon"], g["lat"]))
                resolved = []
                if isinstance(el.get("nodes"), list):
                    resolved = [coords_by_id[nid] for nid in el["nodes"] if nid in coords_by_id]
                coords = inline if len(inline) > 0 else resolved
                f = way_to_feature(el, coords)
                if f:
                    features.append(f)
                continue
            if el.get("type") == "relation":
                # Multipolygon relations are common for large lakes and
                # forests. A proper implementation resolves the member ways;
                # here they are recorded as a warning rather than silently
                # dropped, because silently dropping a lake is exactly the kind
                # of omission an agent cannot see.
                tags = el.get("tags") or {}
                if tags.get("natural") == "water" or tags.get("landuse") == "reservoir":
                    warnings.append(
                        f"relation {el['id']} ({tags.get('natural') or tags.get('landuse')}) not resolved"
                    )

        return self._drop_implausible(features, warnings)

    def _drop_implausible(self, features: list[dict], warnings: list[str]) -> list[dict]:
        """Discard features whose coordinates do not match the requested area.

        This is a real failure mode, not a hypothetical: the public Overpass
        instance has been observed returning transposed latitudes for whole
        regions, and `out body` reports them with no indication that anything
        is wrong. Passed through unchecked, those coordinates land thousands of
        kilometres away, and the compiler then reports a 26km edge between two
        cafes that are 8m apart.

        A tolerance is used rather than a strict bound, because the server may
        legitimately return features just outside a bbox when one touches a way
        spanning the boundary. Anything wildly outside is data corruption.
        """
        if self.bbox is None:
            return features
        west, south, east, north = self.bbox["west"], self.bbox["south"], self.bbox["east"], self.bbox["north"]

        # Slack is proportional to the size of the request, not a fixed number
        # of degrees. A fixed slack is either useless on a small area (a
        # 2-degree margin on a 1-degree box admits points from another city) or
        # too tight on a large one.
        #
        # The floor matters more than it looks. It used to be 0.05 degrees,
        # which covers the boundary effects of a way that runs off the edge -
        # but 0.05 degrees of latitude is 5.5km, so for a 350m request it
        # admitted bus stops 1.6km away and the compiler dutifully drew 1.6km
        # "access" edges inside a 350m map. The floor is now small enough to
        # admit a road that leaves the request, and no more.
        slack_lat = max(0.0015, min((north - south) * 0.25, 0.05))
        slack_lon = max(0.0015, min((east - west) * 0.25, 0.05))

        def inside(c: tuple[float, float]) -> bool:
            lon, lat = c
            return (
                south - slack_lat <= lat <= north + slack_lat
                and west - slack_lon <= lon <= east + slack_lon
            )

        ok: list[dict] = []
        for f in features:
            geom = f.get("geometry")
            if not geom:
                continue
            coords = all_coordinates(geom)
            if len(coords) == 0:
                continue

            # Points are judged individually: a stray point is corrupt data.
            if geom.get("type") == "Point":
                if inside(coords[0]):
                    ok.append(f)
                continue

            # Ways and areas are judged by majority, not unanimously.
            #
            # Requiring every vertex to be in range discarded whole streets:
            # the public instance returns a corrupt latitude on a fraction of
            # the vertices in a region, and one bad vertex out of twenty was
            # enough to throw away the road - which is how San Francisco
            # returned 2,320 picnic tables and toilets while every single
            # street was discarded. The corrupted runs produce *no* in-range
            # vertices at all, so a majority rule separates corruption from
            # the ordinary case of a road that merely runs off the edge of the
            # request.
            good = [(lon, lat) for (lon, lat) in coords if inside((lon, lat))]
            if len(good) * 2 <= len(coords):
                continue

            # Keep only the in-range stretch, so a clipped feature does not
            # still carry the corrupt vertex that got it flagged.
            ok.append(clip_geometry(f, good))

        dropped = len(features) - len(ok)
        if dropped > 0:
            warnings.append(
                f"discarded {dropped} feature(s) with coordinates outside the requested area; "
                "the upstream data was inconsistent with the query"
            )

        # Losing some features to bad coordinates is normal. Losing *all* of
        # them means the upstream data is unusable, and returning an empty
        # feature list would report "there is nothing here" for a dense city
        # centre. That is the most damaging possible answer, because the
        # caller cannot distinguish it from a genuine blank.
        if len(features) > 0 and len(ok) == 0:
            raise OverpassError(
                "every feature was outside the requested area; upstream coordinates are corrupt "
                "(sample: " + sample_outside(features) + ")",
                502,
            )
        return ok


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)

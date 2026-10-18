"""The live maplet service — port of ``src/live.ts``.

This is the layer that makes supercarto work for *any location on earth*:
give it coordinates, it fetches real data, compiles it, and returns a
budget-honouring graph. Everything above this is a transform; this is the part
that talks to the outside world.

The Python :class:`SuperCarto` is synchronous: ``urllib`` instead of the event
loop, which keeps the package dependency-free and makes every call
predictable. The orchestration, caching, retry and honesty logic is ported
one-for-one.
"""

from __future__ import annotations

import time
from typing import Any

from .heat import density_to_heat, slope_to_heat
from .ingest import from_geojson
from .overpass import OverpassSource
from .pipeline import to_maplet
from .project import grid_to_lonlat
from .routing import FeasibilityRouter, straight_line_route
from .scale import grid_scale_for
from .session import move_maplet, session_doc, session_envelope_contains
from .traffic import HereFlow, TomTomFlow, TrafficRouter
from .types import Feature, ScrDocument, js_round
from .weather import OpenMeteoWeather
from .wire import encode_document as _encode_wire

#: Samples per axis for the slope grid.
#:
#: Coarser than the elevation grid used by `get_terrain`, because slope is a
#: smooth surface: doubling the resolution would double a network call to
#: sharpen a gradient nobody will query cell by cell.
SLOPE_HEAT_RES = 16

CACHE_TTL_S = 5 * 60.0
CACHE_MAX = 128


class SuperCarto:
    """The live service: coordinates in, token-budgeted topology out.

    Sync by design. Accepts injected sources for tests; the defaults are
    Overpass for data, Open-Meteo for weather, and the feasibility router
    (see ``routing.py``, which OSRM becomes only when passed explicitly).
    """

    def __init__(
        self,
        sources: list | None = None,
        router: Any | None = None,
        elevation: Any | None = None,
        weather: Any | None = None,
        traffic: list | None = None,
        heat: bool = True,
        overpass: dict | None = None,
        openMeteo: dict | None = None,
        tomTom: dict | None = None,
        here: dict | None = None,
        defaultBudget: int = 1024,
    ):
        self.sources = sources or [OverpassSource(**(overpass or {}))]
        # Routing defaults to feasibility, not navigation. A router that
        # answers with confidence but cannot be verified is the worst thing
        # on the palette: measured on the public demo OSRM, a short northward
        # walk in sf-cbd came back physically impossible, and nothing in the
        # response looks wrong. The default route source claims only what it
        # can compute - straight-line distance and direction - and ends in
        # "verify the approach on arrival". Pass a router you have verified
        # yourself to get turn-by-turn.
        self.router = router or FeasibilityRouter()
        self.elevation = elevation
        # Weather defaults on: the source needs no key, so there is no reason
        # to make an operator opt in to something they would otherwise have to
        # add themselves. `False` is the explicit opt-out.
        if weather is False:
            self.weather: Any | None = None
        elif weather is None:
            self.weather = OpenMeteoWeather(**(openMeteo or {}))
        else:
            self.weather = weather
        # Traffic is never defaulted. A provider without a credential can only
        # report free flow, and presenting that as a live ETA is the single
        # most damaging thing this service could do.
        self.traffic = TrafficRouter(
            self.router,
            traffic
            if traffic is not None
            else [TomTomFlow(**(tomTom or {})), HereFlow(**(here or {}))],
        )
        self.derive_heat = heat
        self.default_budget = defaultBudget
        #: Per-area cache of compiled documents, keyed by envelope and layer set.
        self.cache: dict[str, tuple[ScrDocument, float]] = {}

    # ------------------------------------------------------------------
    # The main call
    # ------------------------------------------------------------------

    def maplet(
        self,
        lat: float,
        lon: float,
        radius_m: float | None = None,
        layers: list[str] | None = None,
        budget: int | None = None,
        compile: dict | None = None,
    ) -> dict:
        """Fetch real map data around a point and compile it for an agent.

        This is the "Google Maps for AI agents" call: coordinates in, a
        token-budgeted topological graph out.
        """
        radius_m = radius_m if radius_m is not None else 300
        from .overpass import bbox_around, normalize_bbox

        bbox = normalize_bbox(bbox_around(lat, lon, radius_m))
        budget = budget if budget is not None else self.default_budget

        # The compiler's time input is a datetime; a request hand-carries it
        # as an ISO string (as the JSON tool layer does).
        compile_opts = compile
        if compile_opts and isinstance(compile_opts.get("now"), str):
            from datetime import datetime, timezone

            compile_opts = {
                **compile_opts,
                "now": datetime.fromisoformat(
                    compile_opts["now"].replace("Z", "+00:00")
                ).astimezone(timezone.utc),
            }

        fetched = self.document(bbox, layers or [])

        # Heat layers are derived after fetch, from the data already in hand.
        # The document is the cache key's target, so the derived layers are
        # attached to the returned copy rather than the cached one: two
        # requests for the same area at different zoom or layer settings would
        # otherwise contaminate each other's heat.
        doc = self.with_heat(fetched["doc"], bbox)

        # The derived document is passed through directly rather than
        # converted back to GeoJSON. Heat layers live on the document, not on
        # any feature, so a round trip through features would discard every
        # layer just added - which is what silently reduced this to a
        # topology-only maplet.
        result = to_maplet(
            {"type": "FeatureCollection", "features": []},
            {
                "doc": doc,
                "bbox": bbox,
                "layers": layers,
                "budget": budget,
                "compile": compile_opts,
                "radiusLabel": format_radius(radius_m),
                # So the maplet advertises only the tools this instance can answer.
                "capabilities": self.capabilities,
            },
        )

        # Places without streets are a contradiction, not a result. Measured
        # against Tokyo: 55 named places, zero edges, served with a 200 as if
        # nothing were wrong. An agent cannot navigate between names without
        # a network, so handing it one misleads more than refusing. A fully
        # empty map still serves: open ocean is honestly empty, and there is
        # nothing in it to mislead about. Explicitly POI-only requests pass
        # too: asking for places is honest, getting places is the answer.
        #
        # The signal is the safety net fingerprint, not the node count: the
        # emitter strips orphan names and records them as landmark omissions,
        # so stripped-names-plus-no-edges is exactly the misleading case,
        # while an untouched empty map stays servable.
        explicit = layers is not None and len(layers) > 0
        wants_roads = (not explicit) or any(l in ("road", "highway") for l in layers)
        graph = result["graph"]
        omitted = graph.omitted or []
        stripped = any(o.layer == "landmark" for o in omitted)
        if len(graph.edges) == 0 and stripped and wants_roads:
            dropped = sum(o.count for o in omitted if o.layer == "landmark")
            raise Exception(  # noqa: TRY002 - mirrors the TS bare Error
                f"no walkable network survived for {lat},{lon} "
                f"(radius {radius_m}m): {dropped} named places stripped for lack of streets. "
                "Pass layers: ['poi'] for a POI-only map, or retry - a degraded "
                "upstream fetch is the usual cause."
            )
        return {
            **result,
            "fetchedFrom": fetched["source"],
            "fetchMs": fetched["elapsedMs"],
            "warnings": fetched["warnings"],
            "sourceTruncated": fetched["truncated"],
        }

    # ------------------------------------------------------------------
    # Sessions: the agent moves
    # ------------------------------------------------------------------

    def move_view(
        self,
        scr: str,
        lat: float,
        lon: float,
        radius_m: float | None = None,
        layers: list[str] | None = None,
        budget: int | None = None,
        compile: dict | None = None,
    ) -> dict:
        """One move of a session: the agent's stored SCR in, the +/-/~ delta
        out.

        This is the ``localize`` tool's engine. It fetches the new view's
        features, re-ingests them under the *session's* envelope rather than
        the request box's own, diffs against the agent's map, and returns the
        changed places plus the replaced state.

        Moves outside the session envelope are refused rather than served
        with a lying diff: a foreign grid would mark every untouched place
        dirty.
        """
        from .overpass import bbox_around, normalize_bbox

        prev = session_doc(scr)
        env = prev.envelope
        if env.type != "bbox":
            raise ValueError(
                "a session move needs a bbox session envelope; "
                "open a session with get_maplet first"
            )
        radius_m = radius_m if radius_m is not None else 300
        bbox = normalize_bbox(bbox_around(lat, lon, radius_m))
        if not session_envelope_contains(env, bbox):
            raise ValueError(
                f"the move leaves the session envelope (BBOX {env.west} {env.south} "
                f"{env.east} {env.north}); a wrap-crossing view quantizes on the far "
                "side of the antimeridian and cannot share the session grid - "
                "call get_maplet again to open a new session"
            )

        # The compiler's time input is a datetime; a request hand-carries it
        # as an ISO string (as the JSON tool layer does).
        compile_opts = compile
        if compile_opts and isinstance(compile_opts.get("now"), str):
            from datetime import datetime, timezone

            compile_opts = {
                **compile_opts,
                "now": datetime.fromisoformat(
                    compile_opts["now"].replace("Z", "+00:00")
                ).astimezone(timezone.utc),
            }

        fetched = self._fetch_features(bbox, layers or [])
        move = move_maplet(
            scr,
            {"type": "FeatureCollection", "features": fetched["features"]},
            {
                "layers": layers,
                "budget": budget if budget is not None else self.default_budget,
                "radiusLabel": format_radius(radius_m),
                "capabilities": self.capabilities,
                **({"compile": compile_opts} if compile_opts is not None else {}),
            },
        )
        move.update(
            fetchedFrom=fetched["source"],
            fetchMs=fetched["elapsedMs"],
            warnings=fetched["warnings"],
            sourceTruncated=fetched["truncated"],
        )
        return move

    # ------------------------------------------------------------------
    # Routing
    # ------------------------------------------------------------------

    def route(self, req: dict) -> dict:
        """Route between two points: feasibility by default, navigation with a
        verified router."""
        try:
            return self.router.route(req)
        except Exception:  # noqa: BLE001 - mirrors the TS catch-all
            # A routing failure must not become an exception the agent has to
            # handle: fall back to the feasibility answer, which is honest
            # about not knowing the turns rather than inventing them.
            return straight_line_route(req["from"], req["to"], req.get("mode") or "walk")

    def route_with_traffic(self, req: dict) -> dict:
        """Route with live congestion.

        Falls back to free flow, labelled, when no flow provider has a
        credential. The `freeFlowOnly` flag is what the tool layer reads to
        tell the user their ETA ignores traffic, so this is the difference
        between a useful answer and a confidently wrong one.
        """
        return self.traffic.route(req)

    def weather_at(self, lat: float, lon: float, forecast_hours: int = 12) -> dict | None:
        """Conditions at a point.

        Returns None only when weather is explicitly disabled. A source that
        is configured but unreachable returns a result with `degraded` set and
        `now` filled with NaN, which renders as `unknown` rather than as dry
        weather.
        """
        if self.weather is None:
            return None
        return self.weather.fetch(lat, lon, forecast_hours)

    # ------------------------------------------------------------------
    # Heat derivation
    # ------------------------------------------------------------------

    def with_heat(self, doc: ScrDocument, bbox: dict) -> ScrDocument:
        """Attach derived heat layers to a document.

        Copy-on-write, so the cached document is never mutated. Two requests
        for the same envelope with different layer filters would otherwise
        leave the first one's heat describing the second one's data.

        Non-async here (nothing else needs a network): density is derived from
        data already in hand and costs nothing. Slope needs the terrain
        source, and it is best-effort: a terrain fetch that fails leaves the
        maplet without a slope layer rather than failing the whole request,
        because the topology the agent actually asked for is already in hand.
        """
        if not self.derive_heat:
            return doc

        heat = list(doc.heat)

        # Place density, from the named point features already ingested. Only
        # named places count: an unnamed bench is not something a person
        # chooses a street for, and counting them would make every park look
        # like a shopping district.
        points: list[dict] = []
        for f in doc.features:
            if f.geometry.kind != "point":
                continue
            if not is_named_feature(doc, f):
                continue
            points.append({"x": f.geometry.point.x, "y": f.geometry.point.y, "value": 1})
        if len(points) >= 3:
            density = density_to_heat(points, doc.envelope, name="poi_density")
            if density:
                heat.append(density)

        # Slope, from elevation. This is the layer that answers "can I wheel a
        # pram or push a bike up this", which a road name cannot. It needs the
        # terrain source, and it is best-effort: a terrain fetch that fails
        # leaves the maplet without a slope layer rather than failing the whole
        # request.
        if self.elevation is not None:
            try:
                grid = self.elevation_for(bbox, SLOPE_HEAT_RES)
                scale = grid_scale_for(doc)
                if grid and scale:
                    # The grid axes need not be square, so each gets its own
                    # scale. Using one number for both overstates slope on
                    # whichever axis is longer, which would flag a gentle
                    # east-west street as steep.
                    slope = slope_to_heat(
                        grid.values,
                        grid.width,
                        grid.height,
                        name="slope",
                        metres_per_unit=(scale["x"] + scale["y"]) / 2,
                    )
                    if slope:
                        heat.append(slope)
            except Exception:  # noqa: BLE001, S110 - terrain is best-effort, breaks nothing
                # Terrain unavailable. The rest of the maplet stands on its own.
                pass

        return doc if len(heat) == len(doc.heat) else replace_heat(doc, heat)

    # ------------------------------------------------------------------
    # Fetch + cache
    # ------------------------------------------------------------------

    def document(self, bbox: dict, layers: list[str]) -> dict:
        """Fetch and cache the compiled document for an area."""
        key = cache_key(bbox, layers)
        hit = self.cache.get(key)
        if hit and time.time() - hit[1] < CACHE_TTL_S:
            return {
                "doc": hit[0],
                "source": "cache",
                "elapsedMs": 0,
                "warnings": [],
                "truncated": False,
            }

        res = self._fetch_features(bbox, layers)
        doc = from_geojson(
            {"type": "FeatureCollection", "features": res["features"]},
            {"envelope": {"type": "bbox", **bbox}, "source": res["source"]},
        )
        self.remember(key, doc)
        return {
            "doc": doc,
            "source": res["source"],
            "elapsedMs": res["elapsedMs"],
            "warnings": res["warnings"],
            "truncated": res["truncated"],
        }

    def _fetch_features(self, bbox: dict, layers: list[str]) -> dict:
        """Fetch through the sources, trying each until one answers.

        Split out of ``document`` so session moves can ingest the same
        features under the *session's* envelope rather than the request box's
        own - the one-envelope rule that makes the diff compare geometry
        exactly.
        """
        request = {"bbox": bbox, "layers": layers, "maxFeatures": 50_000}

        last_error: BaseException | None = None
        for source in self.sources:
            if not has_available(source):
                continue
            try:
                return source.fetch(request)
            except Exception as err:  # noqa: BLE001 - mirrors the TS catch-all
                last_error = err

        raise Exception(  # noqa: TRY002 - mirrors the TS bare Error
            "no source could serve the request" + (f": {last_error}" if last_error else "")
        )

    def remember(self, key: str, doc: ScrDocument) -> None:
        if len(self.cache) >= CACHE_MAX:
            # Evict the oldest insertion, which dict iteration order preserves.
            oldest = next(iter(self.cache))
            self.cache.pop(oldest)
        self.cache[key] = (doc, time.time())

    def scr(self, bbox: dict, layers: list[str] | None = None) -> str:
        """Full SCR text for an area, for machine-side caching or binary encoding."""
        found = self.document(bbox, layers or [])
        return _encode_wire(found["doc"], {"group": False})

    def elevation_for(self, bbox: dict, res: int = 32) -> Any | None:
        """Elevation grid for an area, when a terrain source is configured."""
        if self.elevation is None:
            return None
        try:
            from .overpass import normalize_bbox

            return self.elevation.fetch(normalize_bbox(bbox), res)
        except Exception:  # noqa: BLE001 - mirrors the TS catch-all
            # Terrain is an enrichment, not a requirement. A failure must not
            # take down the maplet; it just means the graph carries no
            # elevation.
            return None

    # ------------------------------------------------------------------
    # Capabilities
    # ------------------------------------------------------------------

    @property
    def cache_size(self) -> int:
        """Number of cached documents, for diagnostics."""
        return len(self.cache)

    @property
    def has_elevation(self) -> bool:
        """Whether elevation can actually be answered.

        The MCP layer uses this to decide whether to advertise `get_terrain`
        at all, so an operator is never handed a tool that cannot work.
        """
        return self.elevation is not None

    @property
    def has_weather(self) -> bool:
        """Whether weather can be answered. Gates advertising `get_weather`."""
        return self.weather is not None

    @property
    def has_traffic(self) -> bool:
        """Whether live traffic can be answered.

        Gates advertising `get_traffic`. The distinction from `hasWeather`
        matters: weather works with no credential, traffic never does, so
        `get_traffic` is absent from the tool list unless a key is present.
        Advertising it anyway would produce an agent that confidently quotes a
        free-flow ETA.
        """
        return self.traffic.has_flow

    @property
    def capabilities(self) -> dict[str, bool]:
        """The full capability set, used for tool advertisement."""
        return {
            "elevation": self.has_elevation,
            "weather": self.has_weather,
            "traffic": self.has_traffic,
        }

    def clear_cache(self) -> None:
        """Clear the document cache."""
        self.cache.clear()


# ---------------------------------------------------------------------------
# GeoJSON recovery from a compiled document
# ---------------------------------------------------------------------------


def features_from_document(doc: ScrDocument) -> list[dict]:
    """Recover the GeoJSON feature list from a compiled document.

    This is the only place that knows how to read attributes back out of the
    string dictionary. Re-entering `to_maplet` with the recovered features
    keeps a single compile path for every input, which is what stops live and
    fixture results from drifting apart.
    """
    env = doc.envelope
    return [
        {
            "type": "Feature",
            "id": f.id,
            "properties": properties_of(doc, f.attrSet, f.classId),
            "geometry": geometry_of(doc, f, env),
        }
        for f in doc.features
    ]


def properties_of(doc: ScrDocument, attr_set: int, class_id: int) -> dict:
    props: dict = {}
    cls = doc.classes.get(class_id)
    if cls:
        props["type"] = cls.name

    set_ = doc.attrSets.get(attr_set)
    if not set_:
        return props
    for p in set_.props:
        key = doc.strings.get(p.key)
        if key is None:
            continue
        v = p.value
        if v.t == "ref":
            s = doc.strings.get(v.ref)
            if s is not None:
                props[key] = s
        elif v.t == "num":
            props[key] = v.num
        elif v.t == "bool":
            props[key] = v.bool
        else:
            props[key] = v.token
    return props


def geometry_of(doc: ScrDocument, f: Feature, env: Any) -> dict:
    g = f.geometry

    def to_lon_lat(p) -> tuple[float, float]:
        lat, lon = grid_to_lonlat(p.x, p.y, env, doc.extent, doc.projection)
        return _round(lon, 7), _round(lat, 7)  # GeoJSON order is (lon, lat)

    if g.kind == "point":
        return {"type": "Point", "coordinates": to_lon_lat(g.point)}
    if g.kind == "line":
        return {
            "type": "LineString",
            "coordinates": [to_lon_lat(p) for p in g.lines[0]] if g.lines else [],
        }
    # polygon / building
    ring = g.polygon[0].rings[0] if g.polygon and g.polygon[0].rings else None
    return {
        "type": "Polygon",
        "coordinates": [[to_lon_lat(p) for p in ring]] if ring else [],
    }


def format_radius(m: float) -> str:
    # `toFixed(1)` semantics matter only at ties, which integer radii (the
    # normal case) never hit.
    from .types import js_fixed

    return f"{js_fixed(m / 1000, 1)}km" if m >= 1000 else f"{js_round(m):.0f}m"


def _round(n: float, places: int) -> float:
    """``Math.round(n * 10**places) / 10**places`` (the TS helper's exact shape)."""
    f = 10**places
    return js_round(n * f) / f


def is_named_feature(doc: ScrDocument, f: Feature) -> bool:
    """Whether a feature carries a non-empty `name`, used for density counting."""
    if f.attrSet == 0:
        return False
    set_ = doc.attrSets.get(f.attrSet)
    if not set_:
        return False
    for p in set_.props:
        if doc.strings.get(p.key) != "name":
            continue
        v = p.value
        if v.t == "ref":
            s = doc.strings.get(v.ref)
            if s is not None and s != "":
                return True
    return False


def cache_key(bbox: dict, layers: list[str]) -> str:
    b = ",".join(_js_fixed_bbox(v) for v in [bbox["west"], bbox["south"], bbox["east"], bbox["north"]])
    return f"{b}|{','.join(sorted(layers))}"


def _js_fixed_bbox(n: float) -> str:
    from .types import js_fixed

    return js_fixed(n, 5)


def replace_heat(doc: ScrDocument, heat: list) -> ScrDocument:
    from dataclasses import replace

    return replace(doc, heat=heat)


def has_available(source: Any) -> bool:
    """``source.available()`` if defined, else assume available."""
    fn = getattr(source, "available", None)
    if fn is None:
        return True
    out = fn()
    return bool(out)

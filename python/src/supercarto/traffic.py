"""Traffic conditions — Python port of ``src/source/traffic.ts``.

An agent that tells a person how long their drive will take is answering a
question whose answer changes minute to minute. A free-flow estimate of 22
minutes when the truth is 45 is worse than no answer: the person leaves on the
schedule the agent gave them.

So traffic is treated as a first-class layer with an explicit absence. When no
flow source is configured the tool says so and falls back to free-flow
duration, labelled as free-flow. It never presents a free-flow number as if it
were live.
"""

from __future__ import annotations

import json
import math
import os
from collections.abc import Callable
from urllib.parse import quote as _quote

from .routing import OSRM_PROFILES, OsrmRouter  # noqa: F401 - re-exported, TS does the same
from .types import js_fixed, js_round


def _encode_uri_component(s: str) -> str:
    # `encodeURIComponent`: identical to urllib's quote with the space
    # character counted as reserved (encodeURIComponent encodes '?'; quote
    # would leave it unless it is listed as safe, which it is not here).
    return _quote(s, safe="-_.!~*'()")

#: How congested a road segment is, as a judgement rather than a speed.
FlowLevel = str
TravelMode = str


def _is_number(v) -> bool:
    # JSON booleans are ints in Python, which JS's `typeof === 'number'`
    # never reports; keep them out of speed fields.
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _build_segment(**kw) -> dict:
    return {k: v for k, v in kw.items() if v is not None}


class TomTomFlow:
    """TomTom traffic flow.

    Chosen as the default because it reports congestion per road segment,
    which is the granularity an agent needs to say "the A406 is the slow
    part" rather than a single average for the whole journey. Requires a key.
    """

    name = "tomtom"

    def __init__(
        self,
        api_key: str | None = None,
        base: str | None = None,
        fetch: Callable | None = None,
        timeout_s: float | None = None,  # TS `timeoutMs`
    ) -> None:
        self.key = (
            api_key
            if api_key is not None
            else os.environ.get("TOMTOM_API_KEY") or os.environ.get("TRAFFIC_API_KEY")
        )
        self.base = base or "https://api.tomtom.com"
        self.fetch_impl = fetch
        self.timeout_s = timeout_s or 10.0

    def configured(self) -> bool:
        return isinstance(self.key, str) and self.key != ""

    def flow(self, req: dict, free_flow: dict) -> dict | None:
        if not self.configured():
            return None
        points = ";".join(_waypoints(free_flow["geometry"], req))
        if len(points) < 3:
            return None

        url = (
            f"{self.base}/traffic/services/flowinformation"
            f"?key={_encode_uri_component(self.key)}"
            f"&points={points}&unit=kmh&language=en&departureTime=now"
        )

        try:
            res = self._fetch(url)
            if not res.ok:
                return None
            body = json.loads(res.text)
            segments: list[dict] = []
            for road in body.get("flows") or []:
                for f in road.get("flows") or []:
                    speed = f["currentSpeed"] if _is_number(f.get("currentSpeed")) else None
                    free = f["freeFlowSpeed"] if _is_number(f.get("freeFlowSpeed")) else None
                    # A ratio below 1 means slower than free flow. TomTom
                    # occasionally reports current above free flow on a
                    # mis-tagged road; clamping keeps a bad sample from
                    # reading as "faster than the limit".
                    ratio = (
                        min(1, speed / free) if speed is not None and free is not None and free > 0 else None
                    )
                    road_name = f["roadName"] if isinstance(f.get("roadName"), str) else None
                    segment = _build_segment(
                        road=road_name,
                        level="unknown" if ratio is None else level_for_ratio(ratio),
                        speedKmh=speed,
                        freeFlowKmh=free,
                        ratio=js_round(ratio * 100) / 100 if ratio is not None else None,
                        stale=True if f.get("confidence") == "low" else None,
                    )
                    segments.append(segment)
            if not segments:
                return None
            return {"segments": segments, "source": self.name}
        except Exception:  # noqa: BLE001 - mirrors the TS catch-all
            # A flow provider that is slow or broken degrades to free-flow,
            # which the caller labels. Returning None rather than raising
            # keeps one dead third party from failing a routing request that
            # is otherwise fine.
            return None

    def _fetch(self, url: str):
        if self.fetch_impl is not None:
            return self.fetch_impl(url, timeout_s=self.timeout_s)
        from .net import http_fetch

        return http_fetch(url, timeout_s=self.timeout_s)


class HereFlow:
    """HERE Traffic, the alternative provider. Same interface, different payload."""

    name = "here"

    def __init__(
        self,
        api_key: str | None = None,
        base: str | None = None,
        fetch: Callable | None = None,
        timeout_s: float | None = None,  # TS `timeoutMs`
    ) -> None:
        self.key = api_key if api_key is not None else os.environ.get("HERE_API_KEY")
        self.base = base or "https://traffic.ls.hereapi.com"
        self.fetch_impl = fetch
        self.timeout_s = timeout_s or 10.0

    def configured(self) -> bool:
        return isinstance(self.key, str) and self.key != ""

    def flow(self, req: dict, free_flow: dict) -> dict | None:
        if not self.configured():
            return None
        points = _waypoints(free_flow["geometry"], req)
        if len(points) < 2:
            return None
        # HERE takes longitude,latitude ordered semicolon-separated points,
        # one group per road, with groups separated by `|`. TomTom takes the
        # opposite order, so the pairs are reversed here rather than at the
        # call site.
        path = "|".join(";".join(reversed(p.split(","))) for p in points)

        url = (
            f"{self.base}/traffic/v2/flow?apiKey={_encode_uri_component(self.key)}"
            f"&points={path}&return=summary,polyline"
        )

        try:
            res = self._fetch(url)
            if not res.ok:
                return None
            body = json.loads(res.text)
            segments: list[dict] = []
            for f in body.get("currentFlow") or []:
                loc = f.get("location") or {}
                cur = loc.get("currentSpeed")
                free = loc.get("freeFlowSpeed")
                ratio = (
                    min(1, cur / free)
                    if _is_number(cur) and _is_number(free) and free > 0
                    else None
                )
                if ratio is None:
                    continue
                segments.append(
                    _build_segment(
                        road=loc.get("roadName"),
                        level=level_for_ratio(ratio),
                        speedKmh=loc["currentSpeed"],
                        freeFlowKmh=loc["freeFlowSpeed"],
                        ratio=js_round(ratio * 100) / 100,
                        stale=True if f.get("confidence") == "low" else None,
                    )
                )
            if not segments:
                return None
            return {"segments": segments, "source": self.name}
        except Exception:  # noqa: BLE001 - mirrors the TS catch-all
            return None

    def _fetch(self, url: str):
        if self.fetch_impl is not None:
            return self.fetch_impl(url, timeout_s=self.timeout_s)
        from .net import http_fetch

        return http_fetch(url, timeout_s=self.timeout_s)


def level_for_ratio(ratio: float) -> FlowLevel:
    """Congestion from a speed ratio.

    Thresholds follow what road agencies use for level-of-service grading
    rather than arbitrary round numbers, because those are the numbers a
    person's intuition is already calibrated on: below 70% of free flow a road
    is genuinely congested, not merely "a bit busy".
    """
    if ratio >= 0.9:
        return "free"
    if ratio >= 0.75:
        return "light"
    if ratio >= 0.6:
        return "moderate"
    if ratio >= 0.4:
        return "heavy"
    return "severe"


def _severity(level: FlowLevel) -> int:
    return {
        "severe": 5,
        "heavy": 4,
        "moderate": 3,
        "light": 2,
        "free": 1,
    }.get(level, 0)


def _route_summary(routed: dict) -> dict:
    route = routed["route"]
    return {
        # `time` is absent on a straight-line fallback, in which case the
        # caller's own estimate is already an approximation and doubling it
        # would be noise.
        "durationS": route.time if route.time is not None else 0,
        # Road names in order, used to match flow segments to legs.
        "roads": [s.turn for s in route.steps if isinstance(s.turn, str) and s.turn != ""],
        "geometry": routed["geometry"],
    }


def _waypoints(geometry: list, req: dict) -> list[str]:
    """TomTom and HERE both cap the number of sampled points, so thin the path."""
    pts: list[str] = []

    def push(lon: float, lat: float) -> None:
        s = f"{js_fixed(lat, 5)},{js_fixed(lon, 5)}"
        if not pts or pts[-1] != s:
            pts.append(s)

    push(req["from"]["lon"], req["from"]["lat"])
    stride = max(1, math.floor(len(geometry) / 100))
    for i in range(0, len(geometry), stride):
        p = geometry[i]
        push(p[0], p[1])
    push(req["to"]["lon"], req["to"]["lat"])
    return pts


class TrafficRouter:
    """Traffic-aware routing.

    Wraps a router and, when a flow source is configured, corrects the
    free-flow duration by the congestion actually observed on the route. With
    no flow source the answer is free-flow and says so in ``freeFlowOnly`` and
    in the text the agent renders, because the alternative is a confidently
    wrong ETA.
    """

    def __init__(self, router, flows: list | None = None) -> None:
        self.router = router
        self.flows = flows or []

    @property
    def has_flow(self) -> bool:
        """Whether any flow provider has a credential. Gates advertising the tool."""
        return any(f.configured() for f in self.flows)

    def route(self, req: dict) -> dict:
        mode = req.get("mode") or "drive"
        routed = self.router.route({**req, "mode": mode})
        free_flow = _route_summary(routed)

        for provider in self.flows:
            if not provider.configured():
                continue
            # The guard belongs here as well as inside each provider. A
            # third-party implementation that raises must not take down a
            # routing request that is otherwise fine, and only the caller can
            # guarantee that for providers it did not write.
            try:
                got = provider.flow(req, free_flow)
            except Exception:  # noqa: BLE001, S112 - mirrors the TS catch-all
                continue
            if not got or not got["segments"]:
                continue

            segments = got["segments"]
            ratios = [s["ratio"] for s in segments if _is_number(s.get("ratio"))]
            worst = "free"
            for s in segments:
                if _severity(s["level"]) > _severity(worst):
                    worst = s["level"]

            # Overall level uses the mean ratio, because a single slow
            # junction is not a congested journey. The worst segment is
            # reported separately as `worstLevel`, which is the actionable
            # part.
            mean = sum(ratios) / len(ratios) if ratios else 1
            overall = level_for_ratio(mean) if ratios else "unknown"

            # Duration scales by the congestion actually observed. A delay
            # figure from the provider is preferred when present, because it
            # comes from the provider's own historical model rather than a
            # single current sample.
            stated_delay = sum(s.get("delayS") or 0 for s in segments)
            delay_s = (
                stated_delay
                if stated_delay > 0
                else js_round(free_flow["durationS"] * (1 / max(0.2, mean) - 1))
            )

            return {
                "level": overall,
                "worstLevel": worst,
                "durationS": free_flow["durationS"] + delay_s,
                "freeFlowS": free_flow["durationS"],
                "delayS": delay_s,
                "segments": segments,
                "source": got["source"],
                "freeFlowOnly": False,
            }

        return {
            "level": "unknown",
            "worstLevel": "unknown",
            "durationS": free_flow["durationS"],
            "freeFlowS": free_flow["durationS"],
            "delayS": 0,
            "segments": [],
            "source": "none",
            "unavailable": (
                "no traffic flow source configured; duration is free-flow and ignores "
                "congestion. Set TOMTOM_API_KEY or HERE_API_KEY for live conditions."
            ),
            "freeFlowOnly": True,
        }

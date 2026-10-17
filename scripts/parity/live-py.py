#!/usr/bin/env python3
"""Live-path parity harness, Python side — the mirror of ``live-ts.mjs``.

Drives the native :class:`supercarto.live.SuperCarto` stack against the same
recorded service responses and prints the same canonical JSON report, which
``check-live.sh`` diffs against the TypeScript one. The requests each side
builds are reported too, so Overpass-QL / weather-URL / OSRM-URL string parity
is part of the gate.
"""

from __future__ import annotations

import json
import math
import sys
import urllib.parse
from dataclasses import asdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python" / "src"))

from supercarto.live import SuperCarto  # noqa: E402
from supercarto.routing import OsrmRouter  # noqa: E402

FIXTURES = ROOT / "scripts" / "parity" / "fixtures" / "live"

overpass_body = (FIXTURES / "overpass.json").read_text(encoding="utf-8")
weather_body = (FIXTURES / "weather.json").read_text(encoding="utf-8")
route_body = (FIXTURES / "route.json").read_text(encoding="utf-8")

RECORDED = {
    "overpass-api.de": overpass_body,
    "api.open-meteo.com": weather_body,
    "router.project-osrm.org": route_body,
}

requests: dict[str, str | None] = {}


def make_stub(log_key: str):
    """A fetch callable serving the recorded response with the request logged."""

    def stub(url: str, **kw):
        host = next((h for h in RECORDED if h in url), None)
        if host is None:
            raise RuntimeError(f"unexpected request in fixture: {url}")
        if log_key == "overpass":
            qs = urllib.parse.parse_qs(kw.get("body") or "")
            requests["overpassQuery"] = (qs.get("data") or [None])[0]
        else:
            requests[log_key] = url

        class Response:
            status = 200
            ok = True

            def __init__(self):
                self.text = RECORDED[host]
                self.body = self.text.encode("utf-8")

        return Response()

    return stub


LAT = 37.75991
LON = -122.41425
RADIUS = 90
NOW = "2026-10-01T12:00:00Z"
UTC_OFFSET = -420
BUDGET = 900


def canonical(value):
    """Match the TS canonicalizer: NaN -> omitted, 0.0 -> 0, sorted keys.

    ``None``-valued dict entries are dropped, because TS ``JSON.stringify``
    omits ``undefined`` properties rather than emitting ``null``.
    """
    if value is None:
        return UNSET
    if isinstance(value, bool) or isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            return UNSET
        if value.is_integer() and abs(value) < 2**53:
            return int(value)
        return value
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        return [c for c in (canonical(v) for v in value) if c is not UNSET]
    if isinstance(value, dict):
        out = {}
        for k, v in sorted(value.items(), key=lambda kv: kv[0]):
            c = canonical(v)
            if c is not UNSET:
                out[k] = c
        return out
    raise TypeError(f"cannot canonicalize {type(value)}")


class _Unset:
    pass


UNSET = _Unset()


carto = SuperCarto(
    overpass={"fetch": make_stub("overpass")},
    openMeteo={"fetch": make_stub("weather")},
    defaultBudget=BUDGET,
)
m = carto.maplet(
    LAT,
    LON,
    radius_m=RADIUS,
    budget=BUDGET,
    compile={"now": NOW, "utcOffsetMinutes": UTC_OFFSET},
)

weather = carto.weather_at(LAT, LON, 12)

router = OsrmRouter(fetch=make_stub("route"))
route = router.route(
    {"from": {"lat": LAT, "lon": LON}, "to": {"lat": 37.76069, "lon": -122.41286}, "mode": "walk"}
)

report = {
    "maplet": {
        "yaml": m["yaml"],
        "tokens": m["metrics"]["tokens"],
        "nodes": m["metrics"]["nodes"],
        "edges": m["metrics"]["edges"],
        "droppedNodes": m["metrics"]["droppedNodes"],
        "warnings": m["warnings"],
        "source": m["fetchedFrom"],
        "sourceTruncated": m["sourceTruncated"],
    },
    "weather": weather,
    "route": {
        "route": asdict(route["route"]),
        "geometry": route["geometry"],
        "source": route["source"],
    },
    "requests": {
        "overpassQuery": requests.get("overpassQuery"),
        "weather": requests.get("weather"),
        "route": requests.get("route"),
    },
}

print(json.dumps(canonical(report), separators=(",", ":")))

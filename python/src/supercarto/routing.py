"""Routing — demoted from navigation to feasibility. Port of
``src/source/routing.ts``.

A language model gains nothing from four hundred route coordinates. It gains
everything from "head north about a kilometre, then verify on arrival". So
what this module ships by default is a *feasibility answer*: straight-line
distance, compass direction, and an explicit instruction to verify the last
stretch on arrival. It does not ship turn-by-turn directions unless the
operator configures a routing engine they have verified themselves, because
the strongest-sounding tool must also be the most verified one — measured on
the public demo OSRM, a northward walk in sf-cbd returned an impossible 35 m
for a 50 m displacement (see supercarto-bench, "route unmeasurable").
Feasibility is checkable; unverifiable turn-by-turn is a lie told with
confidence.

The shape of a route is unchanged: prose steps for the model, full geometry
left behind for code.
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable

from .types import Route, RouteStep, js_round

#: Profile names per engine: OSRM uses paths, Valhalla uses costing models.
OSRM_PROFILES = {"walk": "foot", "bike": "bike", "drive": "driving"}

OSRM_DEFAULT = "https://router.project-osrm.org"
DEFAULT_BEARINGS = [
    "north", "northeast", "east", "southeast",
    "south", "southwest", "west", "northwest",
]


class OsrmRouter:
    """OSRM, the reference routing engine — opt-in only now.

    Its `/route/v1` response already contains what a model needs: per-leg
    distance, duration, and a maneuver bearing with a type. That maps directly
    onto SCR's `ROUTE` and `STEP` records without any geometry work.

    It is no longer the default. The shared demo server answers `Ok` with
    physically impossible distances on foot profiles (measured: 35 m of
    walking for a 50 m straight-line displacement in sf-cbd). Point this at
    an OSRM you host and have verified, or leave it unset and the feasibility
    answer (see ``FeasibilityRouter``) is what the route tool reports.
    """

    name = "osrm"

    def __init__(
        self,
        endpoint: str | None = None,
        fetch: Callable | None = None,
        timeout_s: float | None = None,
        bearings: list[str] | None = None,
    ):
        self.endpoint = endpoint or OSRM_DEFAULT
        self.fetch_impl = fetch
        self.timeout_s = timeout_s or 20.0
        self.bearings = bearings or DEFAULT_BEARINGS

    def route(self, req: dict) -> dict:
        mode = req.get("mode") or "walk"
        profile = OSRM_PROFILES[mode]

        coords = f"{req['from']['lon']},{req['from']['lat']};{req['to']['lon']},{req['to']['lat']}"
        url = (
            f"{self.endpoint}/route/v1/{profile}/{coords}"
            "?overview=full&geometries=geojson&steps=true"
        )

        res = self._fetch(url, timeout_s=self.timeout_s)
        if not res.ok:
            raise Exception(f"OSRM responded {res.status}")  # noqa: TRY002 - mirrors the TS bare Error
        body = json.loads(res.text)

        if body.get("code") != "Ok" or not body.get("routes"):
            raise Exception(  # noqa: TRY002 - mirrors the TS bare Error
                f"no route found (OSRM code {body.get('code') or 'unknown'})"
            )

        r = body["routes"][0]
        steps: list[RouteStep] = []
        n = 1

        for leg in r.get("legs") or []:
            for s in leg.get("steps") or []:
                instruction = self._instruction(s)
                if instruction is None:
                    continue
                step = RouteStep(n=n, instruction=instruction, dist=js_round(s["distance"]))
                n += 1
                if s.get("name"):
                    step.turn = s["name"]
                steps.append(step)

        route = Route(
            id=1,
            mode=mode,
            dist=js_round(r["distance"]),
            time=js_round(r.get("duration", 0)),
            steps=steps,
        )

        return {
            "route": route,
            "geometry": (r.get("geometry") or {}).get("coordinates") or [],
            "source": self.name,
        }

    def _fetch(self, url: str, timeout_s: float):
        if self.fetch_impl is not None:
            return self.fetch_impl(url, timeout_s=timeout_s)
        from .net import http_fetch

        return http_fetch(url, timeout_s=timeout_s)

    def _instruction(self, s: dict) -> str | None:
        """Turn an OSRM maneuver into a sentence.

        Prose, because the consumer is a language model that was trained on
        prose and reads it far more reliably than a structured enum. Returns
        None for maneuvers that carry no information - the "continue straight"
        markers at every vertex of a straight road would otherwise triple the
        step count.
        """
        m = s.get("maneuver")
        if not m:
            return None
        road = s.get("name")

        mtype = m.get("type")
        if mtype == "depart":
            return f"head onto {road}" if road else "head out"
        if mtype == "arrive":
            return f"arrive on {road}" if road else "arrive at your destination"
        if mtype in ("turn", "end of road"):
            modifier = m.get("modifier")
            dir_word = modifier or self._bearing_word(m.get("bearing_after"))
            if not dir_word:
                return None
            return f"turn {dir_word} onto {road}" if road else f"turn {dir_word}"
        if mtype in ("continue", "new name"):
            return f"continue on {road}" if road else None
        if mtype in ("merge", "on ramp", "off ramp"):
            return f"take the ramp onto {road}" if road else None
        if mtype in ("roundabout", "rotary", "roundabout turn", "exit roundabout", "exit rotary"):
            modifier = m.get("modifier")
            exit_txt = f" ({modifier} exit)" if modifier else ""
            return f"roundabout{exit_txt}" + (f" onto {road}" if road else "")
        if mtype == "fork":
            return (
                f"keep {m.get('modifier') or 'straight'} onto {road}" if road else None
            )
        if mtype == "uturn":
            return "make a U-turn"
        return None

    def _bearing_word(self, bearing: float | None) -> str | None:
        if bearing is None:
            return None
        idx = int(js_round((bearing / 45) % 8))
        return self.bearings[((idx % 8) + 8) % 8]


class FeasibilityRouter:
    """The default route source: a feasibility answer, not navigation.

    It is explicitly not turn-by-turn, and the mode name says so, because an
    agent that believes it has real turn instructions when it has two points
    and a distance will confidently send someone the wrong way. The dist/time
    figures are present; the instruction is honest about its own inadequacy
    and ends in the one thing that makes a straight-line claim useful: verify
    on arrival.
    """

    name = "feasibility"

    def route(self, req: dict) -> dict:
        return straight_line_route(
            req["from"], req["to"], req.get("mode") or "walk"
        )


def straight_line_route(
    from_: dict, to: dict, mode: str = "walk"
) -> dict:
    """Build a feasibility route: the straight-line distance, the initial
    compass direction, and the instruction that ends this tool's contract -
    verify the approach on arrival.
    """
    # Great-circle distance, then a flat-world conversion to metres.
    R = 6371008.8
    d_lat = (to["lat"] - from_["lat"]) * math.pi / 180
    d_lon = (to["lon"] - from_["lon"]) * math.pi / 180
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(from_["lat"] * math.pi / 180) * math.cos(to["lat"] * math.pi / 180) * math.sin(d_lon / 2) ** 2
    )
    distance = js_round(2 * R * math.asin(min(1, math.sqrt(a))))

    # Rough speeds: walking 1.35 m/s, cycling 4.5, driving 11.
    speed = 1.35 if mode == "walk" else 4.5 if mode == "bike" else 11
    duration = int(js_round(distance / speed))

    # Initial great-circle bearing, via the standard spherical formula.
    to_rad = math.pi / 180
    phi1 = from_["lat"] * to_rad
    phi2 = to["lat"] * to_rad
    lambda1 = from_["lon"] * to_rad
    lambda2 = to["lon"] * to_rad
    y = math.sin(lambda2 - lambda1) * math.cos(phi2)
    x = (
        math.cos(phi1) * math.sin(phi2)
        - math.sin(phi1) * math.cos(phi2) * math.cos(lambda2 - lambda1)
    )
    bearing_deg = ((math.atan2(y, x) * 180 / math.pi) + 360) % 360
    dir_word = DEFAULT_BEARINGS[int(js_round(bearing_deg / 45)) % 8]

    return {
        "route": Route(
            id=1,
            mode=f"{mode}-approx",
            dist=distance,
            time=duration,
            steps=[
                RouteStep(
                    n=1,
                    instruction=(
                        f"head {dir_word} toward the destination (approx {distance}m, "
                        "no routing engine configured) then verify the approach on arrival"
                    ),
                    dist=distance,
                )
            ],
        ),
        "geometry": [
            [from_["lon"], from_["lat"]],
            [to["lon"], to["lat"]],
        ],
        "source": "straight-line",
    }

"""Weather — port of ``src/source/weather.ts``.

An agent that books a ride, plans a walk, or tells someone when to leave is
working for a person who is standing outside. Rain and wind change whether the
trip is worth making and how long it will take, so weather is not a cosmetic
enrichment — it is an input to the decision the human is actually making.

The source is Open-Meteo, which needs no API key, no account, and no billing,
and returns a forecast at a coordinate. That matters: a paid weather key would
put a signup wall in front of every evaluation of this library.
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from typing import Any

#: Defaults; NaN is the "no data" sentinel — see :func:`unknown_conditions`.
NAN = math.nan

from .net import query_params

OPEN_METEO_DEFAULT = "https://api.open-meteo.com/v1/forecast"
DEFAULT_TIMEOUT_S = 12.0

#: Current fields requested.
#:
#: The list is deliberate rather than maximal. Every extra field is a token in
#: the agent's context and a claim it may act on, so each one here has to earn
#: its place: a temperature a person will feel, precipitation that changes
#: whether they go out, wind that changes whether an umbrella is enough, and
#: visibility that changes whether driving is safe.
CURRENT_FIELDS = [
    "temperature_2m",
    "apparent_temperature",
    "precipitation",
    "rain",
    "showers",
    "snowfall",
    "weather_code",
    "cloud_cover",
    "wind_speed_10m",
    "wind_direction_10m",
    "wind_gusts_10m",
    "visibility",
    "relative_humidity_2m",
    "is_day",
]

HOURLY_FIELDS = [
    "temperature_2m",
    "precipitation",
    "rain",
    "showers",
    "snowfall",
    "weather_code",
    "wind_speed_10m",
]

DAILY_FIELDS = [
    "weather_code",
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_sum",
    "precipitation_probability_max",
    "wind_speed_10m_max",
]


class OpenMeteoWeather:
    name = "open-meteo"

    def __init__(self, endpoint: str | None = None, fetch: Callable | None = None, timeout_s: float | None = None):
        self.endpoint = endpoint or OPEN_METEO_DEFAULT
        self.fetch_impl = fetch
        self.timeout_s = timeout_s or DEFAULT_TIMEOUT_S

    def fetch(self, lat: float, lon: float, forecast_hours: int = 12) -> dict:
        days = max(1, min(7, math.ceil(forecast_hours / 24) + 1))
        params = {
            "latitude": _js_fixed(lat, 5),
            "longitude": _js_fixed(lon, 5),
            "current": ",".join(CURRENT_FIELDS),
            "hourly": ",".join(HOURLY_FIELDS),
            "daily": ",".join(DAILY_FIELDS),
            "forecast_days": str(days),
            "timezone": "UTC",
            "wind_speed_unit": "kmh",
        }

        try:
            res = self._fetch(f"{self.endpoint}?{query_params(params)}", timeout_s=self.timeout_s)
            if not res.ok:
                raise Exception(  # noqa: TRY002 - surfaced as `degraded`, never a crash path
                    f"weather source responded {res.status}"
                )
            body = json.loads(res.text)
            if body.get("error"):
                raise Exception(  # noqa: TRY002 - surfaced as `degraded`, never a crash path
                    f"weather source error: {body.get('reason') or 'unknown'}"
                )
            return {
                "now": read_now(body),
                "hourly": read_hourly(body, forecast_hours),
                "daily": read_daily(body),
                "lat": body["latitude"] if isinstance(body.get("latitude"), (int, float)) else lat,
                "lon": body["longitude"] if isinstance(body.get("longitude"), (int, float)) else lon,
                "gridOffsetM": _grid_offset(lat, lon, body.get("latitude"), body.get("longitude")),
                "source": self.name,
            }
        except Exception as err:  # noqa: BLE001 - mirrors the TS catch-all
            # Weather is an input to a decision, not the decision. When the
            # source is unreachable the agent still needs a well-formed answer
            # rather than an exception, so an explicitly-labelled "unknown" is
            # returned. The label matters: an agent told "no data" will ask
            # again or hedge, whereas one handed fabricated sunshine will tell
            # a person to leave their umbrella.
            return {
                "now": unknown_conditions(),
                "hourly": [],
                "daily": [],
                "lat": lat,
                "lon": lon,
                "gridOffsetM": 0,
                "source": self.name,
                "degraded": str(err),
            }

    def _fetch(self, url: str, timeout_s: float):
        if self.fetch_impl is not None:
            return self.fetch_impl(url, timeout_s=timeout_s)
        from .net import http_fetch

        return http_fetch(url, timeout_s=timeout_s)


# ---------------------------------------------------------------------------
# Response reading
# ---------------------------------------------------------------------------


def cell(v: Any) -> float:
    """Coerce one cell of a forecast array to a number.

    The API is typed as an array of numbers but a null in a gap arrives as
    null, and treating a null as 0 would invent a comfortable 0 degrees in the
    middle of the Sahara. Anything unusable becomes NaN, which the formatter
    renders as `unknown` rather than a plausible value.
    """
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v if math.isfinite(v) else NAN
    if isinstance(v, str) and v.strip() != "":
        n = _to_number(v)
        return n if math.isfinite(n) else NAN
    return NAN


def cell_or_zero(v: Any) -> float:
    """Same, defaulting a gap to 0 for quantities where 0 is the honest value."""
    n = cell(v)
    return 0.0 if math.isnan(n) else n


def _to_number(raw: str) -> float:
    try:
        return float(raw)
    except ValueError:
        return NAN


def read_now(body: dict) -> dict:
    c = body.get("current") or {}

    def num(k: str) -> float:
        return cell(c.get(k))

    code = cell_or_zero(c.get("weather_code"))
    is_day = cell_or_zero(c.get("is_day")) == 1
    rain = cell_or_zero(c.get("rain")) + cell_or_zero(c.get("showers"))
    snow = cell_or_zero(c.get("snowfall"))
    visibility = cell(c.get("visibility"))
    at = None
    if isinstance(c.get("time"), str):
        at = f"{c['time']}:00Z"
    return {
        "tempC": num("temperature_2m"),
        "feelsLikeC": num("apparent_temperature"),
        "precipitationMm": num("precipitation"),
        "precipitation": classify_precipitation(rain, snow, code),
        "code": code,
        "summary": describe_code(code, is_day),
        "cloudCoverPct": num("cloud_cover"),
        "windKmh": num("wind_speed_10m"),
        "windDirDeg": num("wind_direction_10m"),
        "gustKmh": num("wind_gusts_10m"),
        # Visibility is absent in some regions; 10km is the standard
        # "unlimited" figure, but it is only used when the source actually
        # omits the field, not when it reports 0.
        "visibilityM": visibility if not math.isnan(visibility) else 10_000,
        "humidityPct": num("relative_humidity_2m"),
        "at": at,
        "night": not is_day,
    }


def read_hourly(body: dict, hours: int) -> list[dict]:
    h = body.get("hourly")
    if not h:
        return []
    times = h.get("time")
    if not isinstance(times, list):
        return []

    # The source returns the whole day from 00:00 local-to-the-grid. An agent
    # asking about "now" wants forward-looking hours, so the window is trimmed
    # to start at the current hour rather than replaying the morning.
    start = _find_now_index(times, (body.get("current") or {}).get("time"))
    out: list[dict] = []
    i = start
    while i < len(times) and len(out) < hours:
        at = times[i]
        if isinstance(at, str):
            rain = cell_or_zero(_at(h.get("rain"), i)) + cell_or_zero(_at(h.get("showers"), i))
            snow = cell_or_zero(_at(h.get("snowfall"), i))
            code = cell_or_zero(_at(h.get("weather_code"), i))
            out.append(
                {
                    "at": f"{at}:00Z",
                    "tempC": cell(_at(h.get("temperature_2m"), i)),
                    "precipitationMm": cell(_at(h.get("precipitation"), i)),
                    "precipitation": classify_precipitation(
                        rain, snow, code
                    ),
                    "windKmh": cell(_at(h.get("wind_speed_10m"), i)),
                    "code": code,
                }
            )
        i += 1
    return out


def _at(arr: Any, i: int) -> Any:
    if isinstance(arr, list) and 0 <= i < len(arr):
        return arr[i]
    return None


def _find_now_index(times: list, current_time: Any) -> int:
    if not isinstance(current_time, str):
        return 0
    hour = current_time[:13]
    for idx, t in enumerate(times):
        if isinstance(t, str) and t[:13] == hour:
            return idx
    return 0


def read_daily(body: dict) -> list[dict]:
    d = body.get("daily")
    if not d:
        return []
    dates = d.get("time")
    if not isinstance(dates, list):
        return []
    return [
        {
            "date": str(date),
            "tempMaxC": cell(_at(d.get("temperature_2m_max"), i)),
            "tempMinC": cell(_at(d.get("temperature_2m_min"), i)),
            "precipitationMm": cell(_at(d.get("precipitation_sum"), i)),
            "precipitationProbPct": cell(_at(d.get("precipitation_probability_max"), i)),
            "windKmh": cell(_at(d.get("wind_speed_10m_max"), i)),
            "code": cell_or_zero(_at(d.get("weather_code"), i)),
        }
        for i, date in enumerate(dates)
    ]


def classify_precipitation(rain: float, snow: float, code: float) -> str:
    """Which kind of precipitation is falling.

    The distinction is not cosmetic. Rain means an umbrella, snow means a
    coated jacket and a changed ETA, and sleet means both, so collapsing them
    into a number would throw away the part a person acts on.
    """
    if snow > 0 and rain > 0:
        return "sleet"
    if snow > 0:
        return "snow"
    # Codes 95-99 are thunderstorm, which is a convective event and can carry
    # hail even when the rain total is small; 85 and 86 are snow showers.
    if code >= 95:
        return "hail"
    if code == 85 or code == 86:
        return "snow"
    if rain > 0:
        return "drizzle" if 51 <= code <= 57 else "rain"
    return "none"


def describe_code(code: float, is_day: bool = True) -> str:
    """WMO code to a phrase a model can act on.

    The numeric code is preserved alongside because it is the stable
    identifier, but a model reads "heavy rain" and does not read 50213.
    """
    table = {
        0: "clear" if is_day else "clear night",
        1: "mainly clear" if is_day else "mainly clear night",
        2: "partly cloudy",
        3: "overcast",
        45: "fog",
        48: "fog",
        51: "light drizzle",
        53: "light drizzle",
        55: "drizzle",
        56: "freezing drizzle",
        57: "freezing drizzle",
        61: "light rain",
        63: "rain",
        65: "heavy rain",
        66: "freezing rain",
        67: "freezing rain",
        71: "light snow",
        73: "snow",
        75: "heavy snow",
        77: "snow grains",
        80: "light showers",
        81: "showers",
        82: "violent showers",
        85: "snow showers",
        86: "snow showers",
        95: "thunderstorm",
        96: "thunderstorm with hail",
        99: "thunderstorm with hail",
    }
    return table.get(code, "unknown")


def unknown_conditions() -> dict:
    """A place-holder for when the source could not be reached.

    `NaN` rather than 0 is deliberate. A model asked "is it raining?" given
    `precipitationMm: 0` answers "no, it is dry". Given a sentinel that reads
    as missing data, it says it does not know. Getting this wrong is how a
    weather tool talks someone into a walk in a storm.
    """
    return {
        "tempC": NAN,
        "feelsLikeC": NAN,
        "precipitationMm": NAN,
        "precipitation": "none",
        "code": -1,
        "summary": "unknown - weather source unavailable",
        "cloudCoverPct": NAN,
        "windKmh": NAN,
        "windDirDeg": NAN,
        "gustKmh": NAN,
        "visibilityM": NAN,
        "humidityPct": NAN,
        "night": False,
    }


def _grid_offset(lat: float, lon: float, glat: Any, glon: Any) -> int:
    if not isinstance(glat, (int, float)) or not isinstance(glon, (int, float)):
        return 0
    from .types import js_round

    R = 6371008.8
    to_rad = math.pi / 180
    d_lat = (glat - lat) * to_rad
    d_lon = (glon - lon) * to_rad
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(lat * to_rad) * math.cos(glat * to_rad) * math.sin(d_lon / 2) ** 2
    )
    return js_round(2 * R * math.asin(min(1, math.sqrt(a))))


def _js_fixed(n: float, d: int) -> str:
    """JavaScript ``n.toFixed(d)`` — thin wrapper over the shared helper.

    Kept parameter-compatible with the call sites in this module.
    """
    from .types import js_fixed

    return js_fixed(n, d)

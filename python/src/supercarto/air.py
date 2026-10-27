"""Air quality — port of ``src/source/air.ts``.

An agent that tells someone they can walk, run, or take the baby outside is
making an air claim. Particulate load changes that claim in ways a temperature
never will, so air quality joins weather as a decision input rather than a
dashboard statistic.

The source is the Open-Meteo Air Quality API (CAMS data). Like the forecast
source it needs no API key, no account, and no billing, so an evaluation is
never gated on a signup.
"""

from __future__ import annotations

import json
import math
from typing import Any

from .net import query_params

OPEN_METEO_AIR_DEFAULT = "https://air-quality-api.open-meteo.com/v1/air-quality"
DEFAULT_TIMEOUT_S = 12.0

#: Deliberate selection, mirrored from the TS source: two independent index
#: scales, the two particulate fractions, and the regulated gases. Missing
#: gases stay NaN and render as unknown; they are never zero-filled, because a
#: zero NO2 reading invented from a gap would certify airspace as clean.
CURRENT_FIELDS = [
    "european_aqi",
    "us_aqi",
    "pm10",
    "pm2_5",
    "carbon_monoxide",
    "nitrogen_dioxide",
    "sulphur_dioxide",
    "ozone",
]

HOURLY_FIELDS = ["european_aqi", "us_aqi", "pm2_5", "pm10"]

NAN = math.nan


def describe_european_aqi(aqi: float) -> str:
    """European AQI band for a raw 0-200+ index."""
    if math.isnan(aqi):
        return "unknown"
    if aqi <= 20:
        return "good"
    if aqi <= 40:
        return "fair"
    if aqi <= 60:
        return "moderate"
    if aqi <= 80:
        return "poor"
    if aqi <= 100:
        return "very poor"
    return "extremely poor"


def describe_us_aqi(aqi: float) -> str:
    """US EPA band for a raw 0-500 index."""
    if math.isnan(aqi):
        return "unknown"
    if aqi <= 50:
        return "good"
    if aqi <= 100:
        return "moderate"
    if aqi <= 150:
        return "unhealthy for sensitive"
    if aqi <= 200:
        return "unhealthy"
    if aqi <= 300:
        return "very unhealthy"
    return "hazardous"


def _js_fixed(v: float, digits: int) -> str:
    """Match ``Number.toFixed`` output for positive grid coordinates."""
    s = f"%.{digits}f" % v
    return s.rstrip("0").rstrip(".") if "." in s else s


def _grid_offset(lat: float, lon: float, glat: Any, glon: Any) -> int:
    if not isinstance(glat, (int, float)) or not isinstance(glon, (int, float)):
        return 0
    r = 6371008.8
    to_rad = math.pi / 180
    d_lat = (float(glat) - lat) * to_rad
    d_lon = (float(glon) - lon) * to_rad
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(lat * to_rad) * math.cos(float(glat) * to_rad) * math.sin(d_lon / 2) ** 2
    )
    return round(2 * r * math.asin(min(1.0, math.sqrt(a))))


def _js_sqrt_haversine(lat, lon, glat, glon) -> int:
    """Kept for parity name with TS; delegates to :func:`_grid_offset`."""
    return _grid_offset(lat, lon, glat, glon)


def _cell(v: Any) -> float:
    """Coerce one forecast cell to a number. Unusable becomes NaN, never 0."""
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(float(v)) else NAN
    if isinstance(v, str) and v.strip():
        try:
            n = float(v)
        except ValueError:
            return NAN
        return n if math.isfinite(n) else NAN
    return NAN


def read_now(body: dict) -> dict:
    c = body.get("current") or {}
    return {
        "europeanAqi": _cell(c.get("european_aqi")),
        "usAqi": _cell(c.get("us_aqi")),
        "pm25UgM3": _cell(c.get("pm2_5")),
        "pm10UgM3": _cell(c.get("pm10")),
        "ozoneUgM3": _cell(c.get("ozone")),
        "no2UgM3": _cell(c.get("nitrogen_dioxide")),
        "so2UgM3": _cell(c.get("sulphur_dioxide")),
        "coUgM3": _cell(c.get("carbon_monoxide")),
        "at": f"{c['time']}:00Z" if isinstance(c.get("time"), str) else None,
    }


def _find_now_index(times: list, current_time: Any) -> int:
    if not isinstance(current_time, str):
        return 0
    hour = current_time[:13]
    for i, t in enumerate(times):
        if isinstance(t, str) and t[:13] == hour:
            return i
    return 0


def read_hourly(body: dict, hours: int) -> list[dict]:
    h = body.get("hourly") or {}
    times = h.get("time")
    if not isinstance(times, list):
        return []
    out: list[dict] = []
    start = _find_now_index(times, (body.get("current") or {}).get("time"))
    for i in range(start, len(times)):
        if len(out) >= hours:
            break
        at = times[i]
        if not isinstance(at, str):
            continue
        out.append(
            {
                "at": f"{at}:00Z",
                "europeanAqi": _cell((h.get("european_aqi") or [None])[i]),
                "usAqi": _cell((h.get("us_aqi") or [None])[i]),
                "pm25UgM3": _cell((h.get("pm2_5") or [None])[i]),
                "pm10UgM3": _cell((h.get("pm10") or [None])[i]),
            }
        )
    return out


def elevated_gases(n: dict) -> list[str]:
    """Gases that clear their own good bound on the European scale.

    A gas is only named when it outruns ``good`` (NO2 > 50, O3 > 100, SO2 > 100,
    CO > 4000 µg/m³). Naming every gas every time burns tokens on numbers
    nobody can act on; naming the offender is the whole point.
    """
    out: list[str] = []
    no2 = n.get("no2UgM3", NAN)
    if not math.isnan(no2) and no2 > 50:
        out.append(f"NO2 {_fmt(no2)}")
    o3 = n.get("ozoneUgM3", NAN)
    if not math.isnan(o3) and o3 > 100:
        out.append(f"O3 {_fmt(o3)}")
    so2 = n.get("so2UgM3", NAN)
    if not math.isnan(so2) and so2 > 100:
        out.append(f"SO2 {_fmt(so2)}")
    co = n.get("coUgM3", NAN)
    if not math.isnan(co) and co > 4000:
        out.append(f"CO {_fmt(co)}")
    return out


def _unknown_conditions() -> dict:
    """NaN rather than 0 is deliberate. A model given ``pm25UgM3: 0`` will tell
    someone with asthma the air is fine. Given NaN, it hedges."""
    return {
        "europeanAqi": NAN,
        "usAqi": NAN,
        "pm25UgM3": NAN,
        "pm10UgM3": NAN,
        "ozoneUgM3": NAN,
        "no2UgM3": NAN,
        "so2UgM3": NAN,
        "coUgM3": NAN,
        "at": None,
    }


def _fmt(v: float) -> str:
    s = f"{v:g}"
    return s


class OpenMeteoAir:
    """Air-quality source; TS mirror is ``OpenMeteoAir``."""

    name = "open-meteo-air"

    def __init__(
        self,
        endpoint: str | None = None,
        fetch: Any = None,
        timeout_s: float | None = None,
    ):
        self.endpoint = endpoint or OPEN_METEO_AIR_DEFAULT
        self.fetch_impl = fetch
        self.timeout_s = timeout_s or DEFAULT_TIMEOUT_S

    def _fetch(self, url: str, timeout_s: float):
        if self.fetch_impl is not None:
            return self.fetch_impl(url, timeout_s=timeout_s)
        from .net import http_get

        return http_get(url, timeout_s=timeout_s)

    def fetch(self, lat: float, lon: float, forecast_hours: int = 12) -> dict:
        days = max(1, min(5, math.ceil(forecast_hours / 24) + 1))
        params = {
            "latitude": _js_fixed(lat, 5),
            "longitude": _js_fixed(lon, 5),
            "current": ",".join(CURRENT_FIELDS),
            "hourly": ",".join(HOURLY_FIELDS),
            "forecast_days": str(days),
            "timezone": "UTC",
        }
        try:
            res = self._fetch(f"{self.endpoint}?{query_params(params)}", timeout_s=self.timeout_s)
            if not getattr(res, "ok", False):
                raise Exception(  # noqa: TRY002 - surfaced as `degraded`, never a crash path
                    f"air source responded {res.status}"
                )
            body = json.loads(res.text)
            if body.get("error"):
                raise Exception(  # noqa: TRY002 - surfaced as `degraded`, never a crash path
                    f"air source error: {body.get('reason') or 'unknown'}"
                )
            return {
                "now": read_now(body),
                "hourly": read_hourly(body, forecast_hours),
                "lat": body["latitude"] if isinstance(body.get("latitude"), (int, float)) else lat,
                "lon": body["longitude"] if isinstance(body.get("longitude"), (int, float)) else lon,
                "gridOffsetM": _grid_offset(lat, lon, body.get("latitude"), body.get("longitude")),
                "source": self.name,
            }
        except Exception as err:  # noqa: BLE001 - mirrors the TS catch-all
            # Air is a health claim. An unreachable source yields an
            # explicitly-degraded result; the tool layer refuses rather than
            # embed a guess about air someone will breathe.
            return {
                "now": _unknown_conditions(),
                "hourly": [],
                "lat": lat,
                "lon": lon,
                "gridOffsetM": 0,
                "source": self.name,
                "degraded": str(err),
            }

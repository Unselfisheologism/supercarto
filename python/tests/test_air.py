"""Air quality — parity port of ``test/air.test.ts``.

The bands, the gas selection, and the degraded-source behaviour must agree
byte-for-byte with the TypeScript source: the Python client parses the MCP
surface's prose, so a banding drift shows up in production as a Python user
told "poor" while an Node user is told "moderate" from the same reading.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT / "python" / "src"))

from supercarto.air import (  # noqa: E402
    OpenMeteoAir,
    describe_european_aqi,
    describe_us_aqi,
    elevated_gases,
)
from supercarto.toolcatalog import TOOL_CATALOG, advertised_tools, offers_tool  # noqa: E402

BODY = {
    "latitude": 35.700005,
    "longitude": 139.80002,
    "current": {
        "time": "2026-10-27T07:00",
        "european_aqi": 62,
        "us_aqi": 65,
        "pm10": 29.7,
        "pm2_5": 28.1,
        "carbon_monoxide": 267.0,
        "nitrogen_dioxide": 63.5,
        "sulphur_dioxide": 48.1,
        "ozone": 29.0,
    },
    "hourly": {
        "time": ["2026-10-27T07:00", "2026-10-27T08:00", "2026-10-27T09:00"],
        "european_aqi": [62, 74, 55],
        "us_aqi": [65, 78, 57],
        "pm2_5": [28.1, 33.4, 21.2],
        "pm10": [29.7, 34.9, 23.3],
    },
}


class _Res:
    def __init__(self, payload: dict, status: int = 200):
        self._payload = payload
        self.status = status
        self.ok = status < 400
        self.text = __import__("json").dumps(payload)


def _air(payload: dict | None = None) -> OpenMeteoAir:
    return OpenMeteoAir(fetch=lambda url, timeout_s: _Res(BODY if payload is None else payload))


class TestBands:
    def test_european_boundaries(self) -> None:
        assert describe_european_aqi(0) == "good"
        assert describe_european_aqi(20) == "good"
        assert describe_european_aqi(21) == "fair"
        assert describe_european_aqi(40) == "fair"
        assert describe_european_aqi(41) == "moderate"
        assert describe_european_aqi(60) == "moderate"
        assert describe_european_aqi(61) == "poor"
        assert describe_european_aqi(80) == "poor"
        assert describe_european_aqi(81) == "very poor"
        assert describe_european_aqi(100) == "very poor"
        assert describe_european_aqi(101) == "extremely poor"

    def test_us_boundaries(self) -> None:
        assert describe_us_aqi(50) == "good"
        assert describe_us_aqi(51) == "moderate"
        assert describe_us_aqi(151) == "unhealthy"
        assert describe_us_aqi(201) == "very unhealthy"
        assert describe_us_aqi(301) == "hazardous"

    def test_missing_is_unknown_never_good(self) -> None:
        assert describe_european_aqi(math.nan) == "unknown"
        assert describe_us_aqi(math.nan) == "unknown"


class TestGases:
    def test_names_only_elevated(self) -> None:
        n = {"no2UgM3": 63.5, "ozoneUgM3": 29.0, "so2UgM3": 48.1, "coUgM3": 267.0}
        assert elevated_gases(n) == ["NO2 63.5"]

    def test_missing_gas_is_not_named(self) -> None:
        n = {k: math.nan for k in ("no2UgM3", "ozoneUgM3", "so2UgM3", "coUgM3")}
        assert elevated_gases(n) == []


class TestSource:
    def test_reads_current_and_hourly(self) -> None:
        res = _air().fetch(35.6833, 139.762, 24)
        assert res["now"]["europeanAqi"] == 62
        assert res["now"]["pm25UgM3"] == pytest.approx(28.1)
        assert len(res["hourly"]) == 3
        assert res["hourly"][0]["at"] == "2026-10-27T07:00:00Z"
        assert res["gridOffsetM"] > 0

    def test_null_gap_is_nan_not_zero(self) -> None:
        import copy

        gap = copy.deepcopy(BODY)
        cleaned = dict(gap["current"])
        for k in ("pm10", "pm2_5", "carbon_monoxide", "nitrogen_dioxide", "sulphur_dioxide", "ozone"):
            cleaned[k] = None
        gap["current"] = cleaned
        res = _air(gap).fetch(35.68, 139.76)
        assert math.isnan(res["now"]["pm25UgM3"])
        assert math.isnan(res["now"]["pm10UgM3"])

    def test_degrades_to_explicit_unknown(self) -> None:
        res = OpenMeteoAir(fetch=lambda url, timeout_s: _Res({}, status=502)).fetch(35.68, 139.76)
        assert "502" in res["degraded"]
        assert math.isnan(res["now"]["europeanAqi"])
        assert res["hourly"] == []


class TestCatalogue:
    def test_air_advertised_only_when_enabled(self) -> None:
        assert any(t.name == "get_air" for t in TOOL_CATALOG)
        caps = {"elevation": True, "weather": True, "air": True, "traffic": True, "transit": True}
        assert "get_air(lat,lon,hours)" in advertised_tools(caps)
        assert "get_air(lat,lon,hours)" not in advertised_tools({"air": False})
        assert offers_tool("get_air", {"air": True})
        assert not offers_tool("get_air", {"air": False})

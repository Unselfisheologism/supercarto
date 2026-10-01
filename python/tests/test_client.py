"""Tests for the Python client.

The parsing tests matter more than they look. The server returns prose because
a language model reads prose better than JSON, which means this client is
parsing English. Anything that changes the wording on the server side would
otherwise make these functions return None silently, and a client that returns
None for a distance is worse than one that raises.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from supercarto.client import (  # noqa: E402
    ConnectionError,
    ToolError,
    _parse_maplet,
    _parse_route,
    _parse_daylight,
    _parse_terrain,
    _parse_traffic,
    _parse_weather,
    default_server_command,
)


class TestMapletParsing:
    def test_extracts_tokens_and_source(self) -> None:
        text = "\n".join(
            [
                "# maplet @ 35.6833, 139.762 (osm-overpass)",
                "# tokens 749/1500  nodes 19  edges 34",
                "",
                "map:",
                '  center: "35.68, 139.76"',
            ]
        )
        r = _parse_maplet(text, 1500)
        assert r.tokens == 749
        assert r.fetched_from == "osm-overpass"
        assert r.yaml.startswith("map:")
        assert r.budget == 1500

    def test_collects_warnings(self) -> None:
        # Warnings matter: they say the map is partial, and a caller that drops
        # them will report a missing feature as non-existent.
        text = "\n".join(
            [
                "# maplet @ 0, 0 (pmtiles)",
                "# tokens 100/1024  nodes 5  edges 4",
                '# WARNING: layer "amenity" dropped',
                '# NOTE: source hit its feature cap',
                "",
                "map:",
            ]
        )
        r = _parse_maplet(text, 1024)
        assert len(r.warnings) == 1
        assert "amenity" in r.warnings[0]

    def test_survives_a_headerless_body(self) -> None:
        r = _parse_maplet("map:\n  center: 0,0\n", 512)
        assert r.tokens == 0
        assert r.yaml.startswith("map:")


class TestRouteParsing:
    def test_extracts_mode_distance_and_steps(self) -> None:
        text = "\n".join(
            [
                "route (walk) via osrm",
                "total: 840m, 610s",
                "",
                "1. head onto Mission St (120m)",
                "2. turn left onto 5th St (90m)",
            ]
        )
        r = _parse_route(text)
        assert r.mode == "walk"
        assert r.source == "osrm"
        assert r.distance_m == 840
        assert r.duration_s == 610
        assert len(r.steps) == 2
        assert "Mission St" in r.steps[0]

    def test_handles_an_approximate_route(self) -> None:
        # The fallback route labels itself `walk-approx`. Preserving that label
        # is what stops a caller presenting it as real turn-by-turn guidance.
        text = "\n".join(["route (walk-approx) via straight-line", "total: 100m, 74s", ""])
        r = _parse_route(text)
        assert r.mode == "walk-approx"
        assert r.source == "straight-line"


class TestWeatherParsing:
    def test_extracts_conditions(self) -> None:
        text = "\n".join(
            [
                "now: heavy rain, 8C (feels 4C), wind 12km/h",
                "precipitation: rain, 2.1mm in the last hour",
                "advisory: rain - take a jacket.",
            ]
        )
        w = _parse_weather(text)
        assert w.summary == "heavy rain"
        assert w.temp_c == 8.0
        assert w.feels_like_c == 4.0
        assert w.wind_kmh == 12.0
        assert w.precipitation == "rain"
        assert "jacket" in w.advisory

    def test_reports_no_precipitation_distinctly(self) -> None:
        # "none" and "unknown" are different facts and must not collapse.
        text = "\n".join(
            [
                "now: clear night, 23.2C (feels 26.9C), wind 4.3km/h",
                "precipitation: none falling",
            ]
        )
        w = _parse_weather(text)
        assert w.precipitation == "none"
        assert w.temp_c == 23.2


class TestTrafficParsing:
    def test_flags_a_free_flow_only_result(self) -> None:
        # This is the field that must never be ignored. A free-flow duration
        # presented as live is the single most damaging output this library
        # could produce.
        text = "\n".join(
            [
                "traffic: unknown - no flow source configured for this deployment",
                "free-flow estimate: 244s with no congestion data",
                "note: set TOMTOM_API_KEY for live conditions",
            ]
        )
        t = _parse_traffic(text)
        assert t.free_flow_only is True
        assert t.free_flow_s == 244
        assert "TOMTOM_API_KEY" in (t.unavailable or "")

    def test_reads_live_congestion(self) -> None:
        text = "\n".join(
            [
                "traffic: heavy overall, worst segment severe",
                "duration: 1500s including 900s of delay (free flow would be 600s)",
                "",
                "congested segments:",
                "  severe on I-80: 8km/h of 40km/h free flow",
            ]
        )
        t = _parse_traffic(text)
        assert t.free_flow_only is False
        assert t.level == "heavy"
        assert t.worst_level == "severe"
        assert t.duration_s == 1500
        assert t.delay_s == 900


class TestDaylightParsing:
    def test_reads_position_and_state(self) -> None:
        text = "\n".join(
            [
                "sun at 37.7700,-122.4200 on 2026-10-07T19:00:00.000Z",
                "elevation: 43.4deg",
                "azimuth: 22deg (clockwise from north)",
                "state: day",
                "needs light: no",
                "sunrise: 2026-10-07T14:18:00Z",
                "sunset: 2026-10-08T01:47:00Z",
            ]
        )
        d = _parse_daylight(text)
        assert d.elevation_deg == 43.4
        assert d.azimuth_deg == 22.0
        assert d.twilight == "day"
        assert d.needs_light is False
        assert d.sunrise == "2026-10-07T14:18:00Z"
        assert d.polar is None

    def test_reports_polar_night_without_inventing_times(self) -> None:
        # There is no honest sunrise to give here, and a fabricated one would be
        # worse than None: a caller checking `if d.sunrise` would treat an invented
        # time as real.
        text = "\n".join(
            [
                "sun at 78.2000,15.6000 on 2026-12-21T11:00:00.000Z",
                "elevation: -11.6deg",
                "azimuth: 0deg (clockwise from north)",
                "state: nautical",
                "needs light: yes",
                "polar night: the sun does not rise on this date at this latitude",
            ]
        )
        d = _parse_daylight(text)
        assert d.polar == "night"
        assert d.sunrise is None
        assert d.sunset is None
        assert d.needs_light is True
        # Not day, not night: the state a boolean would have lost.
        assert d.twilight == "nautical"

    def test_negative_elevation_is_not_swallowed(self) -> None:
        text = "\n".join(
            [
                "sun at 0.0000,0.0000 on 2026-03-20T00:00:00.000Z",
                "elevation: -48.7deg",
                "azimuth: 271deg (clockwise from north)",
                "state: night",
                "needs light: yes",
            ]
        )
        assert _parse_daylight(text).elevation_deg == -48.7


class TestTerrainParsing:
    def test_reads_the_range(self) -> None:
        text = "\n".join(
            [
                "elevation over 1000m around 37.7700,-122.4200",
                "min: 12.0m",
                "max: 340.5m",
                "range: 328.5m",
            ]
        )
        t = _parse_terrain(text)
        assert (t.min_m, t.max_m, t.range_m) == (12.0, 340.5, 328.5)

    def test_handles_a_range_below_zero(self) -> None:
        # A trench or a basin. A parser that tests truthiness would read 0.0
        # and lose the sign, which is the interesting part of the sample.
        text = "min: -40.0m\nmax: -5.0m\nrange: 35.0m"
        t = _parse_terrain(text)
        assert t.min_m == -40.0
        assert t.max_m == -5.0


class TestConnectionErrors:
    @pytest.mark.asyncio
    async def test_a_missing_binary_says_how_to_fix_it(self) -> None:
        # The most likely first-run failure. The message has to be actionable on
        # its own, because the user will not read a traceback.
        from supercarto.client import SuperCarto

        carto = SuperCarto(command=["definitely-not-a-real-binary-xyz"])
        with pytest.raises(ConnectionError) as exc:
            await carto.start()
        message = str(exc.value)
        assert "npm install -g supercarto" in message
        assert "not found" in message

    @pytest.mark.asyncio
    async def test_calling_before_start_is_a_connection_error(self) -> None:
        from supercarto.client import SuperCarto

        carto = SuperCarto()
        with pytest.raises(ConnectionError):
            await carto.maplet(0.0, 0.0)

    @pytest.mark.asyncio
    async def test_close_without_start_is_harmless(self) -> None:
        # Cleanup paths run in finally blocks, so this must not raise.
        from supercarto.client import SuperCarto

        await SuperCarto().close()


def test_default_command_prefers_an_installed_binary() -> None:
    cmd = default_server_command()
    assert cmd[-1] == "mcp"
    assert cmd[0] in ("supercarto", "npx")


def test_default_command_honours_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    # An explicit override is the escape hatch for someone with the binary in an
    # unusual place, which is common in containers.
    monkeypatch.setenv("SUPERCARTO_SERVER_CMD", "/opt/sc/bin/supercarto mcp --max-tokens 4096")
    assert default_server_command() == ["/opt/sc/bin/supercarto", "mcp", "--max-tokens", "4096"]


def test_tool_error_is_distinct_from_connection_error() -> None:
    # A tool error is usually a real answer about the world; a connection error
    # is this client's problem. Conflating them would make a retry loop hammer
    # a server that is behaving correctly.
    assert not issubclass(ToolError, ConnectionError)
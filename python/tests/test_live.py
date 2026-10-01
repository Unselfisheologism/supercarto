"""End-to-end check: the Python client against the real MCP server.

Skipped unless a built supercarto is present, since it needs Node and a live
network. It exists because the unit tests use canned text, and canned text is
exactly what hides a mismatch between what the server emits and what the client
parses.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT / "python" / "src"))

from supercarto.client import SuperCarto  # noqa: E402

SERVER = ROOT / "dist" / "cli" / "main.js"

pytestmark = pytest.mark.skipif(
    not SERVER.exists(),
    reason="supercarto is not built; run `npm run build` first",
)


@pytest.mark.asyncio
async def test_live_maplet_round_trip() -> None:
    async with SuperCarto(command=["node", str(SERVER), "mcp"]) as carto:
        result = await carto.maplet(
            lat=37.7936, lon=-122.3958, radius_m=250, budget=1024
        )

        # The budget is a promise the library keeps, so it must hold across the
        # process boundary too.
        assert result.tokens <= 1024, f"over budget: {result.tokens}"
        assert result.yaml.strip(), "empty maplet"
        assert "nodes:" in result.yaml
        assert result.fetched_from


@pytest.mark.asyncio
async def test_weather_works_without_a_key() -> None:
    # Weather needs no credential, so this must work on a bare install.
    async with SuperCarto(command=["node", str(SERVER), "mcp"]) as carto:
        tools = await carto.tools()
        assert "get_weather" in tools, f"get_weather should be on by default, got {tools}"

        w = await carto.weather(lat=35.6833, lon=139.7620, hours=3)
        assert w.summary
        assert w.advisory


@pytest.mark.asyncio
async def test_traffic_is_absent_without_a_credential() -> None:
    # The behaviour that matters: a bare install does not advertise a tool that
    # can only return a free-flow number.
    async with SuperCarto(command=["node", str(SERVER), "mcp"]) as carto:
        tools = await carto.tools()
        assert "get_traffic" not in tools
        assert "get_terrain" in tools, "elevation needs no credential either"
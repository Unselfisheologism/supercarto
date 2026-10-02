"""supercarto - LLM-native spatial middleware for Python.

A thin, dependency-free client for the supercarto MCP server.

The design decision worth knowing about: this package does not reimplement
anything. The map compilation, the token budgeting, the topology work and the
indoor graph all live in the Node library, and this speaks JSON-RPC to it over
stdio. That is deliberate, because those algorithms are the product and a second
implementation in a second language would be a second thing to keep correct.

So the shape here is: start the server, call a tool, get back text an agent can
act on.

    import asyncio
    from supercarto import SuperCarto

    async def main():
        async with SuperCarto() as carto:
            m = await carto.maplet(lat=35.6833, lon=139.7620, radius_m=400, budget=1500)
            print(m.yaml)
            print(m.tokens, "tokens")

    asyncio.run(main())
"""

from .client import (
    ConnectionError as SuperCartoConnectionError,
    DaylightResult,
    MapletResult,
    RouteResult,
    SuperCarto,
    TerrainResult,
    ToolError,
    TrafficResult,
    WeatherResult,
    default_server_command,
)

__version__ = "0.4.2"

__all__ = [
    "DaylightResult",
    "MapletResult",
    "RouteResult",
    "SuperCarto",
    "SuperCartoConnectionError",
    "TerrainResult",
    "ToolError",
    "TrafficResult",
    "WeatherResult",
    "default_server_command",
    "__version__",
]
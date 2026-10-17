"""supercarto - LLM-native spatial middleware for Python.

Two surfaces, one package:

**Native core** (no Node, no runtime dependencies): the offline compile path —
GeoJSON in, token-budgeted topological YAML out, with the same honesty
invariants as the TypeScript compiler (omission ledger, connectivity
guarantees, budget verification).

    from supercarto import compile_maplet

    with open("city.geojson") as fh:
        result = compile_maplet(fh.read(), budget=1024)
    print(result["yaml"])

**stdio client**: for live sources (Overpass/PMTiles, weather, traffic,
routing) until those are ported, this talks JSON-RPC to the Node MCP server:

    import asyncio
    from supercarto import SuperCarto

    async def main():
        async with SuperCarto() as carto:
            m = await carto.maplet(lat=35.6833, lon=139.7620, radius_m=400, budget=1500)
            print(m.yaml)

    asyncio.run(main())

The design decision worth knowing about: the algorithms are the product, and
a second implementation is a second thing to keep correct. The native core is
therefore ported stage by stage with byte-level output parity against the
TypeScript as the gate per stage (see ``scripts/parity`` in the repo).
"""

from typing import Any

from .client import (
    ConnectionError as SuperCartoConnectionError,
)
from .client import (
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
from .pipeline import compile_file, to_maplet

__version__ = "0.4.10"


def compile_maplet(geojson: str, **kwargs: Any) -> dict[str, Any]:
    """Byte-friendly wrapper around :func:`to_maplet` for a JSON string."""
    return to_maplet(geojson, kwargs or None)


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
    "__version__",
    "compile_file",
    "compile_maplet",
    "default_server_command",
    "to_maplet",
]

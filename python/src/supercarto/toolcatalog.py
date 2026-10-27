"""Tool catalogue — port of ``src/toolcatalog.ts``.

The single source of truth for what the server can do. The compiled maplet
tells the agent which tools it has, and that list used to be a hand-written
array in the compiler and drifted. So the catalogue lives here and both the
MCP surface and the compiler read from it: a tool that exists but is not
registered, or is registered but not advertised, is a failing test rather
than a wrong answer in production.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ToolDescriptor:
    #: Registered MCP tool name. Must match the name the server advertises.
    name: str
    #: How the tool is written in the maplet's ``tools:`` list.
    signature: str
    #: One line on when an agent should reach for it.
    use: str
    #: Advertising a tool that can only answer "no source configured" teaches
    #: a model to call something useless and charges it tokens for the lesson.
    requiresElevation: bool
    requiresWeather: bool
    #: Only offered when an air-quality source is configured.
    requiresAir: bool
    requiresTraffic: bool
    #: Same rule as traffic: ``get_transit`` only exists when a GTFS feed is
    #: configured, because a schedule tool with no schedule behind it would
    #: teach a model to trust a "no feed" answer that reads as "no service".
    requiresTransit: bool


TOOL_CATALOG: list[ToolDescriptor] = [
    ToolDescriptor("get_maplet", "get_maplet(lat,lon,radius,layers,budget)", "what is near this coordinate", False, False, False, False, False),
    ToolDescriptor("localize", "localize(scr,lat,lon,radius,layers,budget)", "move within an open map session; returns only what changed", False, False, False, False, False),
    ToolDescriptor("route", "route(from,to,mode)", "straight-line distance, direction, and walking feasibility between two points; verify the approach on arrival", False, False, False, False, False),
    ToolDescriptor("search_places", "search_places(lat,lon,radius,query,limit)", "find places by name or type", False, False, False, False, False),
    ToolDescriptor("expand_feature", "expand_feature(id)", "exact geometry for a feature in this maplet", False, False, False, False, False),
    ToolDescriptor("get_terrain", "get_terrain(lat,lon,radiusM,samples)", "ground elevation and slope around a coordinate", True, False, False, False, False),
    ToolDescriptor("get_weather", "get_weather(lat,lon,hours)", "current conditions and forecast, for deciding whether to go out", False, True, False, False, False),
    ToolDescriptor("get_air", "get_air(lat,lon,hours)", "air quality now and over the next hours, for deciding whether the outing is a cost", False, False, True, False, False),
    ToolDescriptor("get_traffic", "get_traffic(from,to,mode)", "congestion and realistic arrival time for a drive", False, False, False, True, False),
    ToolDescriptor("get_daylight", "get_daylight(lat,lon,at)", "sun position, sunrise, sunset, and whether a light is needed", False, False, False, False, False),
    ToolDescriptor("get_transit", "get_transit(lat,lon,radiusM,budget)", "transit stops, lines, and service times around a coordinate, from a configured GTFS feed", False, False, False, False, True),
    ToolDescriptor("get_transit_route", "get_transit_route(fromLat,fromLon,toLat,toLon,maxWalkM,budget)", "one shared ride line between two coordinates: walk to a stop, ride it, walk it off; certified against the service day, never two-line interchanges", False, False, False, False, True),
]


def all_tool_names() -> list[str]:
    return [t.name for t in TOOL_CATALOG]


#: What a deployment can actually answer.
Capabilities = dict | bool



def advertised_tools(caps: Capabilities | None = None) -> list[str]:
    """The tool lines to advertise for a given deployment.

    Weather is on by default because its source needs no credential, so an
    operator who has not configured anything still gets it. The rest are off
    until proven, because a maplet that advertises a tool the caller cannot
    use is worse than one that omits it.
    """
    c: dict
    if isinstance(caps, bool):
        c = {"elevation": caps}
    elif caps is None:
        c = {}
    else:
        c = caps
    return [t.signature for t in TOOL_CATALOG if _available(t, c)]


def offers_tool(name: str, caps: Capabilities | None = None) -> bool:
    desc = next((t for t in TOOL_CATALOG if t.name == name), None)
    if desc is None:
        return False
    c: dict
    if isinstance(caps, bool):
        c = {"elevation": caps}
    elif caps is None:
        c = {}
    else:
        c = caps
    return _available(desc, c)


def _available(t: ToolDescriptor, c: dict) -> bool:
    return not (
        (t.requiresElevation and not c.get("elevation"))
        or (t.requiresWeather and not c.get("weather"))
        or (t.requiresAir and not c.get("air"))
        or (t.requiresTraffic and not c.get("traffic"))
        or (t.requiresTransit and not c.get("transit"))
    )

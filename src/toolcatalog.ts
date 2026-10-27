/**
 * Tool catalogue: the single source of truth for what the server can do.
 *
 * The compiled maplet tells the agent which tools it has, and that list used to
 * be a hand-written array in the compiler. It drifted: it advertised
 * `expand_node` and `get_place`, neither of which has ever existed as an MCP
 * tool, while omitting `search_places`, which does. An agent following those
 * instructions would call tools that are not there and never learn about the
 * ones that are - a failure that is invisible in testing and fatal in use.
 *
 * So the catalogue lives here and both the MCP surface and the compiler read
 * from it. A tool that exists but is not registered, or is registered but not
 * advertised, is now a failing test rather than a wrong answer in production.
 *
 * The compiler deliberately does not import the MCP server: a compiled maplet
 * is also produced by the CLI and the HTTP API, which have no MCP transport.
 * This module is dependency-free so any of them can depend on it.
 */

export interface ToolDescriptor {
  /** Registered MCP tool name. Must match the name the server advertises. */
  name: string;
  /** How the tool is written in the maplet's `tools:` list. */
  signature: string;
  /** One line on when an agent should reach for it. */
  use: string;
  /**
   * Only offered when the capability is configured.
   *
   * Advertising a tool that can only answer "no source configured" teaches a
   * model to call something useless and charges it tokens for the lesson. It is
   * worse than that for traffic, where the fallback answer is a plausible-looking
   * ETA that ignores congestion entirely.
   */
  requiresElevation: boolean;
  requiresWeather: boolean;
  /** Only offered when an air-quality source is configured. */
  requiresAir: boolean;
  requiresTraffic: boolean;
  /**
   * Same rule as traffic, one layer earlier: `get_transit` only exists when a
   * GTFS feed is configured. Advertising a schedule tool with no schedule
   * behind it teaches a model to trust a "no feed" answer that looks like
   * "no service", which is an honest-refusal design turned into a lie.
   */
  requiresTransit: boolean;
}

export const TOOL_CATALOG: readonly ToolDescriptor[] = [
  {
    name: 'get_maplet',
    signature: 'get_maplet(lat,lon,radius,layers,budget)',
    use: 'what is near this coordinate',
    requiresElevation: false,
    requiresWeather: false,
    requiresAir: false,
    requiresTraffic: false,
    requiresTransit: false,
  },
  {
    name: 'localize',
    signature: 'localize(scr,lat,lon,radius,layers,budget)',
    use: 'move within an open map session; returns only what changed',
    requiresElevation: false,
    requiresWeather: false,
    requiresAir: false,
    requiresTraffic: false,
    requiresTransit: false,
  },
  {
    name: 'route',
    signature: 'route(from,to,mode)',
    use: 'straight-line distance, direction, and walking feasibility between two points; verify the approach on arrival',
    requiresElevation: false,
    requiresWeather: false,
    requiresAir: false,
    requiresTraffic: false,
    requiresTransit: false,
  },
  {
    name: 'search_places',
    signature: 'search_places(lat,lon,radius,query,limit)',
    use: 'find places by name or type',
    requiresElevation: false,
    requiresWeather: false,
    requiresAir: false,
    requiresTraffic: false,
    requiresTransit: false,
  },
  {
    name: 'expand_feature',
    signature: 'expand_feature(id)',
    use: 'exact geometry for a feature in this maplet',
    requiresElevation: false,
    requiresWeather: false,
    requiresAir: false,
    requiresTraffic: false,
    requiresTransit: false,
  },
  {
    name: 'get_terrain',
    signature: 'get_terrain(lat,lon,radiusM,samples)',
    use: 'ground elevation and slope around a coordinate',
    requiresElevation: true,
    requiresWeather: false,
    requiresAir: false,
    requiresTraffic: false,
    requiresTransit: false,
  },
  {
    name: 'get_weather',
    signature: 'get_weather(lat,lon,hours)',
    use: 'current conditions and forecast, for deciding whether to go out',
    requiresElevation: false,
    requiresWeather: true,
    requiresAir: false,
    requiresTraffic: false,
    requiresTransit: false,
  },
  {
    name: 'get_air',
    signature: 'get_air(lat,lon,hours)',
    use: 'air quality now and over the next hours, for deciding whether the outing is a cost',
    requiresElevation: false,
    requiresWeather: false,
    requiresAir: true,
    requiresTraffic: false,
    requiresTransit: false,
  },
  {
    name: 'get_traffic',
    signature: 'get_traffic(from,to,mode)',
    use: 'congestion and realistic arrival time for a drive',
    requiresElevation: false,
    requiresWeather: false,
    requiresAir: false,
    requiresTraffic: true,
    requiresTransit: false,
  },
  {
    name: 'get_transit',
    signature: 'get_transit(lat,lon,radiusM,budget)',
    use: 'transit stops, lines, and service times around a coordinate, from a configured GTFS feed',
    requiresElevation: false,
    requiresWeather: false,
    requiresAir: false,
    requiresTraffic: false,
    requiresTransit: true,
  },
  {
    name: 'get_transit_route',
    signature: 'get_transit_route(fromLat,fromLon,toLat,toLon,maxWalkM,budget)',
    use: 'one shared ride line between two coordinates: walk to a stop, ride it, walk it off; certified against the service day, never two-line interchanges',
    requiresElevation: false,
    requiresWeather: false,
    requiresAir: false,
    requiresTraffic: false,
    requiresTransit: true,
  },
  {
    name: 'get_daylight',
    signature: 'get_daylight(lat,lon,at)',
    use: 'sun position, sunrise, sunset, and whether a light is needed',
    requiresElevation: false,
    requiresWeather: false,
    requiresAir: false,
    requiresTraffic: false,
    requiresTransit: false,
  },
];

/** Names of every tool, regardless of whether this deployment offers it. */
export function allToolNames(): string[] {
  return TOOL_CATALOG.map((t) => t.name);
}

/** What a deployment can actually answer. */
export interface Capabilities {
  elevation?: boolean;
  weather?: boolean;
  air?: boolean;
  traffic?: boolean;
  transit?: boolean;
}

/**
 * The tool lines to advertise for a given deployment.
 *
 * Weather is on by default because its source needs no credential, so an
 * operator who has not configured anything still gets it. The rest are off
 * until proven, because a maplet that advertises a tool the caller cannot use is
 * worse than one that omits it.
 */
export function advertisedTools(caps: Capabilities | boolean = {}): string[] {
  const c: Capabilities = typeof caps === 'boolean' ? { elevation: caps } : caps;
  return TOOL_CATALOG.filter((t) => available(t, c)).map((t) => t.signature);
}

/** Whether this deployment offers a named tool. */
export function offersTool(name: string, caps: Capabilities | boolean = {}): boolean {
  const t = TOOL_CATALOG.find((x) => x.name === name);
  if (!t) return false;
  return available(t, typeof caps === 'boolean' ? { elevation: caps } : caps);
}

function available(t: ToolDescriptor, c: Capabilities): boolean {
  if (t.requiresElevation && !c.elevation) return false;
  if (t.requiresWeather && !c.weather) return false;
  if (t.requiresAir && !c.air) return false;
  if (t.requiresTraffic && !c.traffic) return false;
  if (t.requiresTransit && !c.transit) return false;
  return true;
}
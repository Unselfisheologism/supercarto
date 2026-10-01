import { SuperCarto, type MapletRequestLive } from '../live.js';
import { bboxAround, normalizeBbox } from '../source/types.js';
import { describeCode } from '../source/weather.js';
import { sunPosition, needsLight } from '../source/sun.js';
import { straightLineRoute, type TravelMode } from '../source/routing.js';
import { estimateTokens } from '../emit/yaml.js';
import { fromScr } from '../pipeline.js';
import { encodeDocument } from '../wire/encode.js';
import { ScrError } from '../wire/errors.js';
import type { Feature } from '../wire/types.js';
import { allToolNames, offersTool, type Capabilities } from '../toolcatalog.js';

/**
 * MCP tool surface.
 *
 * The JSON-RPC plumbing is written directly against the Model Context Protocol
 * rather than pulled from a dependency, because the tool set is small and the
 * protocol is a stable, well-documented shape. Everything the server actually
 * does lives in `SuperCarto`; this file is transport and schemas.
 *
 * Served over stdio, which is how MCP clients launch local servers.
 */

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface McpServerOptions {
  carto?: SuperCarto;
  /** Cap on a single response, to protect the agent's context. Default 8192. */
  maxTokens?: number;
}

/**
 * Tool definitions, exposed so they can be inspected and tested.
 *
 * `get_terrain` is only included when an elevation source is configured. A tool
 * listed in `tools/list` that can only ever answer "no terrain source
 * configured" teaches a model to call something useless and charges it tokens
 * for the lesson.
 */
export function defineTools(carto: SuperCarto, maxTokens: number): McpTool[] {
  const tools: McpTool[] = [
    {
      name: 'get_maplet',
      description:
        'Fetch real map data around a coordinate and return a token-budgeted ' +
        'topological graph: named places joined by walkable edges with ' +
        'distances in metres and compass directions. Use this to answer ' +
        "'what is near X' and 'how do I get from A to B'. Omissions are " +
        'reported, so treat a missing feature as not-shown rather than absent.',
      inputSchema: {
        type: 'object',
        properties: {
          lat: { type: 'number', description: 'Latitude in WGS84 degrees.' },
          lon: { type: 'number', description: 'Longitude in WGS84 degrees.' },
          radiusM: {
            type: 'number',
            description: 'Radius in metres. Default 300. Larger costs more tokens.',
            default: 300,
          },
          layers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Semantic layers to include, e.g. ["road", "poi"]. Default all.',
          },
          budget: {
            type: 'number',
            description: `Token budget for the response. Default 1024, hard cap ${maxTokens}.`,
            default: 1024,
          },
        },
        required: ['lat', 'lon'],
      },
      handler: async (args) => {
        const budget = clampBudget(args.budget, 1024, maxTokens);
        const result = await carto.maplet({
          lat: requireNumber(args, 'lat'),
          lon: requireNumber(args, 'lon'),
          radiusM: optionalNumber(args, 'radiusM', 300),
          layers: stringArray(args.layers),
          budget,
        });

        const yaml = trimToBudget(result.yaml, budget);
        const header = [
          `# maplet @ ${result.graph.meta.center} (${result.fetchedFrom})`,
          `# tokens ${estimateTokens(yaml)}/${budget}  nodes ${result.graph.nodes.length}  edges ${result.graph.edges.length}`,
        ];
        if (result.sourceTruncated) {
          header.push('# NOTE: source hit its feature cap; this area is denser than the cap allows.');
        }
        for (const w of result.warnings) header.push(`# WARNING: ${w}`);
        return text([...header, '', yaml].join('\n'));
      },
    },

    {
      name: 'route',
      description:
        'Get turn-by-turn directions between two coordinates. Returns prose ' +
        'instructions, which are far more reliable for an agent to follow than ' +
        'raw geometry. Falls back to a clearly-labelled approximation when no ' +
        'routing engine is reachable.',
      inputSchema: {
        type: 'object',
        properties: {
          fromLat: { type: 'number' },
          fromLon: { type: 'number' },
          toLat: { type: 'number' },
          toLon: { type: 'number' },
          mode: { type: 'string', enum: ['walk', 'bike', 'drive'], default: 'walk' },
        },
        required: ['fromLat', 'fromLon', 'toLat', 'toLon'],
      },
      handler: async (args) => {
        const req = {
          from: { lat: requireNumber(args, 'fromLat'), lon: requireNumber(args, 'fromLon') },
          to: { lat: requireNumber(args, 'toLat'), lon: requireNumber(args, 'toLon') },
          mode: (typeof args.mode === 'string' ? args.mode : 'walk') as TravelMode,
        };
        const res = await carto.route(req);
        const lines = [
          `route (${res.route.mode}) via ${res.source}`,
          `total: ${res.route.dist ?? '?'}m, ${res.route.time ?? '?'}s`,
          '',
        ];
        for (const s of res.route.steps) {
          lines.push(`${s.n}. ${s.instruction}${s.dist !== undefined ? ` (${s.dist}m)` : ''}`);
        }
        return text(lines.join('\n'));
      },
    },

    {
      name: 'search_places',
      description:
        'Find named places (cafes, stations, shops) near a coordinate. Cheaper ' +
        'than get_maplet when only names are needed.',
      inputSchema: {
        type: 'object',
        properties: {
          lat: { type: 'number' },
          lon: { type: 'number' },
          radiusM: { type: 'number', default: 300 },
          query: { type: 'string', description: 'Substring match on place name or type.' },
          limit: { type: 'number', default: 20 },
        },
        required: ['lat', 'lon'],
      },
      handler: async (args) => {
        const limit = optionalNumber(args, 'limit', 20);
        const result = await carto.maplet({
          lat: requireNumber(args, 'lat'),
          lon: requireNumber(args, 'lon'),
          radiusM: optionalNumber(args, 'radiusM', 300),
          budget: Math.min(maxTokens, 2048),
        });
        const q = typeof args.query === 'string' ? args.query.toLowerCase() : undefined;
        const named = result.graph.nodes
          .filter((n) => n.name !== undefined)
          .filter((n) => {
            if (!q) return true;
            const hay = `${n.name} ${(n.tags ?? []).join(' ')}`.toLowerCase();
            return hay.includes(q);
          })
          .slice(0, limit);

        if (named.length === 0) {
          return text('no named places matched in this area');
        }
        const lines = [`${named.length} place(s):`];
        for (const n of named) {
          const tags = n.tags?.length ? `, ${n.tags.join(', ')}` : '';
          lines.push(`- ${n.name} [${n.kind}${tags}]`);
        }
        if (result.graph.omitted.length > 0) {
          const note = result.graph.omitted
            .map((o) => `${o.count} ${o.layer} omitted`)
            .join('; ');
          lines.push('', `note: ${note}`);
        }
        return text(lines.join('\n'));
      },
    },

    {
      name: 'expand_feature',
      description:
        'Fetch the exact geometry of features by id, as WKT. Use only when ' +
        'shape matters, such as checking whether a route clears a building.',
      inputSchema: {
        type: 'object',
        properties: {
          scr: { type: 'string', description: 'SCR document from a previous get_maplet.' },
          ids: { type: 'array', items: { type: 'number' } },
        },
        required: ['scr', 'ids'],
      },
      handler: async (args) => {
        const scr = typeof args.scr === 'string' ? args.scr : '';
        const ids = numberArray(args.ids);
        let parsed;
        try {
          parsed = fromScr(scr, { budget: 64 }).doc;
        } catch (err) {
          return error(`could not parse SCR: ${err instanceof Error ? err.message : String(err)}`);
        }
        const wanted = new Set(ids);
        const out: string[] = [];
        for (const f of parsed.features) {
          if (wanted.size > 0 && !wanted.has(f.id)) continue;
          const wkt = toWkt(f);
          if (wkt) out.push(`${f.id}: ${wkt}`);
        }
        if (out.length === 0) {
          return error(
            wanted.size === 0
              ? 'no features in this document'
              : `no features with ids [${ids.join(', ')}]`,
          );
        }
        return text(out.join('\n'));
      },
    },
  ];

  if (carto.hasElevation) tools.push(getTerrainTool(carto));
  if (carto.hasWeather) tools.push(getWeatherTool(carto));
  if (carto.hasTraffic) tools.push(getTrafficTool(carto));
  // Daylight needs no source and no credential, so it is unconditional.
  tools.push(getDaylightTool());
  // A maplet advertises its tools from the same catalogue, so a tool served
  // here but missing from the catalogue would be invisible to every agent.
  assertToolsMatchCatalog(tools, carto);
  return tools;
}

/**
 * Assert the surface matches the catalogue.
 *
 * The catalogue drives what a compiled maplet tells the agent it can call, so a
 * tool registered here but missing from the catalogue (or vice versa) would
 * advertise a capability that does not exist. This is a cheap invariant that
 * would otherwise only fail in production, in front of an agent that believed
 * the maplet.
 */
export function assertToolsMatchCatalog(tools: McpTool[], carto?: SuperCarto): void {
  const caps = capabilitiesOf(carto);
  const served = tools.map((t) => t.name).sort();
  const expected = allToolNames().filter((n) => offersTool(n, caps)).sort();
  const unknown = served.filter((n) => !allToolNames().includes(n));
  if (unknown.length > 0) {
    throw new Error(
      `MCP server registers tool(s) absent from the catalogue: ${unknown.join(', ')}. ` +
        `Add them to TOOL_CATALOG or a compiled maplet will not advertise them.`,
    );
  }
  if (served.join(',') !== expected.join(',')) {
    throw new Error(
      `MCP tool surface has drifted from the tool catalogue: ` +
        `served [${served.join(', ')}] but expected [${expected.join(', ')}]`,
    );
  }
}

/**
 * What this deployment can answer.
 *
 * Weather is reported as available whenever a source is configured, which is the
 * default. An explicit `false` on the capability is honoured so a test can pin
 * the surface to a known set.
 */
function capabilitiesOf(carto: SuperCarto | undefined, override?: Partial<Capabilities>) {
  const base: Capabilities = {
    elevation: carto?.hasElevation ?? false,
    weather: carto?.hasWeather ?? true,
    traffic: carto?.hasTraffic ?? false,
  };
  return { ...base, ...override };
}

/** Ground elevation sampling, offered only when an elevation source exists. */
function getTerrainTool(carto: SuperCarto): McpTool {
  return {
    name: 'get_terrain',
    description:
      'Sample ground elevation around a coordinate, in metres. Returns the ' +
      'range plus high and low points, which is what an agent needs for ' +
      'grade reasoning.',
    inputSchema: {
      type: 'object',
      properties: {
        lat: { type: 'number' },
        lon: { type: 'number' },
        radiusM: { type: 'number', default: 1000 },
        samples: { type: 'number', default: 16 },
      },
      required: ['lat', 'lon'],
    },
    handler: async (args) => {
      const lat = requireNumber(args, 'lat');
      const lon = requireNumber(args, 'lon');
      const radiusM = optionalNumber(args, 'radiusM', 1000);
      const res = optionalNumber(args, 'samples', 16);

      let grid;
      try {
        grid = await carto.elevationFor(normalizeBbox(bboxAround(lat, lon, radiusM)), res);
      } catch (err) {
        return error(
          `elevation source failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!grid) return error('terrain source returned no data for this area');

      const values = Array.from(grid.values).filter((v) => Number.isFinite(v));
      if (values.length === 0) return error('terrain source returned no usable samples');
      values.sort((a, b) => a - b);
      const lo = values[0]!;
      const hi = values[values.length - 1]!;

      return text(
        [
          `elevation over ${radiusM}m around ${lat.toFixed(4)},${lon.toFixed(4)}`,
          `min: ${lo.toFixed(1)}m`,
          `max: ${hi.toFixed(1)}m`,
          `range: ${(hi - lo).toFixed(1)}m`,
          '',
          'Note: elevation is relative to sea level, and the source may be coarse at this radius.',
        ].join('\n'),
      );
    },
  };
}

/**
 * Sun position and daylight.
 *
 * Offers a three-state answer rather than a single "is it dark" flag, because
 * the three lead to different advice: full daylight, twilight where a light is
 * wanted but walking is fine, and night. Collapsing them to a boolean makes an
 * agent warn someone about a 6am walk in June, or send them out unlit at dusk.
 *
 * Needs no credentials and no network, so it is always available.
 */
function getDaylightTool(): McpTool {
  return {
    name: 'get_daylight',
    description:
      'Sun position, sunrise, sunset, and twilight state for a coordinate. ' +
      'Twilight is reported as day, civil, nautical, or night rather than a ' +
      'boolean, because "needs a torch" and "cannot see" are different states.',
    inputSchema: {
      type: 'object',
      properties: {
        lat: { type: 'number' },
        lon: { type: 'number' },
        at: {
          type: 'string',
          description: 'ISO 8601 instant. Defaults to now. Times are UTC.',
        },
      },
      required: ['lat', 'lon'],
    },
    handler: async (args) => {
      const lat = requireNumber(args, 'lat');
      const lon = requireNumber(args, 'lon');

      const atArg = args?.at;
      let at = new Date();
      if (typeof atArg === 'string' && atArg.length > 0) {
        at = new Date(atArg);
        if (Number.isNaN(at.getTime())) {
          return error(`could not read "${atArg}" as an ISO 8601 instant`);
        }
      }

      const sun = sunPosition(lat, lon, at);

      const lines = [
        `sun at ${lat.toFixed(4)},${lon.toFixed(4)} on ${at.toISOString()}`,
        `elevation: ${sun.elevationDeg.toFixed(1)}deg`,
        `azimuth: ${sun.azimuthDeg.toFixed(0)}deg (clockwise from north)`,
        `state: ${sun.twilight}`,
        `needs light: ${needsLight(sun) ? 'yes' : 'no'}`,
      ];

      if (sun.polar === 'night') {
        // No sunrise or sunset to report, and saying so is the whole answer.
        lines.push('polar night: the sun does not rise on this date at this latitude');
      } else if (sun.polar === 'day') {
        lines.push('polar day: the sun does not set on this date at this latitude');
      } else {
        lines.push(`sunrise: ${sun.sunrise ?? 'unknown'}`);
        lines.push(`sunset: ${sun.sunset ?? 'unknown'}`);
      }

      return text(lines.join('\n'));
    },
  };
}

/**
 * Current conditions and forecast.
 *
 * Prose rather than a table, for the same reason routing is: a model reads
 * "heavy rain, 8C, take the bus" reliably and reads the same information as
 * twelve numeric fields unreliably. The advisory line at the end is the part
 * that changes a decision, so it is stated in words the model will repeat
 * rather than left for it to infer from a temperature.
 */
function getWeatherTool(carto: SuperCarto): McpTool {
  return {
    name: 'get_weather',
    description:
      'Current weather conditions and a short forecast at a coordinate. ' +
      'Use this before telling someone to walk, cycle, or drive, or to pick ' +
      'between an indoor and outdoor option. Reports what is actually falling ' +
      '(rain, snow, sleet) rather than only a temperature.',
    inputSchema: {
      type: 'object',
      properties: {
        lat: { type: 'number' },
        lon: { type: 'number' },
        hours: {
          type: 'number',
          default: 12,
          description: 'Forecast horizon in hours. Default 12, max 48.',
        },
      },
      required: ['lat', 'lon'],
    },
    handler: async (args) => {
      const lat = requireNumber(args, 'lat');
      const lon = requireNumber(args, 'lon');
      const hours = Math.max(1, Math.min(48, optionalNumber(args, 'hours', 12)));

      const w = await carto.weatherAt(lat, lon, hours);
      if (!w) return error('weather is not configured for this deployment');

      if (w.degraded) {
        // Explicitly not a successful answer. Returning conditions here would be
        // the one genuinely dangerous failure in this library: an agent handed
        // zeroes concludes it is safe to cycle, and it is not.
        return error(`weather unavailable: ${w.degraded}`);
      }

      const n = w.now;
      const lines: string[] = [];
      lines.push(
        `now: ${n.summary}, ${fmt(n.tempC)}C (feels ${fmt(n.feelsLikeC)}C), ` +
          `wind ${fmt(n.windKmh)}km/h`,
      );
      if (n.precipitation !== 'none') {
        lines.push(`precipitation: ${n.precipitation}, ${fmt(n.precipitationMm)}mm in the last hour`);
      } else {
        lines.push('precipitation: none falling');
      }
      if (n.gustKmh > n.windKmh * 1.4) {
        lines.push(`gusting to ${fmt(n.gustKmh)}km/h`);
      }
      if (Number.isFinite(n.visibilityM) && n.visibilityM < 2000) {
        lines.push(`visibility ${Math.round(n.visibilityM)}m - poor`);
      }
      if (w.gridOffsetM > 2000) {
        lines.push(`note: forecast grid point is ${w.gridOffsetM}m from the requested point`);
      }

      const wet = w.hourly.filter((h) => h.precipitation !== 'none');
      if (wet.length > 0) {
        const first = wet[0]!;
        lines.push('', `precipitation expected from ${first.at} (${first.precipitation})`);
        for (const h of wet.slice(0, 4)) {
          lines.push(`  ${h.at}  ${fmt(h.tempC)}C  ${h.precipitation} ${fmt(h.precipitationMm)}mm`);
        }
        if (wet.length > 4) lines.push(`  ...and ${wet.length - 4} more wet hours`);
      } else {
        lines.push('', 'no precipitation expected in the forecast window');
      }

      if (w.daily.length > 0) {
        const d = w.daily[0]!;
        lines.push(
          `today: ${describeCode(d.code)} ${fmt(d.tempMinC)}C to ${fmt(d.tempMaxC)}C, ` +
            `${fmt(d.precipitationMm)}mm`,
        );
      }

      lines.push('', advisory(n.precipitation, n.tempC, n.windKmh));
      return text(lines.join('\n'));
    },
  };
}

/**
 * Congestion and arrival time.
 *
 * The advisory exists because the number alone is not actionable. "18 minutes"
 * tells a person nothing about whether to leave now; "light traffic, arrive
 * about 18:42" does.
 */
function getTrafficTool(carto: SuperCarto): McpTool {
  return {
    name: 'get_traffic',
    description:
      'Live traffic congestion and a realistic arrival time between two ' +
      'coordinates. Reports the worst segment on the route, not just an ' +
      'average, because one blocked junction is what makes someone late.',
    inputSchema: {
      type: 'object',
      properties: {
        fromLat: { type: 'number' },
        fromLon: { type: 'number' },
        toLat: { type: 'number' },
        toLon: { type: 'number' },
        mode: { type: 'string', enum: ['drive'], default: 'drive' },
      },
      required: ['fromLat', 'fromLon', 'toLat', 'toLon'],
    },
    handler: async (args) => {
      const res = await carto.routeWithTraffic({
        from: { lat: requireNumber(args, 'fromLat'), lon: requireNumber(args, 'fromLon') },
        to: { lat: requireNumber(args, 'toLat'), lon: requireNumber(args, 'toLon') },
        mode: 'drive',
      });

      const lines: string[] = [];
      if (res.freeFlowOnly) {
        // Never present free flow as live. Say so, give the number, and say what
        // it is.
        lines.push('traffic: unknown - no flow source configured for this deployment');
        lines.push(`free-flow estimate: ${res.freeFlowS}s with no congestion data`);
        lines.push(`note: ${res.unavailable ?? 'live traffic unavailable'}`);
        return text(lines.join('\n'));
      }

      lines.push(`traffic: ${res.level} overall, worst segment ${res.worstLevel}`);
      lines.push(
        `duration: ${res.durationS}s including ${res.delayS}s of delay ` +
          `(free flow would be ${res.freeFlowS}s)`,
      );

      const congested = res.segments
        .filter((s) => s.level === 'severe' || s.level === 'heavy')
        .slice(0, 5);
      if (congested.length > 0) {
        lines.push('', 'congested segments:');
        for (const s of congested) {
          const where = s.road ? ` on ${s.road}` : '';
          lines.push(
            `  ${s.level}${where}: ${fmt(s.speedKmh)}km/h of ${fmt(s.freeFlowKmh)}km/h free flow`,
          );
        }
      }
      lines.push('', `source: ${res.source}`);
      return text(lines.join('\n'));
    },
  };
}

/**
 * A recommendation, in the vocabulary of the decision.
 *
 * Thresholds are about what changes a person's behaviour rather than about
 * meteorological neatness. Wind matters for cycling and not for a bus; rain
 * matters for a walk and barely for a car.
 */
function advisory(precipitation: string, tempC: number, windKmh: number): string {
  if (precipitation === 'snow' || precipitation === 'sleet') {
    return 'advisory: snow or sleet - expect longer journey times and check for disruption before leaving.';
  }
  if (precipitation === 'hail') {
    return 'advisory: thunderstorm with hail - staying indoors is the safe choice.';
  }
  if (precipitation === 'rain' || precipitation === 'drizzle') {
    const cold = Number.isFinite(tempC) && tempC <= 3;
    if (cold) {
      return 'advisory: rain and near freezing - surfaces will be icy, allow much longer on foot.';
    }
    return 'advisory: rain - take a jacket, and expect a slower drive than usual.';
  }
  if (Number.isFinite(windKmh) && windKmh >= 40) {
    return 'advisory: strong wind - cycling and walking exposed routes will be unpleasant.';
  }
  if (Number.isFinite(tempC) && tempC <= 0) {
    return 'advisory: below freezing - icy surfaces, allow extra time.';
  }
  return 'advisory: nothing that should change an outdoor plan.';
}

function fmt(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '?';
  return String(Math.round(v * 10) / 10);
}

/**
 * Convert a feature to WKT, in its own quantized grid coordinates.
 *
 * Grid coordinates rather than lon/lat are deliberate: the point of
 * `expand_feature` is exact machine geometry, and the grid is what the rest of
 * the system uses. The envelope in the document converts it if a consumer
 * needs WGS84.
 */
function toWkt(f: Feature): string {
  const g = f.geometry;
  const pt = (p: { x: number; y: number }) => `${p.x} ${p.y}`;
  switch (g.kind) {
    case 'point':
      return `POINT(${pt(g.point)})`;
    case 'line':
      return `LINESTRING(${g.lines[0]?.map(pt).join(', ') ?? ''})`;
    case 'polygon':
    case 'building': {
      const ring = g.polygon[0]?.rings[0];
      return `POLYGON((${ring?.map(pt).join(', ') ?? ''}))`;
    }
  }
}

function text(t: string): ToolResult {
  return { content: [{ type: 'text', text: t }] };
}

function error(t: string): ToolResult {
  return { content: [{ type: 'text', text: `error: ${t}` }], isError: true };
}

function requireNumber(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`missing or invalid "${key}"`);
  }
  return v;
}

function optionalNumber(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string');
}

function numberArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is number => typeof x === 'number');
}

function clampBudget(v: unknown, fallback: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(64, Math.min(max, Math.round(v)));
}

/**
 * Hard-trim a YAML document to a token budget.
 *
 * The budgeter already fits the graph, so this is a backstop for the case where
 * a header or warning pushes the total over. Truncating mid-line would produce
 * invalid YAML, so lines are dropped whole and the cut is disclosed.
 */
function trimToBudget(yaml: string, budget: number): string {
  if (estimateTokens(yaml) <= budget) return yaml;
  const out: string[] = [];
  let used = 0;
  for (const line of yaml.split('\n')) {
    const cost = estimateTokens(line) + 1;
    if (used + cost > budget) {
      out.push(`# [truncated at ${budget} tokens; request a larger budget for the rest]`);
      break;
    }
    out.push(line);
    used += cost;
  }
  return out.join('\n');
}

export { straightLineRoute, encodeDocument, ScrError };
export type { MapletRequestLive };
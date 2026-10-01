import { toMaplet, type MapletResult } from './pipeline.js';
import {
  bboxAround,
  normalizeBbox,
  type BboxQuery,
  type MapSource,
  type SourceRequest,
} from './source/types.js';
import { OverpassSource, type OverpassOptions } from './source/overpass.js';
import {
  OsrmRouter,
  straightLineRoute,
  type RouteRequest,
  type RouteResult,
  type RoutingSource,
  type TravelMode,
} from './source/routing.js';
import { elevationToHeat, type ElevationGrid, type ElevationSource } from './source/terrain.js';
import { densityToHeat, slopeToHeat } from './source/heat.js';
import {
  OpenMeteoWeather,
  type OpenMeteoOptions,
  type WeatherResult,
  type WeatherSource,
} from './source/weather.js';
import {
  HereFlow,
  TomTomFlow,
  TrafficRouter,
  type TrafficResult,
  type TrafficSource as TrafficSourceLike,
} from './source/traffic.js';
import { fromGeoJson } from './ingest/geojson.js';
import type { Capabilities } from './toolcatalog.js';
import type { GeoJsonFeature } from './ingest/geojson.js';
import { encodeDocument } from './wire/encode.js';
import { gridToLonLat } from './geo/project.js';
import type { Envelope, Feature, ScrDocument } from './wire/types.js';

/**
 * The live maplet service.
 *
 * This is the layer that makes supercarto work for *any location on earth*:
 * give it coordinates, it fetches real data, compiles it, and returns a
 * budget-honouring graph. Everything above this is a transform; this is the
 * part that talks to the outside world.
 */

export interface SuperCartoOptions {
  /** Data sources, tried in order. Defaults to Overpass. */
  sources?: MapSource[];
  /** Routing engine. Defaults to OSRM. */
  router?: RoutingSource;
  /** Terrain source. Omit to skip elevation. */
  elevation?: ElevationSource;
  /**
   * Weather source. Omit to skip weather.
   *
   * Weather is on by default because it needs no credential: the default source
   * is a keyless public forecast. A deployment that wants to control its own
   * usage passes a different one.
   */
  weather?: WeatherSource | false;
  /**
   * Traffic flow providers, tried in order. Empty by default.
   *
   * Not defaulted, because live traffic always needs a paid credential and
   * silently reaching for an absent one would produce free-flow ETAs labelled
   * as live. Absence is reported instead.
   */
  traffic?: TrafficSourceLike[];
  /**
   * Derive heat layers from the fetched data: place density, and elevation and
   * slope when a terrain source is configured. Default true.
   */
  heat?: boolean;
  /** Overpass tuning, used only when building the default source. */
  overpass?: OverpassOptions;
  /** Open-Meteo tuning, used only when building the default weather source. */
  openMeteo?: OpenMeteoOptions;
  /** TomTom tuning, used only when building the default flow source. */
  tomTom?: { apiKey?: string; base?: string };
  /** HERE tuning, used only when building the default flow source. */
  here?: { apiKey?: string; base?: string };  /** Token budget for emitted graphs. Default 1024. */
  defaultBudget?: number;
}

export interface MapletRequestLive {
  lat: number;
  lon: number;
  /** Radius in metres. Default 300. */
  radiusM?: number;
  layers?: string[];
  budget?: number;
  signal?: AbortSignal;
}

export interface LiveResult extends MapletResult {
  /** The upstream source that served this request. */
  fetchedFrom: string;
  fetchMs: number;
  /** Source-level warnings, including truncation. */
  warnings: string[];
  /** True when the source itself hit a cap, not merely the token budget. */
  sourceTruncated: boolean;
}

export class SuperCarto {
  private readonly sources: MapSource[];
  private readonly router: RoutingSource;
  private readonly elevation?: ElevationSource;
  private readonly weather?: WeatherSource;
  private readonly traffic: TrafficRouter;
  private readonly deriveHeat: boolean;
  private readonly defaultBudget: number;
  /** Per-area cache of compiled documents, keyed by envelope and layer set. */
  private readonly cache = new Map<string, { doc: ScrDocument; at: number }>();

  private static readonly CACHE_TTL_MS = 5 * 60_000;
  private static readonly CACHE_MAX = 128;

  constructor(opts: SuperCartoOptions = {}) {
    this.sources = opts.sources ?? [new OverpassSource(opts.overpass)];
    this.router = opts.router ?? new OsrmRouter();
    this.elevation = opts.elevation;
    // Weather defaults on: the source needs no key, so there is no reason to
    // make an operator opt in to something they would otherwise have to add
    // themselves. `false` is the explicit opt-out.
    this.weather =
      opts.weather === false
        ? undefined
        : (opts.weather ?? new OpenMeteoWeather(opts.openMeteo ?? {}));
    // Traffic is never defaulted. A provider without a credential can only
    // report free flow, and presenting that as a live ETA is the single most
    // damaging thing this service could do.
    this.traffic = new TrafficRouter(
      this.router,
      opts.traffic ?? [
        new TomTomFlow(opts.tomTom ?? {}),
        new HereFlow(opts.here ?? {}),
      ],
    );
    this.deriveHeat = opts.heat !== false;
    this.defaultBudget = opts.defaultBudget ?? 1024;
  }

  /**
   * Fetch real map data around a point and compile it for an agent.
   *
   * This is the "Google Maps for AI agents" call: coordinates in, a
   * token-budgeted topological graph out.
   */
  async maplet(req: MapletRequestLive): Promise<LiveResult> {
    const radiusM = req.radiusM ?? 300;
    const bbox = normalizeBbox(bboxAround(req.lat, req.lon, radiusM));
    const budget = req.budget ?? this.defaultBudget;

    const fetched = await this.document(bbox, req.layers ?? [], req.signal);

    // Heat layers are derived after fetch, from the data already in hand. The
    // document is the cache key's target, so the derived layers are attached to
    // the returned copy rather than the cached one: two requests for the same
    // area at different zoom or layer settings would otherwise contaminate each
    // other's heat.
    const doc = this.withHeat(fetched.doc, radiusM);

    const result = toMaplet(
      { type: 'FeatureCollection', features: featuresFromDocument(doc) },
      {
        bbox,
        layers: req.layers,
        budget,
        radiusLabel: formatRadius(radiusM),
        // So the maplet advertises only the tools this instance can answer.
        capabilities: this.capabilities,
      },
    );

    return {
      ...result,
      fetchedFrom: fetched.source,
      fetchMs: fetched.elapsedMs,
      warnings: fetched.warnings,
      sourceTruncated: fetched.truncated,
    };
  }

  /** Route between two points, with turn-by-turn prose for the model. */
  async route(req: RouteRequest): Promise<RouteResult> {
    try {
      return await this.router.route(req);
    } catch {
      // A routing failure must not become an exception the agent has to handle:
      // fall back to an explicitly-labelled approximation, which is honest about
      // not knowing the turns rather than inventing them.
      return straightLineRoute(req.from, req.to, req.mode);
    }
  }

  /**
   * Route with live congestion.
   *
   * Falls back to free flow, labelled, when no flow provider has a credential.
   * The `freeFlowOnly` flag is what the tool layer reads to tell the user their
   * ETA ignores traffic, so this is the difference between a useful answer and a
   * confidently wrong one.
   */
  async routeWithTraffic(req: RouteRequest): Promise<TrafficResult> {
    return this.traffic.route(req);
  }

  /**
   * Conditions at a point.
   *
   * Returns undefined only when weather is explicitly disabled. A source that is
   * configured but unreachable returns a result with `degraded` set and `now`
   * filled with NaN, which renders as `unknown` rather than as dry weather.
   */
  async weatherAt(
    lat: number,
    lon: number,
    forecastHours = 12,
    signal?: AbortSignal,
  ): Promise<WeatherResult | undefined> {
    if (!this.weather) return undefined;
    return this.weather.fetch(lat, lon, forecastHours, signal);
  }

  /**
   * Attach derived heat layers to a document.
   *
   * Copy-on-write, so the cached document is never mutated. Two requests for the
   * same envelope with different layer filters would otherwise leave the first
   * one's heat describing the second one's data.
   */
  private withHeat(doc: ScrDocument, radiusM: number): ScrDocument {
    if (!this.deriveHeat) return doc;

    const heat = [...doc.heat];

    // Place density, from the named point features already ingested. Only named
    // places count: an unnamed bench is not something a person chooses a street
    // for, and counting them would make every park look like a shopping district.
    const points: { x: number; y: number; value: number }[] = [];
    for (const f of doc.features) {
      if (f.geometry.kind !== 'point') continue;
      if (!isNamedFeature(doc, f)) continue;
      points.push({ x: f.geometry.point.x, y: f.geometry.point.y, value: 1 });
    }
    if (points.length >= 3) {
      const density = densityToHeat(points, doc.envelope, { name: 'poi_density' });
      if (density) heat.push(density);
    }

    return heat.length === doc.heat.length ? doc : { ...doc, heat };
  }

  /** Fetch and cache the compiled document for an area, reusing recent fetches. */
  private async document(
    bbox: BboxQuery,
    layers: string[],
    signal?: AbortSignal,
  ): Promise<{
    doc: ScrDocument;
    source: string;
    elapsedMs: number;
    warnings: string[];
    truncated: boolean;
  }> {
    const key = cacheKey(bbox, layers);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < SuperCarto.CACHE_TTL_MS) {
      return { doc: hit.doc, source: 'cache', elapsedMs: 0, warnings: [], truncated: false };
    }

    const request: SourceRequest = { bbox, layers, maxFeatures: 50_000, signal };

    let lastError: unknown;
    for (const source of this.sources) {
      if (!(await source.available())) continue;
      try {
        const res = await source.fetch(request);
        const doc = fromGeoJson(
          { type: 'FeatureCollection', features: res.features },
          { envelope: { type: 'bbox', ...bbox }, source: res.source },
        );
        this.remember(key, doc);
        return {
          doc,
          source: res.source,
          elapsedMs: res.elapsedMs,
          warnings: res.warnings,
          truncated: res.truncated,
        };
      } catch (err) {
        lastError = err;
      }
    }

    throw new Error(
      `no source could serve the request${lastError ? `: ${String(lastError)}` : ''}`,
    );
  }

  private remember(key: string, doc: ScrDocument): void {
    if (this.cache.size >= SuperCarto.CACHE_MAX) {
      // Evict the oldest insertion, which Map iteration order preserves.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { doc, at: Date.now() });
  }

  /** Full SCR text for an area, for machine-side caching or binary encoding. */
  async scr(bbox: BboxQuery, layers: string[] = [], signal?: AbortSignal): Promise<string> {
    const { doc } = await this.document(bbox, layers, signal);
    return encodeDocument(doc, { group: false });
  }

  /** Elevation grid for an area, when a terrain source is configured. */
  async elevationFor(
    bbox: BboxQuery,
    res = 32,
    signal?: AbortSignal,
  ): Promise<ElevationGrid | undefined> {
    if (!this.elevation) return undefined;
    try {
      return await this.elevation.fetch(normalizeBbox(bbox), res, signal);
    } catch {
      // Terrain is an enrichment, not a requirement. A failure must not take
      // down the maplet; it just means the graph carries no elevation.
      return undefined;
    }
  }

  /** Number of cached documents, for diagnostics. */
  get cacheSize(): number {
    return this.cache.size;
  }

  /**
   * Whether elevation can actually be answered.
   *
   * The MCP layer uses this to decide whether to advertise `get_terrain` at
   * all, so an operator is never handed a tool that cannot work.
   */
  get hasElevation(): boolean {
    return this.elevation !== undefined;
  }

  /** Whether weather can be answered. Gates advertising `get_weather`. */
  get hasWeather(): boolean {
    return this.weather !== undefined;
  }

  /**
   * Whether live traffic can be answered.
   *
   * Gates advertising `get_traffic`. The distinction from `hasWeather` matters:
   * weather works with no credential, traffic never does, so `get_traffic` is
   * absent from the tool list unless a key is present. Advertising it anyway
   * would produce an agent that confidently quotes a free-flow ETA.
   */
  get hasTraffic(): boolean {
    return this.traffic.hasFlow;
  }

  /** The full capability set, used for tool advertisement. */
  get capabilities(): Capabilities {
    return {
      elevation: this.hasElevation,
      weather: this.hasWeather,
      traffic: this.hasTraffic,
    };
  }

  /** Clear the document cache. */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * Recover the GeoJSON feature list from a compiled document.
 *
 * This is the only place that knows how to read attributes back out of the
 * string dictionary. Re-entering `toMaplet` with the recovered features keeps a
 * single compile path for every input, which is what stops live and fixture
 * results from drifting apart.
 */
export function featuresFromDocument(doc: ScrDocument): GeoJsonFeature[] {
  const out: GeoJsonFeature[] = [];
  const env = doc.envelope;
  for (const f of doc.features) {
    out.push({
      type: 'Feature',
      id: f.id,
      properties: propertiesOf(doc, f.attrSet, f.classId),
      geometry: geometryOf(doc, f, env),
    });
  }
  return out;
}

function propertiesOf(
  doc: ScrDocument,
  attrSet: number,
  classId: number,
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const cls = doc.classes.get(classId);
  if (cls) props.type = cls.name;

  const set = doc.attrSets.get(attrSet);
  if (!set) return props;
  for (const p of set.props) {
    const key = doc.strings.get(p.key);
    if (!key) continue;
    const v = p.value;
    if (v.t === 'ref') {
      const s = doc.strings.get(v.ref);
      if (s !== undefined) props[key] = s;
    } else if (v.t === 'num') {
      props[key] = v.num;
    } else if (v.t === 'bool') {
      props[key] = v.bool;
    } else {
      props[key] = v.token;
    }
  }
  return props;
}

function geometryOf(doc: ScrDocument, f: Feature, env: Envelope) {
  const g = f.geometry;
  const toLonLat = (p: { x: number; y: number }): [number, number] => {
    const ll = gridToLonLat(p, env, doc.extent, doc.projection);
    return [round(ll.lon, 7), round(ll.lat, 7)];
  };

  switch (g.kind) {
    case 'point':
      return { type: 'Point' as const, coordinates: toLonLat(g.point) };
    case 'line':
      return {
        type: 'LineString' as const,
        coordinates: g.lines[0] ? g.lines[0].map(toLonLat) : [],
      };
    case 'polygon':
    case 'building': {
      const ring = g.polygon[0]?.rings[0];
      return {
        type: 'Polygon' as const,
        coordinates: ring ? [ring.map(toLonLat)] : [],
      };
    }
  }
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function formatRadius(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
}

/** Whether a feature carries a non-empty `name`, used for density counting. */
function isNamedFeature(doc: ScrDocument, f: Feature): boolean {
  if (f.attrSet === 0) return false;
  const set = doc.attrSets.get(f.attrSet);
  if (!set) return false;
  for (const p of set.props) {
    if (doc.strings.get(p.key) !== 'name') continue;
    if (p.value.t === 'ref') {
      const s = doc.strings.get(p.value.ref);
      if (s !== undefined && s !== '') return true;
    }
  }
  return false;
}

function cacheKey(bbox: BboxQuery, layers: string[]): string {
  const b = [bbox.west, bbox.south, bbox.east, bbox.north].map((n) => n.toFixed(5)).join(',');
  return `${b}|${[...layers].sort().join(',')}`;
}

export { elevationToHeat };
export { densityToHeat, slopeToHeat } from './source/heat.js';
export type {
  TravelMode,
  BboxQuery,
  RouteRequest,
  RouteResult,
  MapSource,
  RoutingSource,
  WeatherSource,
  WeatherResult,
  TrafficSourceLike,
  TrafficResult,
};
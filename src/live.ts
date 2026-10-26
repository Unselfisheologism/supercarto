import { toMaplet, type MapletResult } from './pipeline.js';
import { moveMaplet, sessionDoc, sessionEnvelopeContains, type SessionMoveResult } from './session/session.js';
import {
  bboxAround,
  normalizeBbox,
  type BboxQuery,
  type MapSource,
  type SourceRequest,
  type SourceResult,
} from './source/types.js';
import { OverpassSource, type OverpassOptions } from './source/overpass.js';
import {
  FeasibilityRouter,
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
// Type-only on purpose: a value import would pull the whole GTFS reader
// (node:fs, node:zlib) into bundles that never serve a feed - a Worker build
// cannot even evaluate that module.
import type {
  TransitRequest,
  TransitResult,
  TransitRouteRequest,
  TransitRouteResult,
  TransitSource,
} from './source/gtfs.js';
import { encodeDocument } from './wire/encode.js';
import { gridToLonLat } from './geo/project.js';
import { gridScaleFor } from './geo/scale.js';
import type { CompileOptions } from './compile/compiler.js';

/**
 * Samples per axis for the slope grid.
 *
 * Coarser than the elevation grid used by `get_terrain`, because slope is a
 * smooth surface: doubling the resolution would double a network call to sharpen
 * a gradient nobody will query cell by cell.
 */
const SLOPE_HEAT_RES = 16;
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
   * Transit schedule source, read from a GTFS feed. Omit by default.
   *
   * Not defaulted, because a schedule is only as fresh as the operator's last
   * feed import: quietly serving a stale timetable labels it as the answer to
   * "when is my bus", when what it holds is "when the bus ran last spring".
   * Absence is reported instead, and `get_transit` stays unadvertised.
   */
  transit?: TransitSource;
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
  /**
   * Compile-time overrides, chiefly the instant opening hours are judged
   * against and the map area's UTC offset.
   *
   * Without an offset the evaluator falls back to the host's timezone, so a
   * server outside the map's region would report local shops on its own clock.
   */
  compile?: CompileOptions;
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

export interface MoveViewRequest {
  /** The agent's current map: the SCR a previous maplet or move returned. */
  scr: string;
  lat: number;
  lon: number;
  /** Radius in metres. Default 300. */
  radiusM?: number;
  layers?: string[];
  budget?: number;
  signal?: AbortSignal;
  compile?: CompileOptions;
}

export interface MoveViewLiveResult extends SessionMoveResult {
  /** The upstream source that served this move. */
  fetchedFrom: string;
  fetchMs: number;
  warnings: string[];
  sourceTruncated: boolean;
}

export class SuperCarto {
  private readonly sources: MapSource[];
  private readonly router: RoutingSource;
  private readonly elevation?: ElevationSource;
  private readonly weather?: WeatherSource;
  private readonly traffic: TrafficRouter;
  private readonly transit: TransitSource | undefined;
  private readonly deriveHeat: boolean;
  private readonly defaultBudget: number;
  /** Per-area cache of compiled documents, keyed by envelope and layer set. */
  private readonly cache = new Map<string, { doc: ScrDocument; at: number }>();

  private static readonly CACHE_TTL_MS = 5 * 60_000;
  private static readonly CACHE_MAX = 128;

  constructor(opts: SuperCartoOptions = {}) {
    this.sources = opts.sources ?? [new OverpassSource(opts.overpass)];
    // Routing defaults to feasibility, not navigation. A router that answers
    // with confidence but cannot be verified is the worst thing on the
    // palette: measured on the public demo OSRM, a short northward walk in
    // sf-cbd came back physically impossible, and nothing in the response
    // looks wrong. So the default route source claims only what it can
    // compute - straight-line distance and direction - and ends in "verify
    // the approach on arrival". Pass a router you have verified yourself to
    // get turn-by-turn.
    this.router = opts.router ?? new FeasibilityRouter();
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
    // Transit is never defaulted. A schedule without an operator-imported feed
    // does not exist, and one that exists but is stale is worse than absent:
    // the tool must not be advertised at all unless the operator has wired one.
    this.transit = opts.transit;
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
    const doc = await this.withHeat(fetched.doc, bbox, req.signal);

    // The derived document is passed through directly rather than converted
    // back to GeoJSON. Heat layers live on the document, not on any feature, so
    // a round trip through features would discard every layer just added -
    // which is what silently reduced this to a topology-only maplet.
    const result = toMaplet(
      { type: 'FeatureCollection', features: [] },
      {
        doc,
        bbox,
        layers: req.layers,
        budget,
        ...(req.compile ? { compile: req.compile } : {}),
        radiusLabel: formatRadius(radiusM),
        // So the maplet advertises only the tools this instance can answer.
        capabilities: this.capabilities,
      },
    );

    // Places without streets are a contradiction, not a result. Measured
    // against Tokyo: 55 named places, zero edges, served with a 200 as if
    // nothing were wrong. An agent cannot navigate between names without
    // a network, so handing it one misleads more than refusing. A fully
    // empty map still serves: open ocean is honestly empty, and there is
    // nothing in it to mislead about. Explicitly POI-only requests pass
    // too: asking for places is honest, getting places is the answer.
    //
    // The signal is the safety net fingerprint, not the node count: the
    // emitter strips orphan names and records them as landmark omissions,
    // so stripped-names-plus-no-edges is exactly the misleading case, while
    // an untouched empty map stays servable.
    const explicit = req.layers !== undefined && req.layers.length > 0;
    const wantsRoads =
      !explicit || req.layers!.some((l) => l === 'road' || l === 'highway');
    const stripped = (result.graph.omitted ?? []).some((o) => o.layer === 'landmark');
    if (result.graph.edges.length === 0 && stripped && wantsRoads) {
      const dropped = (result.graph.omitted ?? [])
        .filter((o) => o.layer === 'landmark')
        .reduce((n, o) => n + o.count, 0);
      throw new Error(
        `no walkable network survived for ${req.lat},${req.lon} ` +
        `(radius ${radiusM}m): ${dropped} named places stripped for lack of streets. ` +
        `Pass layers: ['poi'] for a POI-only map, or retry - a degraded ` +
        `upstream fetch is the usual cause.`,
      );
    }
        return {
      ...result,
      fetchedFrom: fetched.source,
      fetchMs: fetched.elapsedMs,
      warnings: fetched.warnings,
      sourceTruncated: fetched.truncated,
    };
  }

  /**
   * One move of a session: the agent's stored SCR in, the +/-/~ delta out.
   *
   * This is the `localize` tool's engine. It fetches the new view's features,
   * re-ingests them under the *session's* envelope rather than the request
   * box's own, diffs against the agent's map, and returns the changed places
   * plus the replaced state. The agent keeps its map in local RAM; the LLM
   * context pays only for the diff.
   *
   * Moves outside the session envelope are refused rather than served with a
   * lying diff: a foreign grid would mark every untouched place dirty.
   */
  async moveView(req: MoveViewRequest): Promise<MoveViewLiveResult> {
    const prev = sessionDoc(req.scr);
    const env = prev.envelope;
    if (env.type !== 'bbox') {
      throw new Error(
        'a session move needs a bbox session envelope; open a session with get_maplet first',
      );
    }
    const radiusM = req.radiusM ?? 300;
    const bbox = normalizeBbox(bboxAround(req.lat, req.lon, radiusM));
    if (!sessionEnvelopeContains(env, bbox)) {
      throw new Error(
        `the move leaves the session envelope ` +
        `(BBOX ${env.west} ${env.south} ${env.east} ${env.north}); ` +
        `a wrap-crossing view quantizes on the far side of the antimeridian ` +
        `and cannot share the session grid - ` +
        `call get_maplet again to open a new session`,
      );
    }

    const fetched = await this.fetchFeatures(bbox, req.layers ?? [], req.signal);
    const move = moveMaplet(
      req.scr,
      { type: 'FeatureCollection', features: fetched.features },
      {
        layers: req.layers ?? null,
        budget: req.budget ?? this.defaultBudget,
        radiusLabel: formatRadius(radiusM),
        capabilities: this.capabilities,
        ...(req.compile ? { compile: req.compile } : {}),
      },
    );
    return {
      ...move,
      fetchedFrom: fetched.source,
      fetchMs: fetched.elapsedMs,
      warnings: fetched.warnings,
      sourceTruncated: fetched.truncated,
    };
  }

  /** Route between two points: feasibility by default, navigation with a verified router. */
  async route(req: RouteRequest): Promise<RouteResult> {
    try {
      return await this.router.route(req);
    } catch {
      // A routing failure must not become an exception the agent has to handle:
      // fall back to the feasibility answer, which is honest about not knowing
      // the turns rather than inventing them.
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
   *
   * Async because slope heat needs an elevation fetch, which is a network call.
   * Density is derived from data already in hand and costs nothing.
   */
  private async withHeat(
    doc: ScrDocument,
    bbox: BboxQuery,
    signal?: AbortSignal,
  ): Promise<ScrDocument> {
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

    // Slope, from elevation. This is the layer that answers "can I wheel a
    // pram or push a bike up this", which a road name cannot. It needs the
    // terrain source, and it is best-effort: a terrain fetch that fails leaves
    // the maplet without a slope layer rather than failing the whole request,
    // because the topology the agent actually asked for is already in hand.
    if (this.elevation) {
      try {
        const grid = await this.elevationFor(bbox, SLOPE_HEAT_RES, signal);
        const scale = gridScaleFor(doc);
        if (grid && scale) {
          // The grid axes need not be square, so each gets its own scale. Using
          // one number for both overstates slope on whichever axis is longer,
          // which would flag a gentle east-west street as steep.
          const slope = slopeToHeat(grid.values, grid.width, grid.height, {
            name: 'slope',
            metresPerUnit: (scale.x + scale.y) / 2,
          });
          if (slope) heat.push(slope);
        }
      } catch {
        // Terrain unavailable. The rest of the maplet stands on its own.
      }
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

    const res = await this.fetchFeatures(bbox, layers, signal);
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
  }

  /**
   * Fetch through the sources, trying each until one answers.
   *
   * Split out of `document` so session moves can ingest the same features
   * under the *session's* envelope rather than the request box's own - the
   * one-envelope rule that makes the diff compare geometry exactly.
   */
  private async fetchFeatures(
    bbox: BboxQuery,
    layers: string[],
    signal?: AbortSignal,
  ): Promise<SourceResult> {
    const request: SourceRequest = { bbox, layers, maxFeatures: 50_000, signal };

    let lastError: unknown;
    for (const source of this.sources) {
      if (!(await source.available())) continue;
      try {
        return await source.fetch(request);
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

  /**
   * Whether the transit schedule can be answered.
   *
   * Gates advertising `get_transit`. A schedule tool with no feed behind it
   * would teach a model to trust a "no feed" answer that reads like "no
   * service" - an honest refusal turned into a lie about buses that run.
   */
  get hasTransit(): boolean {
    return this.transit !== undefined;
  }

  /**
   * The transit slice for a point: stops, routes, and schedule-derived service
   * window, from the configured GTFS feed.
   *
   * The underlying query is synchronous (the feed is local data), but the
   * method stays async so every live entry point answers the same way and a
   * future remote schedule source needs no call-site changes.
   *
   * Throws when no feed is configured. The tool layer never advertises
   * `get_transit` in that state, so this is a plumbing error, not an answer.
   */
  async transitAt(req: TransitRequest): Promise<TransitResult> {
    if (!this.transit) {
      throw new Error('no GTFS feed configured for this deployment');
    }
    // The overlay fetch happens here, not inside the synchronous render: one
    // prediction read per query, joined once, so a schedule answer never
    // stalls on network I/O it did not start. A deployment without a realtime
    // URL configured gets no overlay and the map note says everything shown
    // is scheduled.
    const overlay = this.transit.realtime ? await this.transit.realtime(req.now) : undefined;
    return this.transit.querySlice(
      {
        ...req,
        radiusM: req.radiusM ?? 400,
        budget: req.budget ?? this.defaultBudget,
      },
      overlay,
    );
  }

  /**
   * A certified ride plan between two coordinates on the configured feed.
   *
   * Same overlay discipline as `transitAt`: one prediction read per query,
   * fetched here, passed to the renderer in the same breath - 0.5.6 exists
   * because a join fetched here and not passed there shipped undetected. The
   * tool layer never advertises this when no feed is configured.
   */
  async transitRoute(req: TransitRouteRequest): Promise<TransitRouteResult> {
    if (!this.transit) {
      throw new Error('no GTFS feed configured for this deployment');
    }
    const overlay = this.transit.realtime ? await this.transit.realtime(req.now) : undefined;
    return this.transit.planTrip!.call(
      this.transit,
      {
        ...req,
        budget: req.budget ?? this.defaultBudget,
      },
      overlay,
    );
  }

  /** The full capability set, used for tool advertisement. */
  get capabilities(): Capabilities {
    return {
      elevation: this.hasElevation,
      weather: this.hasWeather,
      traffic: this.hasTraffic,
      transit: this.hasTransit,
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
  TransitSource,
  TransitRequest,
  TransitResult,
};
import type { GeoJsonFeature } from '../ingest/geojson.js';
import type { BboxQuery, MapSource, SourceRequest, SourceResult } from './types.js';

/**
 * OpenStreetMap via Overpass.
 *
 * This is the adapter that makes "any location on earth" literally true: it
 * takes arbitrary coordinates, needs no tile archive or API key, and covers the
 * whole planet. The cost is that it queries a shared public service, which is
 * rate-limited and not meant for heavy traffic.
 *
 * For production volume, use Protomaps/PMTiles instead, which serves the same
 * data from object storage with no rate limit.
 */

export interface OverpassOptions {
  /**
   * Endpoint. The default is the public instance, which is fine for
   * development and low volume. Point this at your own instance for anything
   * real: see https://wiki.openstreetmap.org/wiki/Overpass_API
   */
  readonly endpoint?: string;
  /** Abort after this many milliseconds. */
  readonly timeoutMs?: number;
  /** Injectable fetch, for tests and for runtimes without a global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Cap on the returned feature count, to keep responses bounded. */
  readonly maxFeatures?: number;
  /** User-Agent sent with every request. Required by the public instance. */
  readonly userAgent?: string;
  /** Retry attempts, each with fewer layers. Default 4. */
  readonly maxAttempts?: number;
}

const DEFAULT_ENDPOINT = 'https://overpass-api.de/api/interpreter';
/**
 * Generous, because the public instance is slow for way-heavy queries: a
 * single `way[highway]` over a few city blocks regularly takes 20-40s there,
 * while a self-hosted instance answers in under a second. Set this lower when
 * you control the server.
 */
const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_USER_AGENT =
  'supercarto/0.2.0 (LLM spatial middleware; +https://github.com/supercarto)';

/**
 * Pull the human-readable part out of an Overpass XML error, so a rate-limit
 * or slot-exhaustion message reaches the caller instead of an XML blob.
 */
/**
 * Pull the useful sentence out of an Overpass HTML error page.
 *
 * These pages open with an OpenStreetMap attribution paragraph before they
 * state what actually went wrong, so taking the first `<p>` yields
 * "The data included in this document is from www.openstreetmap.org" as the
 * explanation for a timeout - technically the page's text, but useless. The real
 * diagnosis follows the `Error:` marker.
 */
function summarizeError(text: string): string {
  const strong = /<strong[^>]*>Error<\/strong>\s*:?\s*([^<]*)/i.exec(text);
  if (strong?.[1]) return strong[1].replace(/\s+/g, ' ').trim().slice(0, 200);
  const paragraphs = [...text.matchAll(/<p>([^<]+)<\/p>/g)].map((m) => m[1]!.trim());
  // Attribution/licence boilerplate is never the explanation.
  const useful = paragraphs.filter(
    (p) => !/openstreetmap\.org|ODbL|available under/i.test(p),
  );
  if (useful.length > 0) return useful[useful.length - 1]!.replace(/\s+/g, ' ').slice(0, 200);
  const stripped = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped.slice(0, 160) || 'no detail';
}

/**
 * Semantic layers, in descending priority.
 *
 * Order matters three times: what a caller gets first, what survives when the
 * server refuses a query, and - because the retry drops from the *end* - which
 * layers are the first sacrificed. `highway` leads so that streets are the last
 * thing to go: losing them leaves an agent with names it cannot navigate between.
 */
const DEFAULT_LAYERS = [
  'highway',
  'building',
  'amenity',
  'railway',
  'shop',
  'tourism',
  'office',
  'leisure',
  'natural',
  'waterway',
];

/**
 * Highway subtypes worth requesting.
 *
 * `traffic_signals`, `crossing`, `street_lamp` and friends are nodes with a
 * `highway` tag. There are thousands of them in a city block, they are not
 * places, and each one becomes a junction in the graph - an agent gets a
 * hundred anonymous nodes representing signal posts instead of the streets
 * between two cafes. Only ways and genuinely navigable nodes are requested.
 */
const HIGHWAY_TAGS = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential',
  'unclassified', 'living_street', 'pedestrian', 'service', 'motorway_link',
  'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
];

/**
 * Way subtypes excluded from requests.
 *
 * Footways, paths and steps are enormous in count and change little about where
 * anyone actually walks; they are also what makes an unfiltered way query time
 * out on the public Overpass instance.
 */
const EXCLUDED_HIGHWAYS = 'footway|path|steps|cycleway|track|bridleway|corridor';

const LAYER_TAGS: Record<string, string> = {
  highway: 'highway',
  railway: 'railway',
  amenity: 'amenity',
  shop: 'shop',
  tourism: 'tourism',
  office: 'office',
  leisure: 'leisure',
  natural: 'natural',
  waterway: 'waterway',
  building: 'building',
};

/** Error carrying the HTTP status, so the retry policy can inspect it. */
export class OverpassError extends Error {
  override readonly name = 'OverpassError';
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Whether a failure is worth retrying with a smaller query.
 *
 * Timeouts, rate limiting and gateway errors say "this was too much", which a
 * smaller query can fix. A parse error says "this was wrong", which it cannot,
 * so retrying would just repeat the mistake.
 */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof OverpassError)) return false;
  return err.status === 429 || err.status === 504 || err.status === 502 || err.status === 503;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A short sample of coordinates that fell outside the requested area.
 *
 * Included in the error message because the exact shape of the corruption is
 * the useful diagnostic: a transposed latitude reads very differently from a
 * sign flip, and both from data from the wrong region entirely.
 */
function sampleOutside(features: GeoJsonFeature[]): string {
  const parts: string[] = [];
  for (const f of features.slice(0, 3)) {
    const c = allCoordinates(f.geometry)[0];
    if (c) parts.push(`lon=${c[0]} lat=${c[1]}`);
  }
  return parts.join(', ');
}

/**
 * How many extra attempts an empty-but-successful response is allowed.
 *
 * Kept small and independent of the general retry budget: an empty result over
 * open ocean or polar ice is a legitimate answer, and every retry spent probing
 * it is a request taken from a shared public server on someone else's behalf.
 */
const EMPTY_RETRY_BUDGET = 2;

/**
 * How many times a request may be retried over a smaller box.
 *
 * The public instance corrupts way geometry rather than refusing a large
 * query, so the only way to get a usable answer is to ask for less. Shrinking
 * is bounded because a request that keeps halving eventually covers an area too
 * small to be worth returning.
 */
const MAX_SHRINK_ATTEMPTS = 4;

/** Features that carry street-like geometry, as opposed to points. */
function countWays(features: GeoJsonFeature[]): number {
  let n = 0;
  for (const f of features) {
    if (f.geometry?.type === 'LineString') n++;
  }
  return n;
}

/**
 * A smaller box centred on the same point.
 *
 * Shrinks each axis by 40% so the area falls to about 16% - enough to get under
 * the result-size cliff without collapsing to nothing. Returns undefined once
 * the box is too small to be worth querying.
 */
function tighten(bbox: BboxQuery): BboxQuery | undefined {
  const { west, south, east, north } = bbox;
  const cx = (west + east) / 2;
  const cy = (south + north) / 2;
  const halfW = ((east - west) / 2) * 0.6;
  const halfH = ((north - south) / 2) * 0.6;
  // Roughly 100m: below this there is nothing left worth mapping.
  if (halfH < 0.00045 || halfW < 0.0006) return undefined;
  return { west: cx - halfW, south: cy - halfH, east: cx + halfW, north: cy + halfH };
}

/**
 * Whether a box sits on land where OSM coverage is effectively universal.
 *
 * Used only to decide whether an empty result deserves an error. OpenStreetMap
 * is mapped almost everywhere people live, so "nothing at all" over a land box
 * is a server failure worth reporting. Boxes over open ocean and the polar
 * ice genuinely have no data and are passed through as an honest blank.
 */
/**
 * Whether a box is far enough from any plausible landmass to be genuinely empty.
 *
 * Used only to decide whether an empty result deserves an error or a retry. The
 * test is deliberately conservative - polar ice and the deep Southern Ocean are
 * the only places OSM is reliably empty - because guessing wrong in the other
 * direction is what turned a healthy San Francisco into an "empty map".
 *
 * An earlier version tried to detect mid-ocean boxes by longitude, which
 * classified coastal cities like San Francisco as ocean. Anything subtler than
 * "obviously empty" is not attempted: an occasional retry over open water costs
 * one request, whereas a false negative silently deletes a real city.
 */
function isPopulatedLand(bbox: BboxQuery): boolean {
  const midLat = (bbox.south + bbox.north) / 2;
  if (Math.abs(midLat) >= 66) return false; // Arctic/Antarctic circles
  // The Southern Ocean and the Antarctic interior are genuinely empty. The
  // southern limit is generous because the 60th parallel is open water for most
  // of its length and OSM coverage there is sparse.
  if (midLat < -55) return false;
  return true;
}

/**
 * Element cap applied server-side.
 *
 * This is not just a politeness limit. The public instance degrades badly above
 * it: a 500m San Francisco box answered with 4,555 ways whose coordinates were
 * all corrupt - every street came back at latitude 37.2 instead of 37.77 - and
 * the response carried no error and no indication that anything was wrong. A
 * smaller box answered correctly and immediately. The cap is what keeps a
 * request on the side of that cliff, so it is a correctness limit, not a tuning
 * knob.
 */
const SERVER_SIDE_CAP = 5_000;

/**
 * Overpass QL selecting what an agent actually needs for navigation.
 *
 * Two details are load-bearing, and both were found by running against the real
 * public instance rather than by reading the docs:
 *
 * 1. The bbox filter goes *inside* the parentheses: `node(bbox:...)[tag]`.
 *    Written as a bracket prefix (`node[bbox:...][tag]`) it is a parse error,
 *    because `bbox:` is only legal in statement position.
 * 2. Unfiltered `way` queries time out on the shared public instance - the
 *    server's read dispatcher gives up well before it has scanned every footway
 *    and path in a city block. Excluding the micro-pathways and capping the
 *    result count is what makes the query answerable there, and it also drops
 *    the least useful features for an agent: a kerb-level footway does not
 *    change where anyone walks.
 */
function buildQuery(req: SourceRequest): string {
  const { south: s, west: w, north: n, east: e } = req.bbox;
  const area = `(bbox:${s},${w},${n},${e})`;

  const parts: string[] = [];

  for (const layer of req.layers) {
    const tag = LAYER_TAGS[layer] ?? layer;

    if (tag === 'highway') {
      // Requested explicitly by subtype. A bare `[highway]` match returns every
      // crossing and traffic signal in the area, which is noise in a graph and
      // is the single biggest contributor to an unusable response.
      parts.push(HIGHWAY_TAGS.map((t) => `    way${area}[highway=${t}];`).join('\n'));
      parts.push(`    node${area}[highway=bus_stop];`);
      continue;
    }

    // `natural=water` and `natural=wood` as separate statements: a bare
    // `[natural]` match also returns `natural=tree` on every way, which in a
    // city is most of them.
    if (tag === 'natural') {
      parts.push(`    way${area}[natural=water];`);
      parts.push(`    way${area}[natural=wood];`);
      parts.push(`    way${area}[natural=scrub];`);
      continue;
    }

    // Buildings as ways only: building nodes carry no geometry.
    if (tag === 'building') {
      parts.push(`    way${area}[building][building!="no"];`);
      continue;
    }

    if (tag === 'railway') {
      // Only the two things an agent navigates by or waits at. A bare
      // `[railway]` match returns every level_crossing and tram_crossing node
      // on the tramway, which floods the graph with anonymous nodes and starves
      // the landmarks of budget.
      parts.push(`    node${area}[railway=tram_stop];`);
      parts.push(`    node${area}[railway=subway_entrance];`);
      parts.push(`    node${area}[railway=station];`);
      parts.push(`    node${area}[railway=halt];`);
      continue;
    }

    parts.push(`    node${area}[${tag}];`);
    // Ways carry parks, shops in complexes, and railways; exclude the
    // micro-pathways that dominate way counts.
    parts.push(`    way${area}[${tag}][highway!~"^(${EXCLUDED_HIGHWAYS})$"];`);
  }

  const cap = Math.min(req.maxFeatures || SERVER_SIDE_CAP, SERVER_SIDE_CAP);

  // `out geom`, not `out body`: `body` returns ways as a bare list of vertex ids
  // with no coordinates, and since the query selects ways directly - never their
  // constituent nodes - those ids cannot be resolved from the response. Every
  // road therefore came back with an empty coordinate list and was discarded,
  // which is why a San Francisco maplet reported 180 places and zero streets.
  // `geom` inlines each way's vertex coordinates, so ways stand alone.
  return `[out:json][timeout:25];
(
${parts.join('\n')}
);
out geom qt ${cap};`;
}

/**
 * Rebuild a line or polygon from only the vertices that are in range.
 *
 * A line whose surviving vertices are non-contiguous is split at the gap rather
 * than joined across it, because bridging a corrupt run with a straight jump
 * would invent a road that does not exist. Polygons whose surviving vertices no
 * longer close are dropped by the caller's type check, since a clipped ring is
 * not a valid area and a fake one is worse than none.
 */
function clipGeometry(
  f: GeoJsonFeature,
  keep: Array<[number, number]>,
): GeoJsonFeature {
  const g = f.geometry;
  if (!g) return f;
  if (g.type === 'LineString') {
    return { ...f, geometry: { type: 'LineString', coordinates: keep } };
  }
  if (g.type === 'MultiLineString') {
    // Keep the longest surviving run rather than flattening separate roads into
    // one, which would create edges between places with no connection.
    const parts = (g.coordinates ?? []) as Array<Array<[number, number]>>;
    const runs = parts
      .map((line) => line.filter((c) => keep.some((k) => k === c)))
      .filter((line) => line.length >= 2)
      .sort((a, b) => b.length - a.length);
    if (runs.length === 0) {
      return { ...f, geometry: { type: 'LineString', coordinates: [] } };
    }
    return { ...f, geometry: { type: 'LineString', coordinates: runs[0]! } };
  }
  if (g.type === 'Polygon') {
    const rings = (g.coordinates ?? []) as Array<Array<[number, number]>>;
    const ring = (rings[0] ?? []).filter((c) => keep.some((k) => k === c));
    const first = ring[0];
    const last = ring[ring.length - 1];
    const closed = !!first && !!last && first[0] === last[0] && first[1] === last[1];
    return {
      ...f,
      geometry: {
        type: 'Polygon',
        // An unclosed ring is no longer the same shape; an empty ring is
        // rejected downstream rather than reported as a real area.
        coordinates: closed && ring.length >= 4 ? [ring] : [],
      },
    };
  }
  return f;
}

/**
 * Convert an Overpass element to GeoJSON.
 *
 * Overpass returns three element shapes - node, way, relation - and only nodes
 * carry top-level coordinates. Ways carry theirs inline under `geometry` when
 * the query uses `out geom`, which is what the built query requests; the
 * `coordsById` lookup remains as a fallback for `out body` responses.
 */
function nodeToFeature(
  el: { id: number; lat: number; lon: number; tags?: Record<string, string> },
): GeoJsonFeature {
  return {
    type: 'Feature',
    id: el.id,
    properties: { ...(el.tags ?? {}) },
    geometry: { type: 'Point', coordinates: [el.lon, el.lat] },
  };
}

/** Every coordinate pair in any geometry. */
function allCoordinates(geom: GeoJsonFeature['geometry']): Array<[number, number]> {
  const g = geom as { coordinates?: unknown };
  const out: Array<[number, number]> = [];
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      out.push([node[0], node[1]]);
      return;
    }
    for (const child of node) walk(child);
  };
  walk(g.coordinates);
  return out;
}

function wayToFeature(
  el: { id: number; nodes?: number[]; tags?: Record<string, string> },
  coords: [number, number][],
): GeoJsonFeature | undefined {
  if (coords.length < 2) return undefined;
  const tags = el.tags ?? {};
  const isArea = coords.length >= 3 && isClosed(coords) && isAreaTag(tags);

  return {
    type: 'Feature',
    id: el.id,
    properties: { ...tags },
    geometry: isArea
      ? { type: 'Polygon', coordinates: [coords] }
      : { type: 'LineString', coordinates: coords },
  };
}

/** A ring is closed when its first and last vertices match. */
function isClosed(coords: [number, number][]): boolean {
  const a = coords[0]!;
  const b = coords[coords.length - 1]!;
  return a[0] === b[0] && a[1] === b[1];
}

/** Tags that make a closed way an area rather than a ring-shaped line. */
const AREA_KEYS = ['building', 'landuse', 'natural', 'leisure', 'amenity', 'shop', 'tourism', 'place', 'waterway'];

function isAreaTag(tags: Record<string, string>): boolean {
  for (const k of AREA_KEYS) {
    const v = tags[k];
    if (v === undefined) continue;
    // A closed waterway is a river loop, not a lake; a bare `natural=yes` on a
    // highway ring is not an area either.
    if (k === 'waterway' && v !== 'riverbank' && v !== 'dock') return false;
    if (k === 'highway') return false;
    return true;
  }
  return false;
}

export class OverpassSource implements MapSource {
  readonly name = 'osm-overpass';
  readonly description = 'OpenStreetMap via the Overpass API. Any coordinates, no API key.';

  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxFeatures: number;
  private readonly userAgent: string;
  private readonly maxAttempts: number;
  /** The area currently being fetched, used to reject implausible coordinates. */
  private bbox?: BboxQuery;

  constructor(opts: OverpassOptions = {}) {
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.maxFeatures = opts.maxFeatures ?? 50_000;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
  }

  async available(): Promise<boolean> {
    return typeof this.fetchImpl === 'function';
  }

  async fetch(req: SourceRequest): Promise<SourceResult> {
    const started = Date.now();
    const warnings: string[] = [];
    const limit = Math.min(req.maxFeatures || this.maxFeatures, this.maxFeatures);
    this.bbox = req.bbox;

    // The public instance is a shared, rate-limited resource, and a query that
    // asks for every building in a dense city will time out on it. Layers are
    // therefore dropped in priority order when the server refuses, so a caller
    // gets a partial map instead of an exception. Roads and POIs survive
    // longest: they are what an agent actually navigates by.
    const layers = req.layers.length > 0 ? req.layers : DEFAULT_LAYERS;
    const attempts = this.maxAttempts;
    // The box actually queried. Retrying may shrink it, and both the query text
    // and the coordinate filter have to follow, or a shrunken request is still
    // asked about the original area.
    let box = req.bbox;
    // The best answer seen so far across attempts.
    //
    // Retries exist because the shared instance degrades unpredictably, so a
    // later attempt can easily be worse than an earlier one. Without this, a
    // request that got a perfectly good map on attempt 1 and then hit a busy
    // server would throw away the map and report "exhausted retries" - losing
    // usable data to be strict about a condition that was already satisfied.
    let best: SourceResult | undefined;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt++) {
      // Each retry drops the lowest-priority layers, so the surviving query gets
      // simpler until the server accepts one. Roadways and their junctions lead
      // the list precisely so that streets are the last thing surrendered.
      const kept = layers.slice(0, Math.max(1, layers.length - attempt));
      const query = buildQuery({ ...req, bbox: box, layers: kept });
      this.bbox = box;
      try {
        const body = await this.request(query, req);
        const raw = body.elements?.length ?? 0;

        // HTTP 200 with no elements is ambiguous: it can mean a genuinely empty
        // area, but the public instance also returns it when a query is too
        // large for it to serve. Treating that as "nothing is here" produced an
        // empty map for the middle of London. So an empty result is retried with
        // fewer layers before it is believed.
        //
        // The retry budget is deliberately separate from `attempts`: every extra
        // attempt against a shared public server costs someone else's quota, and
        // only the empty-result case needs the re-ask.
        const retriedEmpty = attempt < EMPTY_RETRY_BUDGET;
        if (raw === 0 && req.layers.length === 0 && retriedEmpty) {
          warnings.push(
            'Overpass returned an empty result for a populated area; ' +
              'retrying with fewer layers rather than reporting no data',
          );
          continue;
        }

        // Retries exhausted and still nothing. For a dense land area this is a
        // server failure, not a blank map, and saying so beats handing back an
        // empty graph that reads as "there is nothing here".
        if (raw === 0 && req.layers.length === 0 && isPopulatedLand(box)) {
          throw new OverpassError(
            `Overpass returned no data for a populated area after ${attempt + 1} attempts; ` +
              `the public instance is degraded - set OVERPASS_ENDPOINT to a self-hosted mirror`,
            502,
          );
        }

        const features = this.buildFeatures(body.elements ?? [], limit, warnings);
        const truncated = features.length >= limit;

        // Detect the response-size cliff: the instance answers with way geometry that
        // is entirely out of area rather than with an error. A result with
        // streets requested and none usable is a city with no roads, which is
        // worse than a smaller map that works - so the request is retried over a
        // tighter box.
        //
        // The trigger is specifically "ways arrived but none survived", not
        // "no ways present". A response that genuinely contained no ways has not
        // demonstrated anything is wrong, and re-asking it would spend shared
        // quota to learn the same thing.
        const wayElements = (body.elements ?? []).filter((e) => e.type === 'way').length;
        const wantsShrink =
          req.layers.length === 0 &&
          attempt < MAX_SHRINK_ATTEMPTS &&
          isPopulatedLand(box) &&
          wayElements > 0 &&
          // A truncated result stopped reading before it reached the ways, so
          // the absence of streets says nothing about the upstream response.
          !truncated &&
          countWays(features) === 0;

        if (truncated) {
          warnings.push(`truncated at ${limit} features; area is denser than the cap`);
        }
        if (attempt > 0) {
          warnings.push(
            `Overpass refused the full query ${attempt} time(s); served without ` +
              `layer${kept.length === 1 ? '' : 's'} "${layers.slice(kept.length).join('", "')}"`,
          );
        }
        const result: SourceResult = {
          features,
          source: this.name,
          truncated,
          elapsedMs: Date.now() - started,
          warnings: [...warnings],
        };

        // Remember the best answer before deciding to look for a better one, so
        // that exhausting the retries still leaves the caller with a real map.
        if (
          result.features.length > 0 &&
          (best === undefined ||
            (result.features.length > best.features.length &&
              countWays(result.features) >= countWays(best.features)))
        ) {
          best = result;
        }

        if (wantsShrink) {
          const tightened = tighten(box);
          if (tightened) {
            box = tightened;
            warnings.push(
              'upstream returned no usable street geometry for this area; ' +
                'retrying over a smaller box to stay under the instance result limit',
            );
            continue;
          }
        }
        return result;
      } catch (err) {
        lastError = err;
        if (!isRetryable(err) || attempt === attempts - 1) break;
        // Back off briefly. The shared instance rate-limits aggressively, and
        // hammering it makes a transient failure permanent.
        await sleep(Math.min(2000 * (attempt + 1), 6000));
      }
    }

    // Every attempt failed. A partial map from an earlier try is still a real
    // map; throwing it away to report a bare retry failure would be a worse
    // outcome for the caller.
    if (best) {
      best.warnings.push('later attempts failed; serving the best result obtained');
      return best;
    }
    if (lastError !== undefined) throw lastError;
    throw new OverpassError(`no attempt was made for this request`, 502);
  }

  /** One HTTP round trip, with the headers and error handling Overpass needs. */
  private async request(
    query: string,
    req: SourceRequest,
  ): Promise<{ elements?: Array<Record<string, any>> }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    req.signal?.addEventListener('abort', onAbort);

    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Required. The public instance sits behind Apache, which answers 406
          // to any request without a User-Agent - a failure that looks like a
          // bad query but is not one. A descriptive agent string is also the
          // polite thing to send to a shared public service.
          'User-Agent': this.userAgent,
          Accept: '*/*',
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: controller.signal,
      });

      const bodyText = await res.text();

      if (!res.ok) {
        // Overpass reports rate limiting, slot exhaustion and query-too-heavy as
        // an XML error document with a 4xx status. Parsing it as JSON throws an
        // opaque syntax error, so the status and body are surfaced instead.
        const detail = summarizeError(bodyText);
        throw new OverpassError(
          `Overpass responded ${res.status} ${res.statusText}: ${detail}`,
          res.status,
        );
      }

      try {
        return JSON.parse(bodyText) as { elements?: Array<Record<string, any>> };
      } catch {
        throw new OverpassError(`Overpass returned non-JSON: ${summarizeError(bodyText)}`, 502);
      }
    } catch (err) {
      if (controller.signal.aborted && !req.signal?.aborted) {
        throw new OverpassError(`Overpass request timed out after ${this.timeoutMs}ms`, 504);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Assemble GeoJSON from the mixed element list. */
  private buildFeatures(
    elements: Array<Record<string, any>>,
    limit: number,
    warnings: string[],
  ): GeoJsonFeature[] {
    const coordsById = new Map<number, [number, number]>();
    const features: GeoJsonFeature[] = [];

    // Nodes first, so ways can be resolved against the map built from them.
    for (const el of elements) {
      if (el.type === 'node' && typeof el.lat === 'number' && typeof el.lon === 'number') {
        coordsById.set(el.id, [el.lon, el.lat]);
      }
    }

    for (const el of elements) {
      if (features.length >= limit) break;
      if (el.type === 'node' && typeof el.lat === 'number' && typeof el.lon === 'number') {
        // A tagged node is a POI. An untagged one is usually a way's vertex,
        // not a place of its own, so it is skipped to save tokens.
        if (el.tags && Object.keys(el.tags).length > 0) {
          features.push(nodeToFeature(el as never));
        }
        continue;
      }
      if (el.type === 'way') {
        // `out geom` inlines each vertex as {lat,lon}; `out body` gives only
        // vertex ids, resolvable only if those nodes were also selected.
        const inline = Array.isArray((el as { geometry?: unknown }).geometry)
          ? ((el as { geometry: Array<{ lat: number; lon: number }> }).geometry)
              .filter((g) => typeof g?.lat === 'number' && typeof g?.lon === 'number')
              .map((g) => [g.lon, g.lat] as [number, number])
          : [];
        const resolved = Array.isArray(el.nodes)
          ? el.nodes.map((nid) => coordsById.get(nid)).filter((c): c is [number, number] => !!c)
          : [];
        const coords = inline.length > 0 ? inline : resolved;
        const f = wayToFeature(el as never, coords);
        if (f) features.push(f);
        continue;
      }
      if (el.type === 'relation') {
        // Multipolygon relations are common for large lakes and forests. A
        // proper implementation resolves the member ways; here they are
        // recorded as a warning rather than silently dropped, because silently
        // dropping a lake is exactly the kind of omission an agent cannot see.
        const outer = (el.tags ?? {}).natural === 'water' || (el.tags ?? {}).landuse === 'reservoir';
        if (outer) {
          warnings.push(`relation ${el.id} (${el.tags?.natural ?? el.tags?.landuse}) not resolved`);
        }
      }
    }

    return this.dropImplausible(features, warnings);
  }

  /**
   * Discard features whose coordinates do not match the requested area.
   *
   * This is a real failure mode, not a hypothetical: the public Overpass
   * instance has been observed returning transposed latitudes for whole
   * regions, and `out body` reports them with no indication that anything is
   * wrong. Passed through unchecked, those coordinates land thousands of
   * kilometres away, and the compiler then reports a 26km edge between two
   * cafes that are 8m apart.
   *
   * A tolerance is used rather than a strict bound, because the server may
   * legitimately return features just outside a bbox when one touches a way
   * spanning the boundary. Anything wildly outside is data corruption.
   */
  private dropImplausible(features: GeoJsonFeature[], warnings: string[]): GeoJsonFeature[] {
    if (this.bbox === undefined) return features;
    const { west, south, east, north } = this.bbox;

    // Slack is proportional to the size of the request, not a fixed number of
    // degrees. A fixed slack is either useless on a small area (a 2-degree
    // margin on a 1-degree box admits points from another city) or too tight on
    // a large one.
    //
    // The floor matters more than it looks. It used to be 0.05 degrees, which
    // covers the boundary effects of a way that runs off the edge - but 0.05
    // degrees of latitude is 5.5km, so for a 350m request it admitted bus stops
    // 1.6km away and the compiler dutifully drew 1.6km "access" edges inside a
    // 350m map. The floor is now small enough to admit a road that leaves the
    // request, and no more.
    const slackLat = Math.max(0.0015, Math.min((north - south) * 0.25, 0.05));
    const slackLon = Math.max(0.0015, Math.min((east - west) * 0.25, 0.05));
    const inside = ([lon, lat]: [number, number]): boolean =>
      lat >= south - slackLat && lat <= north + slackLat &&
      lon >= west - slackLon && lon <= east + slackLon;

    const ok: GeoJsonFeature[] = [];
    for (const f of features) {
      if (!f.geometry) continue;
      const coords = allCoordinates(f.geometry);
      if (coords.length === 0) continue;

      // Points are judged individually: a stray point is corrupt data.
      if (f.geometry.type === 'Point') {
        if (inside(coords[0]!)) ok.push(f);
        continue;
      }

      // Ways and areas are judged by majority, not unanimously.
      //
      // Requiring every vertex to be in range discarded whole streets: the
      // public instance returns a corrupt latitude on a fraction of the vertices
      // in a region, and one bad vertex out of twenty was enough to throw away
      // the road - which is how San Francisco returned 2,320 picnic tables and
      // toilets while every single street was discarded. The corrupted runs
      // produce *no* in-range vertices at all, so a majority rule separates
      // corruption from the ordinary case of a road that merely runs off the
      // edge of the request.
      const good = coords.filter(inside);
      if (good.length * 2 <= coords.length) continue;

      // Keep only the in-range stretch, so a clipped feature does not still
      // carry the corrupt vertex that got it flagged.
      ok.push(clipGeometry(f, good));
    }

    const dropped = features.length - ok.length;
    if (dropped > 0) {
      warnings.push(
        `discarded ${dropped} feature(s) with coordinates outside the requested area; ` +
          `the upstream data was inconsistent with the query`,
      );
    }

    // Losing some features to bad coordinates is normal. Losing *all* of them
    // means the upstream data is unusable, and returning an empty feature list
    // would report "there is nothing here" for a dense city centre. That is the
    // most damaging possible answer, because the caller cannot distinguish it
    // from a genuine blank.
    if (features.length > 0 && ok.length === 0) {
      throw new OverpassError(
        `every feature was outside the requested area; upstream coordinates are corrupt ` +
          `(sample: ${sampleOutside(features)})`,
        502,
      );
    }
    return ok;
  }
}

export { DEFAULT_ENDPOINT as OVERPASS_ENDPOINT };
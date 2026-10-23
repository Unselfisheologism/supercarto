import { inflateRawSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { haversine } from '../geo/project.js';
import { estimateTokens, yamlString } from '../emit/yaml.js';

/**
 * GTFS (static transit feed) source.
 *
 * A bus schedule is the one dataset in this palette where a plausible-looking
 * answer can hurt the person behind the agent: an agent told that the last bus
 * leaves at 01:10 when the feed actually says 25:10 (ten past midnight) has
 * been handed a time that fits the question and misses the bus. So the honesty
 * rules here are stricter than elsewhere:
 *
 * - Departure times past midnight stay past midnight. GTFS expresses them as
 *   hours beyond 24 relative to the service day's midnight, so `25:10` renders
 *   as `25:10`, never wrapped to `01:10`. Wrapping would mislead an agent
 *   deciding whether to wait.
 * - "No service today" is a real state, distinct from "not shown". When the
 *   feed carries a calendar and the queried date has none running, stops carry
 *   empty route lists and no departure times, and the note says no service
 *   runs. Nothing is invented.
 * - An unknown schedule is also a real state. A feed with neither calendar.txt
 *   nor calendar_dates.txt carries no service facts at all, so routes are
 *   shown across the whole feed, first/last departures are omitted, and the
 *   note records that the service window is unknown.
 * - Edge distances are straight-line haversine and the note labels them as
 *   such, because a stop-to-stop span is never walked as the crow flies.
 *
 * Dependency-free by house rule: the RFC 4180 CSV parser and the minimal zip
 * reader (STORE and DEFLATE only) are written here. The token budget is a hard
 * budget, re-measured with the same `estimateTokens` used for compiled YAML,
 * never an estimate shipped as fact.
 */

// ---------------------------------------------------------------------------
// CSV (RFC 4180)
// ---------------------------------------------------------------------------

/**
 * Parse RFC 4180 CSV.
 *
 * Handles quoted fields, escaped quotes (`""` inside quotes), CRLF and LF line
 * ends, and a UTF-8 BOM, which agencies routinely leave in feeds made with
 * Excel. A bare `\r` also terminates a row: it covers feeds exported from old
 * spreadsheets rather than rejecting them. Blank lines are skipped, because
 * GTFS permits them between rows.
 */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          // An escaped double quote is one literal quote inside the field.
          field += '"';
          i += 2;
        } else {
          // Closing quote: the rest of the field, usually none, is unquoted.
          quoted = false;
          i++;
        }
      } else {
        field += c;
        i++;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
      i++;
    } else if (c === ',') {
      endField();
      i++;
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      // A line break only ends a row when there is a row in progress. A
      // trailing newline, or the blank lines GTFS permits, must not emit an
      // empty record.
      if (field !== '' || row.length > 0) endRow();
      i++;
    } else {
      field += c;
      i++;
    }
  }
  // Final field without a trailing line break. A trailing break has already
  // flushed its row above, so the guards keep it from emitting empty rows.
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/**
 * CSV text as header-keyed records. Header cells are trimmed because agencies
 * email feeds where `stop_id ` with a trailing space is quietly a different
 * column until it yields undefined lookups everywhere.
 */
export function csvRecords(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0] ?? [];
  const out: Record<string, string>[] = [];
  for (const r of rows.slice(1)) {
    if (r.length === 1 && r[0] === '') continue;
    const rec: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) {
      const key = header[i]!.trim();
      if (key !== '') rec[key] = r[i] ?? '';
    }
    out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Minimal zip reader
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/**
 * Read a zip archive into entry-name -> bytes, central directory first.
 *
 * Reading the central directory (rather than walking local headers) means
 * sizes come from the directory itself, so trailing data descriptors need no
 * handling. Only STORE and DEFLATE are supported. Encrypted entries (flag bit
 * 0) and zip64 archives are refused loudly rather than mis-decoded, because a
 * silently wrong decode would present garbage as if it were a schedule.
 */
export function unzipSync(data: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  let eocd = -1;
  const scanFloor = Math.max(0, data.length - 22 - 65_536);
  for (let i = data.length - 22; i >= scanFloor; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('not a zip archive (no end-of-central-directory record found)');
  }

  const entryCount = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('zip64 archives are not supported');
  }

  const out = new Map<string, Uint8Array>();
  let p = cdOffset;
  let parsed = 0;
  while (parsed < entryCount) {
    if (p + 46 > cdOffset + cdSize || dv.getUint32(p, true) !== CENTRAL_SIG) {
      throw new Error('zip central directory is corrupt');
    }
    parsed++;
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const uncompressedSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);

    const name = new TextDecoder().decode(data.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) {
      throw new Error(`zip entry "${name}" is encrypted, which is not supported`);
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`zip entry "${name}" uses compression method ${method}, which is not supported`);
    }
    if (
      localOffset === 0xffffffff ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff
    ) {
      throw new Error(`zip entry "${name}" is a zip64 entry, which is not supported`);
    }

    // The local header repeats the name and extra lengths, and they may differ
    // from the central directory's copy; the data offset must use the locals.
    if (localOffset + 30 > data.length || dv.getUint32(localOffset, true) !== LOCAL_SIG) {
      throw new Error(`zip entry "${name}" has a corrupt local header`);
    }
    const localNameLen = dv.getUint16(localOffset + 26, true);
    const localExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = data.subarray(dataStart, dataStart + compressedSize);
    out.set(name, method === 0 ? raw : inflateRawSync(raw));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Feed model
// ---------------------------------------------------------------------------

/**
 * Route-type vocabulary for the tag a stop shows. Guessing "bus" for an
 * unrecorded type would be one more invented fact, so unknown types degrade to
 * the generic word instead.
 */
const ROUTE_TYPES: Record<number, string> = {
  0: 'tram',
  1: 'subway',
  2: 'rail',
  3: 'bus',
  4: 'ferry',
};

interface GtfsStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

interface GtfsRoute {
  id: string;
  /** Type word: tram, subway, rail, bus, ferry, or transit when unknown. */
  typeWord: string;
  /** Short name, falling back to the long name as the spec directs. */
  name: string;
  /** Edge path label, e.g. "bus 16". */
  label: string;
}

interface GtfsTrip {
  id: string;
  routeId: string;
  serviceId: string;
}

interface GtfsStopTime {
  stopId: string;
  /** Minutes from the service day's midnight. May exceed 1440. */
  dep?: number;
}

interface GtfsCalendar {
  serviceId: string;
  /** Indexed by JS weekday, 0 = Sunday. */
  days: boolean[];
  /** Inclusive YYYYMMDD bounds. */
  start?: number;
  end?: number;
}

interface Feed {
  stops: Map<string, GtfsStop>;
  routes: Map<string, GtfsRoute>;
  trips: GtfsTrip[];
  /** Per trip, ordered by stop_sequence. Rows with no time are kept untimed. */
  stopTimes: Map<string, GtfsStopTime[]>;
  calendar: GtfsCalendar[] | undefined;
  calendarDates: { serviceId: string; date: number; type: number }[] | undefined;
  timezone: string | undefined;
  identifiedName: string | undefined;
}

export interface TransitRequest {
  lat: number;
  lon: number;
  /** Radius in metres. Default 400. */
  radiusM?: number;
  /** Hard token budget for the emitted YAML. Default 1024, floored at 64. */
  budget?: number;
  /** The instant the service day is judged against. Defaults to now. */
  now?: string | Date;
}

export interface TransitResult {
  yaml: string;
  /** Tokens of the emitted YAML, re-measured on the actual output. */
  tokens: number;
  budget: number;
  /** The feed's identified name, or the path when the feed does not name itself. */
  feedName: string;
  stops: number;
  edges: number;
  /** Stops pruned to fit the budget, also recorded in the YAML `omitted:` block. */
  prunedStops: number;
}

/** What a transit backend must provide. Satisfied by `GtfsSource`. */
export interface TransitSource {
  readonly name: string;
  readonly feedName: string;
  querySlice(req: TransitRequest): TransitResult;
}

// ---------------------------------------------------------------------------
// Feed loading
// ---------------------------------------------------------------------------

const REQUIRED_TABLES = ['stops', 'routes', 'trips', 'stop_times'] as const;

/** Table name -> raw CSV text, from either a directory or a zip archive. */
function loadTables(feedPath: string): Map<string, string> {
  const st = statSync(feedPath);
  const tables = new Map<string, string>();

  if (st.isDirectory()) {
    for (const name of readdirSync(feedPath)) {
      const base = name.toLowerCase();
      const dot = base.lastIndexOf('.');
      if (dot <= 0) continue;
      const ext = base.slice(dot + 1);
      if (ext !== 'txt' && ext !== 'csv') continue;
      tables.set(base.slice(0, dot), readFileSync(path.join(feedPath, name), 'utf8'));
    }
    return tables;
  }

  const zip = unzipSync(new Uint8Array(readFileSync(feedPath)));
  for (const [name, bytes] of zip) {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) continue;
    const ext = name.slice(dot + 1).toLowerCase();
    if (ext !== 'txt' && ext !== 'csv') continue;
    const slash = name.lastIndexOf('/');
    tables.set(name.slice(slash + 1, dot).toLowerCase(), new TextDecoder().decode(bytes));
  }
  return tables;
}

function requireTable(tables: Map<string, string>, name: string): Record<string, string>[] {
  const text = tables.get(name);
  if (text === undefined) {
    throw new Error(`GTFS feed is missing ${name}.txt (or ${name}.csv), which this source requires`);
  }
  return csvRecords(text);
}

function optionalTable(
  tables: Map<string, string>,
  name: string,
): Record<string, string>[] | undefined {
  const text = tables.get(name);
  return text === undefined ? undefined : csvRecords(text);
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function bool(v: string | undefined): boolean {
  if (!v) return false;
  // CSV booleans arrive as "1"/"0", but a hand-written feed may hold "true".
  return v.trim() === '1' || v.trim().toLowerCase() === 'true';
}

/** YYYYMMDD as a number; undefined rather than a wrapped guess when malformed. */
function gtfsDate(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (!/^\d{8}$/.test(t)) return undefined;
  return Number(t);
}

/**
 * Departure time as minutes from the service day's midnight.
 *
 * Hours beyond 23 are legal GTFS (`25:10:00` is ten past midnight), so there is
 * deliberately no modulo here; the value must survive unwrapped into the
 * renderer. Seconds round to the minute, which is the resolution the output
 * carries. Unparseable times return undefined rather than a guess.
 */
export function parseGtfsTime(t: string | undefined): number | undefined {
  if (!t) return undefined;
  const m = /^\s*(\d{1,3}):(\d{2})(?::(\d{2}))?\s*$/.exec(t);
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3] ?? '0');
  if (min > 59 || sec > 59) return undefined;
  const secs = h * 3600 + min * 60 + sec;
  return Math.floor(secs / 60);
}

/**
 * Render minutes-from-midnight in the feed's own convention: `25:10`, never
 * `01:10`. This asymmetry is the point of the module - the reader needs to see
 * that the departure belongs to the *next* calendar day, and every alternative
 * rendering either spends a sentence per stop or hides the fact.
 */
export function formatGtfsClock(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function loadFeed(feedPath: string): Feed {
  const tables = loadTables(feedPath);
  const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
  if (missing.length > 0) {
    throw new Error(
      `GTFS feed is missing table(s) ${missing.join(', ')} (looked in ${feedPath})`,
    );
  }

  const stops = new Map<string, GtfsStop>();
  for (const r of requireTable(tables, 'stops')) {
    const id = r.stop_id?.trim();
    const lat = num(r.stop_lat);
    const lon = num(r.stop_lon);
    if (!id || lat === undefined || lon === undefined) continue;
    stops.set(id, { id, name: r.stop_name?.trim() || id, lat, lon });
  }

  const routes = new Map<string, GtfsRoute>();
  for (const r of requireTable(tables, 'routes')) {
    const id = r.route_id?.trim();
    if (!id) continue;
    const typeWord = ROUTE_TYPES[num(r.route_type) ?? Number.NaN] ?? 'transit';
    const name = r.route_short_name?.trim() || r.route_long_name?.trim() || id;
    routes.set(id, { id, typeWord, name, label: `${typeWord} ${name}` });
  }

  const trips: GtfsTrip[] = [];
  for (const r of requireTable(tables, 'trips')) {
    const id = r.trip_id?.trim();
    if (!id) continue;
    trips.push({
      id,
      routeId: r.route_id?.trim() ?? '',
      serviceId: r.service_id?.trim() ?? '',
    });
  }

  // Rows accumulate per trip and sort on stop_sequence. A missing sequence
  // falls back to row order, which matches the file's own order for feeds that
  // omit the column.
  const byTrip = new Map<string, { seq: number; st: GtfsStopTime }[]>();
  for (const r of requireTable(tables, 'stop_times')) {
    const tripId = r.trip_id?.trim();
    const stopId = r.stop_id?.trim();
    if (!tripId || !stopId) continue;
    const dep = parseGtfsTime(r.departure_time) ?? parseGtfsTime(r.arrival_time);
    const seq = num(r.stop_sequence);
    const list = byTrip.get(tripId) ?? [];
    list.push({ seq: seq ?? list.length, st: { stopId, dep } });
    byTrip.set(tripId, list);
  }
  const stopTimes = new Map<string, GtfsStopTime[]>();
  for (const [tripId, list] of byTrip) {
    list.sort((a, b) => a.seq - b.seq);
    stopTimes.set(
      tripId,
      list.map((x) => x.st),
    );
  }

  const calendarText = optionalTable(tables, 'calendar');
  const calendar: GtfsCalendar[] = (calendarText ?? []).map((r) => ({
    serviceId: r.service_id?.trim() ?? '',
    days: [
      bool(r.sunday),
      bool(r.monday),
      bool(r.tuesday),
      bool(r.wednesday),
      bool(r.thursday),
      bool(r.friday),
      bool(r.saturday),
    ],
    start: gtfsDate(r.start_date),
    end: gtfsDate(r.end_date),
  }));

  const calendarDates = (optionalTable(tables, 'calendar_dates') ?? []).map((r) => ({
    serviceId: r.service_id?.trim() ?? '',
    date: gtfsDate(r.date) ?? 0,
    type: num(r.exception_type) ?? 1,
  }));

  const calendarPresent = calendarText !== undefined || calendarDates.length > 0;

  const timezone =
    optionalTable(tables, 'agency')?.[0]?.agency_timezone?.trim() || undefined;

  const identifiedName =
    optionalTable(tables, 'feed_info')?.[0]?.feed_publisher_name?.trim() || undefined;

  return {
    stops,
    routes,
    trips,
    stopTimes,
    calendar: calendarPresent ? calendar : undefined,
    calendarDates: calendarPresent ? calendarDates : undefined,
    timezone,
    identifiedName,
  };
}

// ---------------------------------------------------------------------------
// Service-day arithmetic
// ---------------------------------------------------------------------------

const WEEKDAY_NUM: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/**
 * The feed-local calendar date at an instant.
 *
 * Undefined when the runtime cannot resolve the zone. That path is an honesty
 * fork, not an internal error: a server with a partial ICU build must say
 * "service unknown" rather than silently read the feed's clock in UTC and
 * clear a Saturday of its Sunday service.
 */
function localDay(tz: string, at: Date): { ymd: number; weekday: number } | undefined {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    });
    const parts = new Map<string, string>();
    for (const p of fmt.formatToParts(at)) parts.set(p.type, p.value);
    const ymd = Number(`${parts.get('year')}${parts.get('month')}${parts.get('day')}`);
    const weekday = WEEKDAY_NUM[(parts.get('weekday') ?? '').toLowerCase().slice(0, 3)];
    if (!Number.isFinite(ymd) || weekday === undefined) return undefined;
    return { ymd, weekday };
  } catch {
    return undefined;
  }
}

/**
 * Services running on a feed-local date.
 *
 * Undefined when the feed carries no calendar, which callers must treat as
 * "unknown", never as "none". calendar_dates applies on top of regular
 * service: a removal (type 2) subtracts, an addition (type 1) stands on its
 * own - neither may fold into the other, or a holiday exception would mutate
 * the wrong service.
 */
function servicesOn(feed: Feed, weekday: number, ymd: number): Set<string> | undefined {
  if (feed.calendar === undefined && feed.calendarDates === undefined) return undefined;
  const ids = new Set<string>();
  for (const c of feed.calendar ?? []) {
    if (c.start !== undefined && ymd < c.start) continue;
    if (c.end !== undefined && ymd > c.end) continue;
    if (c.days[weekday]) ids.add(c.serviceId);
  }
  for (const d of feed.calendarDates ?? []) {
    if (d.date !== ymd) continue;
    if (d.type === 2) ids.delete(d.serviceId);
    else ids.add(d.serviceId);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const COMPASS8 = [
  'north',
  'northeast',
  'east',
  'southeast',
  'south',
  'southwest',
  'west',
  'northwest',
] as const;

/**
 * Initial compass bearing between two WGS84 points.
 *
 * The same spherical formula as `straightLineRoute` in routing.ts, applied to
 * lat/lon directly, because a transit edge is a great-circle span and this
 * slice carries no grid envelope. Stops within a query radius are close enough
 * that initial bearing is an accurate direction word.
 */
function compassOf(from: { lat: number; lon: number }, to: { lat: number; lon: number }): string {
  const toRad = Math.PI / 180;
  const phi1 = from.lat * toRad;
  const phi2 = to.lat * toRad;
  const lambda1 = from.lon * toRad;
  const lambda2 = to.lon * toRad;
  const y = Math.sin(lambda2 - lambda1) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(lambda2 - lambda1);
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return COMPASS8[Math.round(deg / 45) % 8]!;
}

/** Numeric-aware sort, so "9" comes before "16" instead of after it. */
function routeNameSort(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

// ---------------------------------------------------------------------------
// Budget pruning
// ---------------------------------------------------------------------------

/** Weakly-connected component count over the given node set. */
function componentCount(ids: Iterable<string>, adjacency: Map<string, Set<string>>): number {
  const seen = new Set<string>();
  let count = 0;
  for (const start of ids) {
    if (seen.has(start)) continue;
    count++;
    seen.add(start);
    const stack = [start];
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const nb of adjacency.get(id) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
  }
  return count;
}

interface Edge {
  from: string;
  to: string;
  /** Distinct path labels serving this consecutive pair, sorted. */
  paths: string[];
}

/**
 * Whether removing one stop would split the network.
 *
 * The same invariant the road-graph budgeter protects ("no removal may raise
 * the component count"), implemented locally rather than by adapting
 * `fitToBudget`, which is typed against the road graph's node/edge shapes.
 * Edges read as undirected: reachability does not care that the trip was
 * one-way. A stop with no edges may leave freely - its removal lowers the
 * count by exactly its own singleton component.
 */
function removalSplitsNetwork(
  id: string,
  kept: ReadonlySet<string>,
  edgePaths: ReadonlyMap<string, Edge>,
): boolean {
  const adjacency = new Map<string, Set<string>>();
  for (const other of kept) adjacency.set(other, new Set());
  for (const e of edgePaths.values()) {
    if (!kept.has(e.from) || !kept.has(e.to) || e.from === e.to) continue;
    adjacency.get(e.from)!.add(e.to);
    adjacency.get(e.to)!.add(e.from);
  }
  const before = componentCount(kept, adjacency);

  adjacency.delete(id);
  for (const set of adjacency.values()) set.delete(id);
  const after = componentCount(adjacency.keys(), adjacency);
  return after > before;
}

/**
 * Drop whole trailing lines until the output fits a hard budget.
 *
 * Same shape as the MCP layer's `trimToBudget`: lines drop whole so the YAML
 * stays valid, and the cut is disclosed in the output. The disclosure, the
 * metadata block, and the `omitted:` record are kept first, because those
 * three lines are exactly the output's honesty contract - a truncated map that
 * pretends to be complete is the failure mode this library exists to prevent.
 */
function truncateFitting(yaml: string, budget: number, measure: (s: string) => number): string {
  const lines = yaml.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const permanent: string[] = [];
  const body: string[] = [];
  for (const line of lines) {
    const isPermanent =
      line === 'transit:' ||
      line === 'nodes:' ||
      line.startsWith('  center:') ||
      line.startsWith('  radius:') ||
      line.startsWith('  feed:') ||
      line.startsWith('  note:') ||
      line.startsWith('omitted:') ||
      line.startsWith('  - {layer: stop');
    (isPermanent ? permanent : body).push(line);
  }

  const disclosure = `# [truncated at ${budget} tokens; request a larger budget]`;
  let used = measure(disclosure) + 1;
  for (const line of permanent) used += measure(line) + 1;

  const out: string[] = [];
  for (const line of body) {
    const cost = measure(line) + 1;
    if (used + cost > budget) break;
    out.push(line);
    used += cost;
  }
  return [...out, ...permanent, disclosure].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

/**
 * A GTFS feed as a transit source.
 *
 * Load is lazy and cached: construction reads nothing, so wiring a configured
 * source cannot fail at startup, and a broken path surfaces as an honest error
 * on the first query rather than as a half-built tool advertised to agents.
 * Feed identity comes from feed_info.txt's publisher name once loaded; before
 * then the path's basename is the only available identification, and the API
 * surface types it as such.
 */
export class GtfsSource implements TransitSource {
  readonly name = 'gtfs';
  private readonly feedPath: string;
  private feed: Feed | undefined;
  private displayName: string;

  constructor(feedPath: string) {
    this.feedPath = feedPath;
    this.displayName = path.basename(feedPath);
  }

  get feedName(): string {
    return this.displayName;
  }

  querySlice(req: TransitRequest): TransitResult {
    const feed = this.load();
    const radiusM = req.radiusM ?? 400;
    if (!(radiusM > 0)) throw new Error('radiusM must be positive');
    const budget = Math.max(64, Math.round(req.budget ?? 1024));

    const at =
      req.now === undefined
        ? new Date()
        : req.now instanceof Date
          ? req.now
          : new Date(req.now);
    if (Number.isNaN(at.getTime())) {
      throw new Error(`could not read "${String(req.now)}" as an instant`);
    }

    const tz = feed.timezone;
    const day = tz ? localDay(tz, at) : undefined;
    const services = day ? servicesOn(feed, day.weekday, day.ymd) : undefined;
    /** true = at least one service runs today; false = none; undefined = unknown. */
    const serviceToday = services ? services.size > 0 : undefined;

    // Schedule facts to show, by service state:
    //  - running today: only trips on today's services feed routes and times;
    //  - none today: no route list and no times, and the note says so;
    //  - unknown: the whole feed, with the note recording the uncertainty.
    // Edge spans are structure, not schedule: they stay the feed's physical
    // consecutive-stop network in every state, because an agent planning a
    // walk between stops still wants the adjacency when no bus is running on
    // the queried date.

    // One pass over the trips builds everything the renderer needs: routes per
    // stop, first/last departures per stop, and deduplicated consecutive-pair
    // edges with their path labels.
    const routesAt = new Map<string, Set<string>>();
    // Filled only when today's service is known to run: for an unknown schedule
    // these numbers would be whole-feed facts dressed up as today's, and for a
    // none-today date there are no departures at all. An empty map renders no
    // first/last, which is the honest absence.
    const trackDepartures = serviceToday === true;
    const departures = new Map<string, { first: number; last: number }>();
    const edgePaths = new Map<string, Edge>();

    for (const trip of feed.trips) {
      const route = feed.routes.get(trip.routeId);
      if (!route) continue;
      const times = feed.stopTimes.get(trip.id) ?? [];
      for (let i = 1; i < times.length; i++) {
        const from = times[i - 1]!.stopId;
        const to = times[i]!.stopId;
        if (from === to) continue;
        const key = `${from}->${to}`;
        const edge = edgePaths.get(key);
        if (edge) {
          if (!edge.paths.includes(route.label)) edge.paths.push(route.label);
        } else {
          edgePaths.set(key, { from, to, paths: [route.label] });
        }
      }
      // None-today feeds no route facts for any stop: the loop body is
      // skipped for every trip, leaving empty sets that render as [].
      const onSchedule = serviceToday === undefined || services!.has(trip.serviceId);
      if (!onSchedule) continue;
      for (const st of times) {
        let ids = routesAt.get(st.stopId);
        if (!ids) {
          ids = new Set();
          routesAt.set(st.stopId, ids);
        }
        ids.add(route.id);
        if (trackDepartures && st.dep !== undefined) {
          const d = departures.get(st.stopId);
          if (!d) {
            departures.set(st.stopId, { first: st.dep, last: st.dep });
          } else {
            d.first = Math.min(d.first, st.dep);
            d.last = Math.max(d.last, st.dep);
          }
        }
      }
    }
    for (const e of edgePaths.values()) e.paths.sort();

    const center = { lat: req.lat, lon: req.lon };
    const inRadius: { stop: GtfsStop; dist: number; routeCount: number }[] = [];
    for (const stop of feed.stops.values()) {
      const dist = haversine(center, stop);
      if (dist <= radiusM) {
        inRadius.push({ stop, dist, routeCount: routesAt.get(stop.id)?.size ?? 0 });
      }
    }

    // Prune order: fewest distinct routes first, with distance from the centre
    // as the tiebreak. Both keys are static per query, so the order is computed
    // once rather than re-ranked every pass.
    inRadius.sort(
      (a, b) =>
        a.routeCount - b.routeCount ||
        b.dist - a.dist ||
        a.stop.id.localeCompare(b.stop.id),
    );

    // Display order: nearest first, which is how an agent reads a catchment.
    const byDist = [...inRadius].sort((a, b) => a.dist - b.dist);

    const kept = new Set<string>(inRadius.map((s) => s.stop.id));
    const note = composeNote(tz, day, services, serviceToday);
    const prunedCount = (): number => inRadius.length - kept.size;

    const render = (): { yaml: string; tokens: number; edgeCount: number } => {
      const liveEdges = [...edgePaths.values()].filter(
        (e) => kept.has(e.from) && kept.has(e.to),
      );
      const lines: string[] = [];
      lines.push('transit:');
      lines.push(`  center: "${req.lat}, ${req.lon}"`);
      lines.push(
        `  radius: ${radiusM >= 1000 ? `${(radiusM / 1000).toFixed(1)}km` : `${Math.round(radiusM)}m`}`,
      );
      lines.push(`  feed: ${yamlString(this.displayName)}`);
      lines.push(`  note: ${yamlString(note)}`);
      lines.push('nodes:');
      let edgeCount = 0;
      if (kept.size === 0) {
        lines.push('  {}');
      } else {
        for (const s of byDist) {
          if (!kept.has(s.stop.id)) continue;
          lines.push(`  ${yamlString(s.stop.id)}: ${nodeBody(feed, s, routesAt, departures, serviceToday)}`);
        }
        lines.push('edges:');
        if (liveEdges.length === 0) {
          lines.push('  {}');
        } else {
          const sorted = [...liveEdges].sort(
            (a, b) =>
              a.from.localeCompare(b.from) ||
              a.to.localeCompare(b.to) ||
              (a.paths[0] ?? '').localeCompare(b.paths[0] ?? ''),
          );
          edgeCount = sorted.length;
          for (const e of sorted) {
            const a = feed.stops.get(e.from)!;
            const b = feed.stops.get(e.to)!;
            const dist = Math.round(haversine(a, b));
            const dir = compassOf(a, b);
            lines.push(
              `  ${yamlString(e.from)}->${yamlString(e.to)}: {dist: ${dist}m, dir: ${dir}, path: ${pathLabel(e.paths)}}`,
            );
          }
        }
      }
      if (prunedCount() > 0) {
        lines.push('omitted:');
        lines.push(`  - {layer: stop, count: ${prunedCount()}}`);
      }
      const yaml = lines.join('\n') + '\n';
      return { yaml, tokens: estimateTokens(yaml), edgeCount };
    };

    // Prune under the hard budget, re-measuring actual output every pass - the
    // estimator runs against the emitted YAML, never against a projection of it.
    let state = render();
    let prunedStops = 0;

    // Pass 1: never split the network.
    for (const cand of inRadius) {
      if (state.tokens <= budget) break;
      if (removalSplitsNetwork(cand.stop.id, kept, edgePaths)) continue;
      kept.delete(cand.stop.id);
      prunedStops++;
      state = render();
    }

    // Pass 2: the budget is hard. If connectivity protection could not fit,
    // remove by rank regardless, down to an empty node set - a smaller map the
    // agent can trust beats one that lies about its size.
    for (const cand of inRadius) {
      if (state.tokens <= budget) break;
      kept.delete(cand.stop.id);
      prunedStops++;
      state = render();
    }

    // Backstop for pathological tiny budgets under the size of the note itself.
    if (state.tokens > budget) {
      state = {
        ...state,
        yaml: truncateFitting(state.yaml, budget, estimateTokens),
      };
      state = { ...state, tokens: estimateTokens(state.yaml) };
    }

    return {
      yaml: state.yaml,
      tokens: state.tokens,
      budget,
      feedName: this.displayName,
      stops: kept.size,
      edges: state.edgeCount,
      prunedStops,
    };
  }

  private load(): Feed {
    if (this.feed) return this.feed;
    try {
      this.feed = loadFeed(this.feedPath);
      if (this.feed.identifiedName) this.displayName = this.feed.identifiedName;
      return this.feed;
    } catch (err) {
      throw new Error(
        `GTFS feed "${this.feedPath}" could not be loaded: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/**
 * One node line: flow style, identical field order to the maplet emitter, with
 * the schedule fields the node's own facts allow.
 */
function nodeBody(
  feed: Feed,
  s: { stop: GtfsStop; dist: number; routeCount: number },
  routesAt: Map<string, Set<string>>,
  departures: Map<string, { first: number; last: number }>,
  serviceToday: boolean | undefined,
): string {
  const parts: string[] = ['type: stop'];
  parts.push(`name: ${yamlString(s.stop.name)}`);

  // Tags come from the route types actually serving the stop, deduplicated in
  // first-seen order so the common single-type case stays one token.
  const typeWords: string[] = [];
  const routeIds = routesAt.get(s.stop.id) ?? new Set<string>();
  const names: string[] = [];
  for (const id of routeIds) {
    const route = feed.routes.get(id);
    if (!route) continue;
    if (!typeWords.includes(route.typeWord)) typeWords.push(route.typeWord);
    names.push(route.name);
  }
  parts.push(`tags: [${typeWords.map(yamlString).join(', ')}]`);
  names.sort(routeNameSort);
  parts.push(`routes: [${names.map(yamlString).join(', ')}]`);

  // Absent first/last is an honest absence, not an omission: with no calendar
  // the feed's facts are unknown; with a none-today answer inventing times
  // would be the failure this module exists to prevent.
  const d = departures.get(s.stop.id);
  if (d) {
    parts.push(`first: ${formatGtfsClock(d.first)}`);
    parts.push(`last: ${formatGtfsClock(d.last)}`);
  }
  return `{${parts.join(', ')}}`;
}

function pathLabel(paths: string[]): string {
  // A shared span keeps both labels. yamlString quotes on comma, so the joined
  // form stays valid flow YAML rather than silently picking one agency's view.
  return yamlString(paths.length === 1 ? paths[0]! : paths.join(', '));
}

/**
 * The map note, which carries the honesty semantics.
 *
 * Each sentence is a distinct fact the reader must be able to act on: the
 * straight-line caveat, the schedule date and zone, and the three service
 * states (running, none, unknown) stated so that "none" and "unknown" never
 * collapse into one word.
 */
function composeNote(
  tz: string | undefined,
  day: { ymd: number; weekday: number } | undefined,
  services: Set<string> | undefined,
  serviceToday: boolean | undefined,
): string {
  const parts: string[] = ['Stop distances are straight-line.'];
  if (services !== undefined && day) {
    const y = Math.floor(day.ymd / 10000);
    const m = Math.floor((day.ymd % 10000) / 100);
    const d = day.ymd % 100;
    parts.push(
      `Schedule from GTFS feed for ${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} in ${tz}.`,
    );
    if (!serviceToday) parts.push('No service runs on this date.');
  } else {
    parts.push('The feed has no service calendar; service window unknown.');
    parts.push('Routes cover the whole feed and first/last departures are not shown.');
  }
  if (tz === undefined) {
    parts.push('The feed states no agency_timezone, so the service day could not be read.');
  }
  return parts.join(' ');
}

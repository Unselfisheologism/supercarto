import { inflateRawSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { haversine } from '../geo/project.js';
import { estimateTokens, yamlString } from '../emit/yaml.js';
import { plainFetch } from './types.js';
import { decodeTripUpdatesFeed, type RtFeed, type RtStopUpdate } from './gtfs-rt.js';

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

export interface TransitRouteRequest {
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  /** Straight-line catchment around each end for finding stops. Default 500, capped at 2000. */
  maxWalkM?: number;
  /** Hard token budget for the emitted YAML. Default 1024, floored at 64. */
  budget?: number;
  /** The instant the plan is judged against. Defaults to now. */
  now?: string | Date;
}

export interface TransitRouteResult {
  yaml: string;
  /** Tokens of the emitted YAML, re-measured on the actual output. */
  tokens: number;
  budget: number;
  /** Ride lines rendered. Zero means the note says exactly which leg failed. */
  plans: number;
}

/** What a transit backend must provide. Satisfied by `GtfsSource`. */
export interface TransitSource {
  readonly name: string;
  readonly feedName: string;
  /**
   * The schedule slice around a point. `rt` is the freshly fetched realtime
   * overlay, optional because nothing guarantees the deployment configured a
   * realtime feed; 0.5.4 shipped this parameter existing on the only
   * implementation while every public entry point called without it, which is
   * why the parameter sits in the interface now - a join wired nowhere is a
   * regression the type system can hear.
   */
  querySlice(req: TransitRequest, rt?: RealtimeOverlay): TransitResult;
  /**
   * The certified ride plan between two points. Optional because an operator
   * could carry another schedule backend behind the interface; `GtfsSource`
   * implements it, and the tool layer advertises the ride-plan tool only
   * through `hasTransit`.
   */
  planTrip?(req: TransitRouteRequest, rt?: RealtimeOverlay): TransitRouteResult;
  /**
   * Fetch the real-time overlay, when this source carries one.
   *
   * Absence means the deployment pointed no realtime feed at the schedule,
   * which the emitted YAML then says plainly.
   */
  realtime?(now?: string | Date): Promise<RealtimeOverlay>;
}

// ---------------------------------------------------------------------------
// Real-time (GTFS-RT TripUpdates)
// ---------------------------------------------------------------------------

/** Configuration for the realtime side of a GTFS feed. */
export interface GtfsRealtimeOptions {
  /** The agency's TripUpdates endpoint. TripUpdates only. */
  url: string;
  /** Injectable fetch, for tests and for runtimes without a global fetch. */
  fetchImpl?: typeof fetch;
  /** Abort the fetch after this many ms. Default 8000. */
  timeoutMs?: number;
}

export type RealtimeState = 'live' | 'unavailable';

/**
 * What the schedule path needs to annotate departures.
 *
 * The work of joining predictions onto stops happens once per fetch, so the
 * synchronous render stays a renderer. Every state name is one an agent can
 * act on: "unknown" and "on time" are different words here, and the map note
 * carries that distinction even when this map is empty.
 */
export interface RealtimeOverlay {
  state: RealtimeState;
  /** When the fetch happened, epoch ms. */
  fetchedAt: number;
  /** The feed's own dataset stamp, epoch seconds, when the feed sent one. */
  headerTime?: number;
  /** Trip updates decoded, when the feed answered. */
  updates?: number;
  /** Why the feed is unavailable, short and renderer-suitable. */
  reason?: string;
  /** stopId -> entries, e.g. `bus 16 +330s` or `bus 16 cancelled`. */
  stops: Map<string, string[]>;
  /**
   * Trip- and stop-keyed prediction suffixes, e.g. `T1|S2` -> `+330s` or
   * `cancelled`. The renderer joins these onto the next-departure board,
   * so one prediction can decorate both a stop's live list and the
   * departing row without the two attributes disagreeing.
   */
  predict?: Map<string, string>;
}

/** Real-time fetches get a short leash: a schedule answer must not hang. */
export const RT_TIMEOUT_MS = 8000;

/**
 * Epoch seconds for "the feed's service day at local clock H:MM(:SS)".
 *
 * GTFS times are wall-clock minutes in the feed's own timezone, and agency
 * predictions are absolute seconds. Joining them is a timezone offset
 * computed at the service date, not a fixed UTC shift, and the offset is
 * readable from Intl: format the instant as local parts and compare seconds.
 * Two iterations because a first guess can straddle a DST boundary.
 */
function zonedEpochSeconds(
  tz: string,
  y: number,
  m: number,
  d: number,
  minutesFromMidnight: number,
): number | undefined {
  const hires = minutesFromMidnight * 60;
  const hh = Math.floor(hires / 3600);
  const mm = Math.floor((hires % 3600) / 60);
  const ss = Math.round(hires % 60);
  // Overflowing hours (>24, GTFS times run past midnight) roll into the next
  // calendar day via Date.UTC's own arithmetic.
  let guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(guess));
    const get = (type: string): number => Number(item(parts, type));
    const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    guess = Date.UTC(y, m - 1, d, hh, mm, ss) - (local - guess);
  }
  return Math.round(guess / 1000);
}

function item(parts: Intl.DateTimeFormatPart[], type: string): string {
  const hit = parts.find((p) => p.type === type);
  return hit ? hit.value : '0';
}

/** Where an update's stop lives in the static feed. */
interface MatchedStop {
  stopId: string;
  /** Scheduled departure, minutes from service midnight, when the row timed. */
  dep?: number;
  /** The stop_times row that matched, for excluding from trip-level fallback. */
  index: number;
}

/**
 * Resolve an update to its stop row.
 *
 * `stop_id` is the direct join when the feed sends it; `stop_sequence` maps
 * through the trip's ordered stop_times rows, which is how most feeds address
 * mid-trip stops. An update giving neither is the spec saying it attached to
 * nothing we can name, so we leave it unjoined rather than guessing.
 */
function rowIndexFor(
  s: RtStopUpdate,
  rows: GtfsStopTime[] | undefined,
): MatchedStop | undefined {
  if (s.stopId !== undefined) {
    const index = rows ? rows.findIndex((r) => r.stopId === s.stopId) : -1;
    return {
      stopId: s.stopId,
      dep: index >= 0 ? rows![index]!.dep : undefined,
      index: Math.max(index, 0),
    };
  }
  const seq = s.stopSequence;
  if (seq !== undefined && rows && seq >= 1 && seq <= rows.length) {
    const row = rows[seq - 1]!;
    return { stopId: row.stopId, dep: row.dep, index: seq - 1 };
  }
  return undefined;
}

/** Signed whole seconds, e.g. -45 -> '-45s'. */
function signed(seconds: number): string {
  return `${seconds < 0 ? '-' : '+'}${Math.abs(Math.round(seconds))}s`;
}

/**
 * One rider-facing live line: the route label against its delay, or the
 * cancelled state the operator asserted.
 *
 * A prediction given as absolute time converts against the scheduled epoch
 * through the feed timezone. When the schedule row is untimed there is
 * nothing to convert against - saying "+90s" with no schedule to be early or
 * late over would invent a baseline - so the row stays off the live list.
 */
/**
 * One prediction's suffix: the part after the route label.
 *
 * `+300s` for a delay, `cancelled` for a SKIPPED relation, undefined when the
 * feed said nothing renderable. Keeping the suffix separate from the render
 * line lets the same prediction decorate both a stop's live list and the
 * next-departure board without the two attributes saying different things.
 */
function stopSuffix(
  s: RtStopUpdate,
  dep: number | undefined,
  tz: string | undefined,
  day: { ymd: number; weekday: number } | undefined,
): string | undefined {
  if (s.scheduleRelationship === 1) return 'cancelled';
  const ev = s.departure ?? s.arrival;
  if (ev === undefined) return undefined;
  if (ev.delay !== undefined) return signed(ev.delay);
  if (ev.time !== undefined && tz && day && dep !== undefined) {
    const y = Math.floor(day.ymd / 10000);
    const m = Math.floor((day.ymd % 10000) / 100);
    const d = day.ymd % 100;
    const epoch = zonedEpochSeconds(tz, y, m, d, dep);
    if (epoch !== undefined) return signed(ev.time - epoch);
  }
  return undefined;
}

/** Keep at most three live lines per stop; the rest is an honest count. */
function pushLive(store: Map<string, string[]>, stopId: string, entry: string): void {
  const got = store.get(stopId);
  if (got) {
    if (!got.includes(entry) && got.length < 3) got.push(entry);
    return;
  }
  store.set(stopId, [entry]);
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
/** Minutes through the local day at `at`, for "has this bus left yet" checks. */
function localMinutes(tz: string, at: Date): number | undefined {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = new Map<string, string>();
    for (const p of fmt.formatToParts(at)) parts.set(p.type, p.value);
    const h = Number(parts.get('hour') ?? 'NaN');
    const m = Number(parts.get('minute') ?? 'NaN');
    if (!Number.isFinite(h) || !Number.isFinite(m)) return undefined;
    return (h % 24) * 60 + m;
  } catch {
    return undefined;
  }
}

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
  private readonly rtConfig: GtfsRealtimeOptions | undefined;

  constructor(feedPath: string, realtime?: GtfsRealtimeOptions) {
    this.feedPath = feedPath;
    this.displayName = path.basename(feedPath);
    this.rtConfig = realtime;
  }

  get feedName(): string {
    return this.displayName;
  }

  /**
   * Fetch the real-time TripUpdates overlay and join it onto the schedule.
   *
   * This never throws. A schedule answer must keep working when the
   * prediction feed is down, so every failure lands as an `unavailable`
   * overlay with a reason the map note can quote - the honest state, not an
   * absent `get_transit`.
   */
  async realtime(now?: string | Date): Promise<RealtimeOverlay> {
    if (!this.rtConfig) {
      return {
        state: 'unavailable',
        fetchedAt: Date.now(),
        reason: 'no real-time feed configured',
        stops: new Map(),
      };
    }

    const fetchedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.rtConfig?.timeoutMs ?? RT_TIMEOUT_MS);
    try {
      const res = await (this.rtConfig.fetchImpl ?? plainFetch)(this.rtConfig.url, {
        signal: controller.signal,
      });
      if (!res.ok) {
        return {
          state: 'unavailable',
          fetchedAt,
          reason: String(res.status),
          stops: new Map(),
        };
      }
      const decoded = await decodeTripUpdatesFeed(new Uint8Array(await res.arrayBuffer()));
      return this.joinRealtime(decoded, now, fetchedAt);
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'AbortError'
          ? 'timed out'
          : String(err instanceof Error ? err.message : err).slice(0, 60);
      return { state: 'unavailable', fetchedAt, reason, stops: new Map() };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Join decoded trip updates onto static stop rows.
   *
   * Precedence follows the GTFS-RT spec: an explicit StopTimeUpdate wins over
   * the trip-level delay, an absolute `time` converts against the scheduled
   * epoch through the feed's timezone, and a SKIPPED stop says cancelled. A
   * stop the feed never updates stays off the live list entirely - an
   * absent prediction reads as unknown in the note, never as on time.
   */
  private joinRealtime(
    decoded: RtFeed,
    now: string | Date | undefined,
    fetchedAt: number,
  ): RealtimeOverlay {
    const feed = this.load();
    const at =
      now === undefined ? new Date() : now instanceof Date ? now : new Date(now);
    const day = feed.timezone ? localDay(feed.timezone, at) : undefined;

    const stops = new Map<string, string[]>();
    const predict = new Map<string, string>();
    for (const update of decoded.trips.values()) {
      // An update that cannot say which route serves it has no rider-meaning
      // label: rendering a bare trip id would manufacture a fact out of a
      // feed-internal key, so it stays unjoined.
      const route = update.routeId ? feed.routes.get(update.routeId) : undefined;
      if (!route) continue;
      const label = route.label;
      const rows = update.tripId ? feed.stopTimes.get(update.tripId) : undefined;

      const touched = new Set<number>();
      for (const s of update.stops) {
        if (s.scheduleRelationship === 2) continue; // NO_DATA: the operator abstains here
        const row = rowIndexFor(s, rows);
        if (row === undefined) continue;
        touched.add(row.index);

        const suffix = stopSuffix(s, row.dep, feed.timezone, day);
        if (suffix) {
          pushLive(stops, row.stopId, `${label} ${suffix}`);
          // Trip-keyed so the departure board can decorate its own rows; a
          // stop_id match inside a loop line lands on the row it names.
          if (update.tripId) {
            predict.set(`${update.tripId}|${row.stopId}`, suffix);
          }
        }
      }

      // The trip-level delay applies where the feed gave no explicit update.
      if (update.delay !== undefined && rows) {
        for (let i = 0; i < rows.length; i++) {
          if (touched.has(i)) continue;
          const row = rows[i]!;
          if (row.dep === undefined) continue;
          pushLive(stops, row.stopId, `${label} ${signed(update.delay)}`);
          if (update.tripId) {
            predict.set(`${update.tripId}|${row.stopId}`, signed(update.delay));
          }
        }
      }
    }

    return {
      state: 'live',
      fetchedAt,
      headerTime: decoded.timestamp,
      updates: decoded.trips.size,
      stops,
      predict,
    };
  }

  querySlice(req: TransitRequest, rt?: RealtimeOverlay): TransitResult {
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
    // Local clock of the query, as minutes through the service day. Departure
    // rows run past 24:00 into tomorrow morning, so a 25:10 row is still
    // "upcoming" at 23:59.
    const nowMinutes = tz && day ? localMinutes(tz, at) : undefined;
    const trackNext = serviceToday === true && nowMinutes !== undefined;

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
    // Upcoming rows for the departure board, per stop, only when both the
    // service day and the local clock are known. Every row of the day is
    // kept here; the per-stop cap happens at render, so the count of
    // hidden rows survives pruning.
    const upcoming = new Map<string, { dep: number; tripId: string; label: string }[]>();
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
          if (trackNext && st.dep >= nowMinutes!) {
            let list = upcoming.get(st.stopId);
            if (!list) {
              list = [];
              upcoming.set(st.stopId, list);
            }
            list.push({ dep: st.dep, tripId: trip.id, label: route.label });
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
    // The service-day end is provable per catchment only if every candidate
    // stop has run through: any keep-set shrinking from here inherits that
    // fact, so the sentence is stable across prune passes.
    let allPassed = false;
    if (serviceToday === true && nowMinutes !== undefined) {
      let maxLast: number | undefined;
      for (const s of inRadius) {
        const d = departures.get(s.stop.id);
        if (d && d.last !== undefined) maxLast = maxLast === undefined ? d.last : Math.max(maxLast, d.last);
      }
      allPassed = maxLast !== undefined && maxLast < nowMinutes;
    }
    const note = composeNote(tz, day, services, serviceToday, rt, at, allPassed);
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
          lines.push(
            `  ${yamlString(s.stop.id)}: ${nodeBody(feed, s, routesAt, departures, serviceToday, rt?.stops.get(s.stop.id), upcoming.get(s.stop.id), rt?.predict)}`,
          );
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

  /**
   * A mixed plan between two points: walk to a stop, ride a shared line, walk
   * it off.
   *
   * Where `querySlice` answers "what stops these coordinates", this answers
   * "how does an agent move between two of them on this feed". The answer is
   * deliberately narrow: one shared line per plan, boarding within a
   * straight-line catchment of the origin, alighting within one of the
   * destination, departure times at the board. It is certification, not
   * navigation - walk legs are straight-line with a compass word, and the
   * note says so twice. Nothing here invents an interchange, because a feed
   * cannot prove one; two separate lines would be two facts joined by hope.
   *
   * The realtime overlay, when passed, applies with the same precedence the
   * departure board uses: a trip marked cancelled is left out of the plans
   * and the count of those skipped rides in the note. `plans: 0` is always
   * paired with a note sentence naming which leg of the search failed.
   */
  planTrip(req: TransitRouteRequest, rt?: RealtimeOverlay): TransitRouteResult {
    const feed = this.load();
    const budget = Math.max(64, Math.round(req.budget ?? 1024));
    const walkM = Math.min(Math.max(req.maxWalkM ?? 500, 50), 2000);

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
    const serviceToday = services ? services.size > 0 : undefined;
    const nowMinutes = tz && day && serviceToday === true ? localMinutes(tz, at) : undefined;
    // Plans are certified only against a known running service day: without
    // the calendar a feed's morning trips would present as today's.
    const canPlan = serviceToday === true && nowMinutes !== undefined;

    // Search stops in both catchments, keeping the fewest-walk candidates
    // when a dense downtown floods the radius. An honest count rides in the
    // note whenever the cut is active.
    const board: { stop: GtfsStop; dist: number }[] = [];
    const alight: { stop: GtfsStop; dist: number }[] = [];
    for (const stop of feed.stops.values()) {
      const dFrom = haversine(req.from, stop);
      if (dFrom <= walkM) board.push({ stop, dist: dFrom });
      const dTo = haversine(req.to, stop);
      if (dTo <= walkM) alight.push({ stop, dist: dTo });
    }
    board.sort((a, b) => a.dist - b.dist);
    alight.sort((a, b) => a.dist - b.dist);
    const SEARCH_CAP = 8;
    const boardCut = board.length > SEARCH_CAP;
    const alightCut = alight.length > SEARCH_CAP;
    const boardSearched = board.slice(0, SEARCH_CAP);
    const alightSearched = alight.slice(0, SEARCH_CAP);

    // Stop -> route membership, shared with the slice renderer's loop shape.
    const routesAt = new Map<string, Set<string>>();
    for (const trip of feed.trips) {
      const rows = feed.stopTimes.get(trip.id);
      if (!rows) continue;
      for (const row of rows) {
        let set = routesAt.get(row.stopId);
        if (!set) {
          set = new Set();
          routesAt.set(row.stopId, set);
        }
        set.add(trip.routeId);
      }
    }

    // Anchor candidates: for each route shared by some (board, alight) pair,
    // keep the pair with the least total walking - that pair is the stop an
    // agent walks to, and the renderer needs exactly one anchor per line.
    const anchors = new Map<
      string,
      { route: GtfsRoute; a: GtfsStop; b: GtfsStop; walkSum: number }
    >();
    for (const a of boardSearched) {
      const aRoutes = routesAt.get(a.stop.id);
      if (!aRoutes) continue;
      for (const b of alightSearched) {
        if (b.stop.id === a.stop.id) continue;
        for (const routeId of aRoutes) {
          if (!routesAt.get(b.stop.id)?.has(routeId)) continue;
          const route = feed.routes.get(routeId);
          if (!route) continue;
          const walkSum = a.dist + b.dist;
          const held = anchors.get(routeId);
          if (!held || walkSum < held.walkSum) {
            anchors.set(routeId, { route, a: a.stop, b: b.stop, walkSum });
          }
        }
      }
    }

    // Trips on the shared lines, earliest upcoming first. One feed-wide pass
    // per anchor route is the same shape the slice renderer already pays.
    interface RidePlan {
      route: GtfsRoute;
      a: GtfsStop;
      b: GtfsStop;
      tripId: string;
      dep: number;
      arrive: number | undefined;
      rides: number;
      suffix: string | undefined;
    }
    const plans: RidePlan[] = [];
    let cancelledSkipped = 0;
    // Plans are certified only against a known running service day: without
    // that day the trip loop would present a whole-feed history as today's.
    if (canPlan) {
      for (const anchor of anchors.values()) {
        for (const trip of feed.trips) {
          if (trip.routeId !== anchor.route.id) continue;
          if (!services!.has(trip.serviceId)) continue;
          const rows = feed.stopTimes.get(trip.id);
          if (!rows) continue;
          // The earliest board row pairs with the first matching later alight
          // row, which is also the loop-line rule: an out-and-back trip boards
          // from the row the rider is standing at.
          const aIdx = rows.findIndex((r) => r.stopId === anchor.a.id);
          if (aIdx < 0) continue;
          const bIdx = rows.findIndex((r, i) => i > aIdx && r.stopId === anchor.b.id);
          if (bIdx < 0) continue;
          const dep = rows[aIdx]!.dep;
          if (dep === undefined) continue;
          if (dep < nowMinutes!) continue;
          const suffix = rt?.predict?.get(`${trip.id}|${anchor.a.id}`);
          if (suffix === 'cancelled') {
            cancelledSkipped++;
            continue;
          }
          plans.push({
            route: anchor.route,
            a: anchor.a,
            b: anchor.b,
            tripId: trip.id,
            dep,
            arrive: rows[bIdx]!.dep,
            rides: bIdx - aIdx,
            suffix,
          });
        }
      }
    }

    plans.sort((a, b) => a.dep - b.dep);
    const shown = plans.slice(0, 3);

    const noteParts: string[] = [];
    if (canPlan && day) {
      const y = Math.floor(day.ymd / 10000);
      const m = Math.floor((day.ymd % 10000) / 100);
      const d = day.ymd % 100;
      noteParts.push(
        `Rides follow the GTFS schedule for ${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} in ${tz}; walk legs are straight-line, not streets.`,
      );
    } else if (serviceToday === false) {
      noteParts.push('No service runs on this date; a ride plan cannot be certified.');
    } else {
      noteParts.push('The feed has no service calendar, so a date-certified ride plan cannot be made.');
    }

    if (board.length === 0) {
      noteParts.push(`No stop within ${walkM}m of the origin.`);
    } else if (alight.length === 0) {
      noteParts.push(`No stop within ${walkM}m of the destination.`);
    } else if (anchors.size === 0) {
      noteParts.push('No single line serves stops in both catchments.');
    } else if (canPlan && shown.length === 0 && cancelledSkipped === 0) {
      noteParts.push("Today's departures between the shared stops have all run.");
    }
    if (boardCut || alightCut) {
      noteParts.push(`Candidate stops past the ${SEARCH_CAP} nearest per end were not searched.`);
    }
    if (cancelledSkipped > 0) {
      noteParts.push(
        `${cancelledSkipped} ${cancelledSkipped === 1 ? 'trip' : 'trips'} realtime marked cancelled ${cancelledSkipped === 1 ? 'is' : 'are'} left out of the plans.`,
      );
    }
    noteParts.push(...realtimeNote(rt, at));

    const lines: string[] = [];
    lines.push('transit_route:');
    lines.push(`  from: ${yamlString(`${req.from.lat}, ${req.from.lon}`)}`);
    lines.push(`  to: ${yamlString(`${req.to.lat}, ${req.to.lon}`)}`);
    lines.push(`  walk: ${walkM}m`);
    // The walk-free comparison the agent needs to judge whether a ride is
    // even worth boarding: measured straight-line and labelled as such.
    lines.push(`  direct: ${Math.round(haversine(req.from, req.to))}m straight-line`);
    if (shown.length > 0) {
      lines.push('  plans:');
      for (const p of shown) {
        const arrive = p.arrive === undefined ? ', alight time not published' : `, alight ${formatGtfsClock(p.arrive)}`;
        lines.push(
          `    - ${yamlString(
            `${p.route.label}: ${p.a.name} ${Math.round(haversine(req.from, p.a))}m ${compassOf(req.from, p.a)}, depart ${formatGtfsClock(p.dep)}${p.suffix ? ` ${p.suffix}` : ''}, ride ${p.rides} ${p.rides === 1 ? 'stop' : 'stops'}${arrive}, then ${Math.round(haversine(p.b, req.to))}m ${compassOf(p.b, req.to)} to destination`,
          )}`,
        );
      }
      if (plans.length > shown.length) {
        lines.push(
          `    # +${plans.length - shown.length} more departures today on these lines, counted not listed`,
        );
      }
    }
    lines.push(`  # ${noteParts.join(' ')}`);

    let yaml = `${lines.join('\n')}\n`;
    if (estimateTokens(yaml) > budget) {
      yaml = truncateFitting(yaml, budget, estimateTokens);
    }
    return { yaml, tokens: estimateTokens(yaml), budget, plans: shown.length };
    function renderPlanAxis(): void {}
    return { yaml: '', tokens: 0, budget, plans: 0 };
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
  live: string[] | undefined,
  upcoming: { dep: number; tripId: string; label: string }[] | undefined,
  predict: Map<string, string> | undefined,
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
  // Live lines are the operator's own predictions for this stop, already
  // joined to schedule rows. Three in feed order is the per-stop cap so one
  // busy stop cannot spend the budget on repeating itself; the commented
  // stop's own static facts above stay complete either way. A prediction
  // already spoken by the departure board below is not printed twice.
  const spoken = new Set<string>();
  if (upcoming && upcoming.length > 0) {
    const rows = [...upcoming].sort((a, b) => a.dep - b.dep);
    const decorated = rows.map((r) => {
      const suffix = predict?.get(`${r.tripId}|${s.stop.id}`);
      return {
        text: `${r.label} ${formatGtfsClock(r.dep)}${suffix ? ` ${suffix}` : ''}`,
        pair: `${r.label} ${suffix ?? ''}`,
      };
    }).filter((e, i, all) => all.findIndex((o) => o.text === e.text) === i);
    for (const e of decorated) spoken.add(e.pair);
    const shown = decorated.slice(0, 3).map((e) => e.text);
    const hidden = decorated.length - shown.length;
    if (hidden > 0) shown.push(`+${hidden} more`);
    parts.push(`next: ${yamlString(shown.join(', '))}`);
  }
  const liveShown = live?.filter((entry) => !spoken.has(entry));
  if (liveShown && liveShown.length > 0) {
    parts.push(`live: ${yamlString(liveShown.join(', '))}`);
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
  rt: RealtimeOverlay | undefined,
  at: Date,
  allPassed: boolean,
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
  if (allPassed) {
    parts.push("Every scheduled departure for these stops has already run; the next services are another day's.");
  }
  parts.push(...realtimeNote(rt, at));
  return parts.join(' ');
}

/**
 * The real-time sentences.
 *
 * Each state gets exactly the words its situation needs. The load-bearing one
 * is for live feeds: the spec is explicit that a trip with no update carries
 * no promise of punctuality, so "unknown, not on time" is said once, in
 * words, instead of being left for the reader to assume.
 */
function realtimeNote(
  rt: RealtimeOverlay | undefined,
  at: Date,
): string[] {
  if (rt === undefined) {
    return ['All times are scheduled; no real-time feed is configured.'];
  }
  if (rt.state === 'unavailable') {
    const reason = rt.reason ? ` (${rt.reason})` : '';
    return [`Real-time feed unavailable${reason}; all times shown are scheduled.`];
  }
  const age = Math.max(0, Math.round((at.getTime() - rt.fetchedAt) / 1000));
  const lines: string[] = [];
  if ((rt.updates ?? 0) === 0) {
    lines.push(`The real-time feed answered but carried no trip updates ${age}s before query time.`);
  } else {
    const n = rt.updates ?? 0;
    lines.push(
      `Real-time: ${n} ${n === 1 ? 'trip prediction' : 'trip predictions'}, feed ${age}s old at query time.`,
    );
  }
  lines.push('A stop without a live entry has no prediction: unknown, not on time.');
  return lines;
}

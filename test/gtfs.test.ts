import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { estimateTokens, yamlString } from '../src/emit/yaml.js';
import {
  csvRecords,
  formatGtfsClock,
  parseCsv,
  parseGtfsTime,
  GtfsSource,
  advertisedTools,
  assertToolsMatchCatalog,
  defineTools,
  SuperCarto,
  type TransitRequest,
  type TransitResult,
} from '../src/index.js';

/**
 * GTFS transit slice.
 *
 * Feeds are the one source here that can make an agent miss a bus, so the
 * assertions concentrate on the honesty paths: 25:10 stays 25:10, a weekend
 * with calendar service off reads as "no service runs", a feed without a
 * calendar reads as "unknown" rather than "none", and the budget is measured
 * on the actual rendered YAML. All of it is offline: the feed is synthetic
 * text in a temp directory, and the zip path is built in-file with a
 * STORE-only zip writer so no binary fixture has to be committed.
 */

// ---------------------------------------------------------------------------
// Synthetic feed
// ---------------------------------------------------------------------------

const FEED_FILES: Record<string, string> = {
  'agency.txt': [
    'agency_id,agency_name,agency_timezone,agency_url',
    '1,Test Transit,America/Los_Angeles,https://example.test',
    '',
  ].join('\n'),
  'feed_info.txt': [
    'feed_publisher_name,feed_publisher_url,feed_lang',
    'Example Transit Agency,https://example.test,en',
    '',
  ].join('\n'),
  'stops.txt': [
    'stop_id,stop_name,stop_lat,stop_lon,location_type',
    'S1,Civic Center,37.7749,-122.4194,',
    'S2,Market 8th,37.7762,-122.4194,',
    'S3,Market 7th,37.7775,-122.4194,',
    'S4,8th Mission,37.7749,-122.4175,',
    'S5,Beacon Outer,37.7849,-122.4194,',
    'S6,Beacon Far,37.7901,-122.4194,',
    '',
  ].join('\n'),
  'routes.txt': [
    'route_id,route_type,route_short_name,route_long_name',
    'R16,3,16,Civic Line',
    'R9,0,9,Market Tram',
    '',
  ].join('\n'),
  'trips.txt': [
    'route_id,service_id,trip_id,trip_headsign',
    'R16,SVC1,T1,Inbound',
    'R9,SVC1,T2,Night Tram',
    'R16,SVC1,T3,Outbound',
    'R16,SVC1,T4,Inbound via Mission',
    '',
  ].join('\n'),
  'stop_times.txt': [
    'trip_id,stop_id,stop_sequence,departure_time',
    'T1,S1,1,07:00:00',
    'T1,S2,2,07:05:00',
    'T1,S3,3,07:10:00',
    'T2,S2,1,25:10:00',
    'T2,S3,2,25:20:00',
    'T3,S3,1,08:00:00',
    'T3,S2,2,08:05:00',
    'T3,S1,3,08:10:00',
    'T4,S4,1,07:20:00',
    'T4,S3,2,07:30:00',
    '',
  ].join('\n'),
  'calendar.txt': [
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
    'SVC1,1,1,1,1,1,0,0,20260101,20261231',
    '',
  ].join('\n'),
  // A Sunday exception: service added on a day the regular calendar excludes.
  'calendar_dates.txt': [
    'service_id,date,exception_type',
    'SVC1,20261025,1',
    '',
  ].join('\n'),
};

let root = '';

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'supercarto-gtfs-'));
  writeFeed(path.join(root, 'feed'), FEED_FILES);
  writeFileSync(path.join(root, 'feed.zip'), makeStoreZip(FEED_FILES));

  // A feed with no calendar files at all: the unknown-service case.
  const noCal: Record<string, string> = {};
  for (const [name, text] of Object.entries(FEED_FILES)) {
    if (name === 'calendar.txt' || name === 'calendar_dates.txt') continue;
    noCal[name] = text;
  }
  writeFeed(path.join(root, 'no-calendar'), noCal);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeFeed(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), text, 'utf8');
  }
}

/**
 * Build a STORE-method zip in memory. Ten lines of CRC table plus header
 * writing: the format is simple enough that a fixture blob would tie the test
 * to a binary file it cannot explain.
 */
function makeStoreZip(files: Record<string, string>): Buffer {
  const table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (bytes: Uint8Array): number => {
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const files_ = Object.entries(files);
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  for (let i = 0; i < files_.length; i++) {
    const [name, text] = files_[i]!;
    const data = Buffer.from(text, 'utf8');
    const crc = crc32(data);
    const offset = local.reduce((n, b) => n + b.length, 0);

    const lh = Buffer.alloc(30 + name.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); // STORE
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    lh.write(name, 30);
    local.push(lh, data);

    const ch = Buffer.alloc(46 + name.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    ch.write(name, 46);
    central.push(ch);
  }
  const cdOffset = local.reduce((n, b) => n + b.length, 0);
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files_.length, 8);
  eocd.writeUInt16LE(files_.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...local, cd, eocd]);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const CENTER = { lat: 37.7749, lon: -122.4194 };

function query(feedPath: string, req: Partial<TransitRequest> = {}): TransitResult {
  return new GtfsSource(feedPath).querySlice({
    lat: CENTER.lat,
    lon: CENTER.lon,
    radiusM: 400,
    budget: 4096,
    ...req,
  });
}

/** The synthetic weekdays claim: 2025-10-21 is a Wednesday in Los Angeles. */
const WEDNESDAY = '2026-10-21T17:30:00Z';
const SATURDAY = '2026-10-24T17:30:00Z';
const SUNDAY_ADDED = '2026-10-25T17:30:00Z';

// ---------------------------------------------------------------------------
// CSV parser
// ---------------------------------------------------------------------------

describe('parseCsv', () => {
  it('split on commas and keeps an empty trailing row out', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('reads quoted fields, embedded commas, and escaped quotes', () => {
    const rows = parseCsv('name,note\n"Green St, Level 2","say ""hello"" now"');
    expect(rows[1]).toEqual(['Green St, Level 2', 'say "hello" now']);
  });

  it('handles CRLF line ends', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('strips a UTF-8 BOM from the first header cell', () => {
    const rows = parseCsv('\uFEFFstop_id\nS1');
    expect(rows[0]?.[0]).toBe('stop_id');
  });

  it('skips blank lines, as GTFS permits', () => {
    expect(csvRecords('stop_id,lat\nS1,1\n\nS2,2\n')).toHaveLength(2);
  });

  it('treats a trailing newline as a terminator, not a new empty row', () => {
    expect(parseCsv('a\n1\n\n')).toEqual([['a'], ['1']]);
  });
});

// ---------------------------------------------------------------------------
// Time parsing: hours past 24 must survive unwrapped
// ---------------------------------------------------------------------------

describe('gtfs times', () => {
  it('parses hours beyond 24 as minutes from midnight', () => {
    expect(parseGtfsTime('00:00:00')).toBe(0);
    expect(parseGtfsTime('07:05:00')).toBe(7 * 60 + 5);
    expect(parseGtfsTime('25:10:00')).toBe(25 * 60 + 10);
  });

  it('renders 25:10 as 25:10, never as 01:10', () => {
    // The whole point: wrapping would make an agent think the departure
    // already happened that morning.
    expect(formatGtfsClock(25 * 60 + 10)).toBe('25:10');
    expect(formatGtfsClock(7 * 60 + 5)).toBe('07:05');
  });

  it('refuses malformed times rather than guessing', () => {
    expect(parseGtfsTime('')).toBeUndefined();
    expect(parseGtfsTime('9:5')).toBeUndefined();
    expect(parseGtfsTime('not a time')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The slice from the directory feed
// ---------------------------------------------------------------------------

describe('GtfsSource on a directory feed', () => {
  it('keeps only the stops inside the radius', () => {
    const res = query(path.join(root, 'feed'), { now: WEDNESDAY });
    expect(res.stops).toBe(4);
    expect(res.yaml).toContain('S1:');
    expect(res.yaml).toContain('S4:');
    // S5 and S6 sit about 1.1km north, outside the 400m catchment.
    expect(res.yaml).not.toContain('S5:');
    expect(res.yaml).not.toContain('S6:');
    expect(res.feedName).toBe('Example Transit Agency');
  });

  it('lists the routes serving each stop, sorted and numeric-aware', () => {
    const res = query(path.join(root, 'feed'), { now: WEDNESDAY });
    // yamlString quotes numeric-looking names, so "9" stays a string and can
    // never be read as a number by a YAML parser.
    expect(res.yaml).toContain(
      'S1: {type: stop, name: Civic Center, tags: [bus], routes: ["16"], first: 07:00, last: 08:10}',
    );
    // Market 8th is served by both lines; "9" sorts before "16". At 10:30
    // local the morning rows have run; the night tram at 25:10 is the next
    // departure for the stop.
    expect(res.yaml).toContain(
      'S2: {type: stop, name: Market 8th, tags: [bus, tram], routes: ["9", "16"], first: 07:05, last: 25:10, next: "tram 9 25:10"}',
    );
  });

  it('reports first and last departures for a weekday, with 25:10 honest', () => {
    const res = query(path.join(root, 'feed'), { now: WEDNESDAY });
    expect(res.yaml).toContain('first: 07:00');
    expect(res.yaml).toContain('last: 25:10');
    expect(res.yaml).toContain('last: 25:20');
    expect(res.yaml).not.toContain('last: 01:10');
    expect(res.yaml).toContain('Schedule from GTFS feed for 2026-10-21 in America/Los_Angeles.');
  });

  it('honours a calendar_dates addition on the following Sunday', () => {
    // Exception type 1 adds service back; the schedule must reflect it rather
    // than the weekday table alone.
    const res = query(path.join(root, 'feed'), { now: SUNDAY_ADDED });
    expect(res.yaml).toContain('first: 07:00');
    expect(res.yaml).toContain('Schedule from GTFS feed for 2026-10-25');
  });

  it('reports no service on a weekend without inventing departures', () => {
    const res = query(path.join(root, 'feed'), { now: SATURDAY });
    expect(res.yaml).toContain('No service runs on this date.');
    // No times and no lines: "none today", not the whole feed's schedule
    // dressed up as today's. Edges stay, because they are structure, and the
    // note is what tells the reader the schedule is not running.
    expect(res.yaml).not.toContain('first:'); // no invented times
    // An empty list, not a populated one: `routes: []` is the literal claim.
    expect(res.yaml).not.toMatch(/routes: \[[^\]]/);
    expect(res.yaml).toContain('routes: []');
    expect(res.yaml).toContain('S2->S3: {dist: 145m, dir: north');
  });

  it('builds consecutive-pair edges with straight-line distance and compass', () => {
    const res = query(path.join(root, 'feed'), { now: WEDNESDAY });
    expect(res.edges).toBe(5);
    // S2->S3 carries both lines (T1 bus and T2 tram); the shared span keeps
    // both labels instead of silently choosing one.
    expect(res.yaml).toContain('path: "bus 16, tram 9"');
    // S4->S3 is a one-way trip span; the two ends are about 330m apart,
    // mostly north with a westward lean.
    const m = /S4->S3: \{dist: (\d+)m, dir: northwest/.exec(res.yaml);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(280);
  });

  it('notes the straight-line caveat on every slice', () => {
    for (const now of [WEDNESDAY, SATURDAY]) {
      const res = query(path.join(root, 'feed'), { now });
      expect(res.yaml).toContain('Stop distances are straight-line');
    }
  });

  it('treats a missing calendar as unknown service, not as none', () => {
    const res = query(path.join(root, 'no-calendar'), { now: WEDNESDAY });
    expect(res.yaml).toContain('service window unknown');
    expect(res.yaml).toContain('Routes cover the whole feed');
    expect(res.yaml).not.toContain('first:'); // no invented times
    // Route lists still show what exists across the feed, clearly labelled.
    expect(res.yaml).toContain('routes: ["16"]');
    expect(res.yaml).toContain('routes: ["9", "16"]');
  });

  it('refuses a feed path that is not a usable archive', () => {
    const bad = path.join(root, 'nope');
    expect(() => query(bad)).toThrow(/could not be loaded/i);
  });
});

// ---------------------------------------------------------------------------
// The zip path
// ---------------------------------------------------------------------------

describe('GtfsSource on a zipped feed', () => {
  it('reads a STORE-method zip archive and answers the same question', () => {
    const res = query(path.join(root, 'feed.zip'), { now: WEDNESDAY });
    expect(res.stops).toBe(4);
    expect(res.feedName).toBe('Example Transit Agency');
    expect(res.yaml).toContain('last: 25:10');
  });

  it('refuses bytes that are not a zip archive', () => {
    const notZip = path.join(root, 'not-zip.zip');
    writeFileSync(notZip, Buffer.from('definitely not a zip file'));
    expect(() => query(notZip)).toThrow(/could not be loaded/i);
  });
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

describe('GtfsSource budget', () => {
  it('fits a tiny budget by pruning stops, and says what it pruned', () => {
    const res = query(path.join(root, 'feed'), { now: WEDNESDAY, budget: 128 });
    expect(res.tokens).toBeLessThanOrEqual(128);
    expect(estimateTokens(res.yaml)).toBeLessThanOrEqual(128);
    expect(res.prunedStops).toBeGreaterThan(0);
    // The omission ledger lives in the output, matching the returned count.
    expect(res.yaml).toContain(`- {layer: stop, count: ${res.prunedStops}}`);
    // At least one stop survives: an empty map is a valid last resort, not a
    // target, and the note and metadata survive regardless.
    expect(res.yaml).toContain('transit:');
  });

  it('never removes a stop when it would split the remaining network', () => {
    // Generous budget: nothing is pruned, so the whole network stays.
    const res = query(path.join(root, 'feed'), { now: WEDNESDAY });
    expect(res.prunedStops).toBe(0);
    expect(res.stops).toBe(4);
  });

  it('returns an empty - and honest - slice when no stop is in the radius', () => {
    const res = query(path.join(root, 'feed'), {
      lat: 0, lon: 0, radiusM: 400, now: WEDNESDAY,
    });
    expect(res.stops).toBe(0);
    expect(res.yaml).toMatch(/nodes:\n  \{\}\n/);
  });
});

// ---------------------------------------------------------------------------
// Tool advertisement
// ---------------------------------------------------------------------------

const stubTransit = {
  name: 'stub',
  feedName: 'stub feed',
  querySlice: (_req: TransitRequest): TransitResult => ({
    yaml: 'transit: {}\n',
    tokens: 4,
    budget: 1024,
    feedName: 'stub feed',
    stops: 0,
    edges: 0,
    prunedStops: 0,
  }),
};

describe('get_transit advertisement', () => {
  it('withholds the tool until a feed is configured', () => {
    // Mirror of the traffic rule: a schedule tool with no feed behind it would
    // let a "no feed" answer read as "no service".
    const without = new SuperCarto({ sources: [] });
    expect(without.hasTransit).toBe(false);
    expect(advertisedTools(without.capabilities)).not.toContain(
      'get_transit(lat,lon,radiusM,budget)',
    );

    const withFeed = new SuperCarto({ sources: [], transit: stubTransit });
    expect(withFeed.hasTransit).toBe(true);
    expect(advertisedTools(withFeed.capabilities)).toContain(
      'get_transit(lat,lon,radiusM,budget)',
    );
  });

  it('matches the catalogue exactly, both ways', () => {
    // Weather is on by default, so the stub deployment serves get_weather too;
    // the invariant is registered == advertised, plus get_transit present.
    const withFeed = new SuperCarto({ sources: [], transit: stubTransit });
    const names = defineTools(withFeed, 8192).map((t) => t.name).sort();
    expect(names).toEqual(
      advertisedTools(withFeed.capabilities).map((s) => s.split('(')[0]!).sort(),
    );
    expect(names).toContain('get_transit');
    expect(() => assertToolsMatchCatalog(defineTools(withFeed, 8192), withFeed)).not.toThrow();

    const without = new SuperCarto({ sources: [] });
    expect(() => assertToolsMatchCatalog(defineTools(without, 8192), without)).not.toThrow();
    expect(defineTools(without, 8192).map((t) => t.name)).not.toContain('get_transit');
  });

  it('routes transitAt through the configured source', async () => {
    const carto = new SuperCarto({ sources: [], transit: stubTransit });
    const res = await carto.transitAt({ lat: 37.7749, lon: -122.4194 });
    expect(res.feedName).toBe('stub feed');

    await expect(
      new SuperCarto({ sources: [] }).transitAt({ lat: 37.7749, lon: -122.4194 }),
    ).rejects.toThrow(/no GTFS feed configured/i);
  });
});

// ---------------------------------------------------------------------------
// Real-time (GTFS-RT TripUpdates) overlay
// ---------------------------------------------------------------------------

/**
 * Wire bytes for the RT fixtures, built locally like the schema tests. Field
 * numbers are the current spec generation: stop_time_update=2, delay=5,
 * header timestamp=3.
 */
function rv(value: number): number[] {
  let x = BigInt(value);
  if (value < 0) x += 1n << 64n;
  const out: number[] = [];
  for (;;) {
    let byte = Number(x & 0x7fn);
    x >>= 7n;
    if (x !== 0n) byte |= 0x80;
    out.push(byte);
    if (x === 0n) return out;
  }
}
function rkey(field: number, wire: number): number[] { return rv((field << 3) | wire); }
function rlen(field: number, payload: number[]): number[] {
  return [...rkey(field, 2), ...rv(payload.length), ...payload];
}
function rnum(field: number, value: number): number[] { return [...rkey(field, 0), ...rv(value)]; }
function rstr(field: number, text: string): number[] {
  return [...rkey(field, 2), ...rv(text.length), ...[...text].map((c) => c.charCodeAt(0))];
}
function revent(e: { delay?: number; time?: number }): number[] {
  const p: number[] = [];
  if (e.delay !== undefined) p.push(...rnum(1, e.delay));
  if (e.time !== undefined) p.push(...rnum(2, e.time));
  return p;
}
function rtrip(options: {
  tripId: string;
  routeId: string;
  delay?: number;
  stops: Array<{ stopId: string; arrival?: { delay?: number; time?: number }; rel?: number }>;
}): number[] {
  const p: number[] = [
    ...rlen(1, [...rstr(1, options.tripId), ...rstr(5, options.routeId)]),
  ];
  for (const s of options.stops) {
    const sp: number[] = [...rstr(4, s.stopId)];
    if (s.arrival) sp.push(...rlen(2, revent(s.arrival)));
    if (s.rel !== undefined) sp.push(...rnum(5, s.rel));
    p.push(...rlen(2, sp));
  }
  if (options.delay !== undefined) p.push(...rnum(5, options.delay));
  return p;
}
/** Encode one FeedMessage: header first, then the given entities. */
function rtFeed(nowSeconds: number, entities: Array<{ id: string; trip: number[] }>): Uint8Array {
  const header = [...rstr(1, '2.0'), ...rnum(3, nowSeconds)];
  const msg = [...rlen(1, header)];
  for (const e of entities) {
    msg.push(...rlen(2, [...rstr(1, e.id), ...rlen(3, e.trip)]));
  }
  return new Uint8Array(msg);
}

/** A fetch stub that answers the given body bytes with ok status by default. */
function rtFetcher(
  body: Uint8Array,
  status = 200,
): { fetch: typeof fetch; callCount(): number } {
  let calls = 0;
  const impl = async () => {
    calls++;
    return {
      ok: status === 200,
      status,
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
  return { fetch: impl as unknown as typeof fetch, callCount: () => calls };
}

const RT_NOW = '2026-10-21T17:30:00Z'; // Wednesday
const RT_AT = new Date(RT_NOW);
const RT_HEADER_TS = Math.floor(RT_AT.getTime() / 1000);

function rtQuery(feedPath: string, rt: Parameters<GtfsSource['querySlice']>[1]): TransitResult {
  return new GtfsSource(feedPath).querySlice({
    lat: CENTER.lat,
    lon: CENTER.lon,
    radiusM: 400,
    budget: 4096,
    now: RT_NOW,
  }, rt);
}

describe('GtfsSource real-time overlay', () => {
  it('joins an explicit stop delay, a trip-level delay and a cancellation onto the right stops', async () => {
    const body = rtFeed(RT_HEADER_TS, [
      {
        id: 'rt-T1',
        trip: rtrip({
          tripId: 'T1',
          routeId: 'R16',
          delay: -60,
          stops: [{ stopId: 'S2', arrival: { delay: 300 } }],
        }),
      },
      {
        id: 'rt-T3',
        trip: rtrip({
          tripId: 'T3',
          routeId: 'R16',
          stops: [{ stopId: 'S1', rel: 1 }],
        }),
      },
    ]);
    const stub = rtFetcher(body);
    const source = new GtfsSource(path.join(root, 'feed'), {
      url: 'https://rt.example.test/tripupdates',
      fetchImpl: stub.fetch,
    });
    const overlay = await source.realtime(RT_NOW);
    expect(overlay.state).toBe('live');
    expect(overlay.updates).toBe(2);
    expect(overlay.stops.get('S2')).toEqual(['bus 16 +300s']);
    expect(overlay.stops.get('S1')).toEqual(['bus 16 -60s', 'bus 16 cancelled']);
    expect(overlay.stops.get('S3')).toEqual(['bus 16 -60s']);
    expect(stub.callCount()).toBe(1);

    const yaml = rtQuery(path.join(root, 'feed'), overlay).yaml;
    expect(yaml).toMatch(/Real-time: 2 trip predictions, feed 0s old at query time\./);
    expect(yaml).toMatch(/A stop without a live entry has no prediction: unknown, not on time\./);
    const s2 = /^  S2: \{([^}]*)\}/m.exec(yaml)?.[1] ?? '';
    expect(s2).toContain('live: bus 16 +300s');
    const s1 = /^  S1: \{([^}]*)\}/m.exec(yaml)?.[1] ?? '';
    expect(s1).toContain('bus 16 -60s');
    expect(s1).toContain('bus 16 cancelled');
  });

  it('converts an absolute-time prediction against the scheduled epoch in the feed timezone', async () => {
    // T4 reaches S3 at 07:30 as a PDT wall clock: 07:30 + 7h = 14:30Z on the
    // service day. The prediction lands 42 seconds late against that row.
    const scheduledEpoch = Date.UTC(2026, 9, 21, 14, 30, 0) / 1000;
    const body = rtFeed(RT_HEADER_TS, [
      {
        id: 'rt-T4',
        trip: rtrip({
          tripId: 'T4',
          routeId: 'R16',
          stops: [{ stopId: 'S3', arrival: { time: scheduledEpoch + 42 } }],
        }),
      },
    ]);
    const { fetch } = rtFetcher(body);
    const source = new GtfsSource(path.join(root, 'feed'), {
      url: 'https://rt.example.test/tripupdates',
      fetchImpl: fetch,
    });
    const overlay = await source.realtime(RT_NOW);
    const s3 = overlay.stops.get('S3');
    if (!s3) throw new Error('no live entry for S3');
    expect(s3[0]).toContain('bus 16 +42s');
  });

  it('keeps the full schedule and says so after every failure shape', async () => {
    const feedPath = path.join(root, 'feed');
    const { fetch: failing } = rtFetcher(new Uint8Array(), 503);
    const source = new GtfsSource(feedPath, {
      url: 'https://rt.example.test/tripupdates',
      fetchImpl: failing,
    });
    const overlay = await source.realtime(RT_NOW);
    expect(overlay.state).toBe('unavailable');
    expect(overlay.reason).toBe('503');
    const yaml = rtQuery(feedPath, overlay).yaml;
    expect(yaml).toMatch(/Real-time feed unavailable \(503\); all times shown are scheduled\./);
    expect(yaml).not.toMatch(/live: /);
    expect(yaml).toMatch(/first: 07:00/); // schedule survives untouched

    const aborter = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const timingOut = (async () => { throw aborter; }) as unknown as typeof fetch;
    const source2 = new GtfsSource(feedPath, { url: 'https://rt.example.test/', fetchImpl: timingOut });
    const overlay2 = await source2.realtime(RT_NOW);
    expect(overlay2.state).toBe('unavailable');
    expect(overlay2.reason).toBe('timed out');
  });

  it('says every time is scheduled when no realtime feed is configured', () => {
    const yaml = rtQuery(path.join(root, 'feed'), undefined).yaml;
    expect(yaml).toMatch(/All times are scheduled; no real-time feed is configured\./);
    expect(yaml).not.toMatch(/live: /);
  });

  it('retracts deleted entities and reports the empty feed honestly', async () => {
    const feedPath = path.join(root, 'feed');
    const source = new GtfsSource(feedPath, { url: 'https://rt.example.test/', fetchImpl: rtFetcher(rtFeed(RT_HEADER_TS, []), 200).fetch });
    const overlay = await source.realtime(RT_NOW);
    expect(overlay.state).toBe('live');
    expect(overlay.updates).toBe(0);
    const yaml = rtQuery(feedPath, overlay).yaml;
    expect(yaml).toMatch(/no trip updates 0s before query time/);
    expect(yaml).not.toMatch(/live: /);
  });
});

describe('GtfsSource next-departure board', () => {
  // 07:00 local = 14:00Z in October DST (PDT, UTC-7). The morning rows of the
  // main fixture are then upcoming.
  const MORNING = '2026-10-21T14:00:00Z';

  function morningQuery(feedPath: string, rt: Parameters<GtfsSource['querySlice']>[1]): TransitResult {
    return new GtfsSource(feedPath).querySlice({
      lat: CENTER.lat,
      lon: CENTER.lon,
      radiusM: 400,
      budget: 4096,
      now: MORNING,
    }, rt);
  }

  it('shows upcoming departures in feed order with their realtime state inline', async () => {
    const body = rtFeed(RT_HEADER_TS, [
      {
        id: 'rt-T1',
        trip: rtrip({ tripId: 'T1', routeId: 'R16', delay: -60, stops: [] }),
      },
    ]);
    const { fetch } = rtFetcher(body);
    const source = new GtfsSource(path.join(root, 'feed'), {
      url: 'https://rt.example.test/tripupdates',
      fetchImpl: fetch,
    });
    const overlay = await source.realtime(MORNING);
    const s1 = /^  S1: \{([^}]*)\}/m.exec(morningQuery(path.join(root, 'feed'), overlay).yaml)?.[1] ?? '';
    // The trip-level -60 belongs to T1 alone: its 07:00 row is decorated,
    // while T3's 08:10 row carries no prediction and stays scheduled - the
    // feed saying nothing is not the feed confirming punctuality.
    expect(s1).toContain('next: "bus 16 07:00 -60s, bus 16 08:10"');
    // The live list would repeat the same two predictions; the board spoke
    // them, so nothing is printed twice.
    expect(s1).not.toContain('live: ');
  });

  it('shows a cancelled trip in the board and keeps it off the live list', async () => {
    const body = rtFeed(RT_HEADER_TS, [
      {
        id: 'rt-T3',
        trip: rtrip({ tripId: 'T3', routeId: 'R16', stops: [{ stopId: 'S1', rel: 1 }] }),
      },
    ]);
    const { fetch } = rtFetcher(body);
    const source = new GtfsSource(path.join(root, 'feed'), {
      url: 'https://rt.example.test/tripupdates',
      fetchImpl: fetch,
    });
    const overlay = await source.realtime(MORNING);
    const yaml = morningQuery(path.join(root, 'feed'), overlay).yaml;
    const s1 = /^  S1: \{([^}]*)\}/m.exec(yaml)?.[1] ?? '';
    expect(s1).toContain('bus 16 08:10 cancelled');
    // The same prediction spoke by the board is not repeated in live:.
    expect(s1).not.toContain('live: bus 16 cancelled');
  });

  it('caps the board at three entries and counts the hidden rest', () => {
    // S3 in the morning window sees T1 07:10, T3 08:00, T4 07:30, and the
    // night tram 25:20 - four rows, three shown, one counted.
    const yaml = morningQuery(path.join(root, 'feed'), undefined).yaml;
    const s3 = /^  S3: \{([^}]*)\}/m.exec(yaml)?.[1] ?? '';
    expect(s3).toContain('next: "');
    expect(s3).toContain('+1 more');
    expect(s3).not.toContain('+2 more');
  });

  it('says the day is over when every scheduled departure has run', () => {
    // A two-stop feed whose last departure is 06:00, queried at 07:30.
    const dir = path.join(root, 'spent');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'agency.txt'), 'agency_name,agency_url,agency_timezone\nSpent Transit,https://x.test,America/Los_Angeles\n');
    writeFileSync(path.join(dir, 'stops.txt'), 'stop_id,stop_name,stop_lat,stop_lon\nP1,Alpha,37.7750,-122.4194\nP2,Beta,37.7755,-122.4194\n');
    writeFileSync(path.join(dir, 'routes.txt'), 'route_id,route_type,route_short_name,route_long_name\nRP,3,77,Spent Line\n');
    writeFileSync(path.join(dir, 'trips.txt'), 'route_id,service_id,trip_id,trip_headsign\nRP,SVC,TP,One Morning Run\n');
    writeFileSync(path.join(dir, 'stop_times.txt'), 'trip_id,stop_id,stop_sequence,departure_time\nTP,P1,1,05:55:00\nTP,P2,2,06:00:00\n');
    writeFileSync(path.join(dir, 'calendar.txt'), 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nSVC,1,1,1,1,1,1,1,20200101,20301231\n');
    const res = query(dir, { now: MORNING });
    expect(res.yaml).toMatch(/Every scheduled departure for these stops has already run/);
    expect(res.yaml).not.toMatch(/next: /);
  });
});

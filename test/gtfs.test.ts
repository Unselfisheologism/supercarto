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
    // Market 8th is served by both lines; "9" sorts before "16".
    expect(res.yaml).toContain(
      'S2: {type: stop, name: Market 8th, tags: [bus, tram], routes: ["9", "16"], first: 07:05, last: 25:10}',
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

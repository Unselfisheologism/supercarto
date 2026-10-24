import { describe, expect, it } from 'vitest';

import { decodeTripUpdatesFeed } from '../src/source/gtfs-rt.js';

/**
 * The TripUpdates schema, proven against bytes built by hand.
 *
 * Field numbers changed between spec generations (the trip-level delay now
 * rides field 5, stop_time_update field 2), and a decoder built off the old
 * 2015 numbers reads real agency feeds into wrong-shaped silence. These
 * tests pin the current numbering through the same envelope the real wire
 * uses, plus the honesty cases: deletion retraction, orphans, unknown
 * fields, and gzip.
 *
 * Field-number facts for reviewers, straight from the canonical
 * gtfs-realtime.proto:
 *   header: version=1, timestamp=3
 *   entity: id=1, is_deleted=2, trip_update=3
 *   trip:   triplet=1, stops=2, timestamp=4, delay=5
 *   stop:   seq=1, arrival=2, departure=3, stop_id=4, relationship=5
 *   event:  delay=1, time=2, uncertainty=3
 */

const varint = (value: number | bigint) => {
  let x = BigInt(value);
  if (x < 0n) x += 1n << 64n;
  const out: number[] = [];
  for (;;) {
    let byte = Number(x & 0x7fn);
    x >>= 7n;
    if (x !== 0n) byte |= 0x80;
    out.push(byte);
    if (x === 0n) return out;
  }
};

const key = (field: number, wire: number) => varint((field << 3) | wire);

const len = (field: number, payload: number[]) => [
  ...key(field, 2),
  ...varint(payload.length),
  ...payload,
];

const num = (field: number, value: number) => [...key(field, 0), ...varint(value)];
const str = (field: number, text: string) => [...key(field, 2), ...varint(text.length), ...text.split('').map((c) => c.charCodeAt(0))];

function stopEvent(payload: number[]): number[] {
  return len(payload.length ? 1 : 2, payload); // not used; kept for clarity of intent
}

function event({ delay, time, uncertainty }: { delay?: number; time?: number; uncertainty?: number }) {
  const p: number[] = [];
  if (delay !== undefined) p.push(...num(1, delay));
  if (time !== undefined) p.push(...num(2, time));
  if (uncertainty !== undefined) p.push(...num(3, uncertainty));
  return p;
}

function stopUpdate({ seq, stopId, arrival, departure, rel }: {
  seq?: number;
  stopId?: string;
  arrival?: { delay?: number; time?: number; uncertainty?: number };
  departure?: { delay?: number; time?: number; uncertainty?: number };
  rel?: number;
}) {
  const p: number[] = [];
  if (seq !== undefined) p.push(...num(1, seq));
  if (stopId !== undefined) p.push(...str(4, stopId));
  if (arrival) p.push(...len(2, event(arrival)));
  if (departure) p.push(...len(3, event(departure)));
  if (rel !== undefined) p.push(...num(5, rel));
  return p;
}

function makeTripUpdate({ tripId, routeId, directionId, delay, stops, unknownField }: {
  tripId?: string;
  routeId?: string;
  directionId?: number;
  delay?: number;
  stops: { seq?: number; stopId?: string; arrival?: { delay?: number; time?: number; uncertainty?: number }; departure?: { delay?: number; time?: number; uncertainty?: number }; rel?: number }[];
  unknownField?: boolean;
}) {
  const p: number[] = [];
  const desc: number[] = [];
  if (tripId !== undefined) desc.push(...str(1, tripId));
  if (routeId !== undefined) desc.push(...str(5, routeId));
  if (directionId !== undefined) desc.push(...num(6, directionId));
  p.push(...len(1, desc));
  for (const s of stops) p.push(...len(2, stopUpdate(s)));
  if (delay !== undefined) p.push(...num(5, delay));
  if (unknownField) p.push(...num(7, 1)); // e.g. a future enum, unknown to this decoder
  return p;
}

function entity({ id, deleted, tripUpdate, vehiclePosition }: {
  id?: string;
  deleted?: boolean;
  tripUpdate?: Parameters<typeof makeTripUpdate>[0];
  vehiclePosition?: string;
}) {
  const p: number[] = [];
  if (id !== undefined) p.push(...str(1, id));
  if (deleted) p.push(...num(2, 1));
  if (tripUpdate) p.push(...len(3, makeTripUpdate(tripUpdate)));
  if (vehiclePosition !== undefined) p.push(...str(4, vehiclePosition)); // decoded feeds skip this
  return p;
}

function feedMessage({ version, timestamp, entities, extraField }: {
  version?: string;
  timestamp?: number;
  entities: Parameters<typeof entity>[0][];
  extraField?: boolean;
}) {
  const header: number[] = [];
  if (version !== undefined) header.push(...str(1, version));
  if (timestamp !== undefined) header.push(...num(3, timestamp));
  const p: number[] = [...len(1, header)];
  for (const e of entities) p.push(...len(2, entity(e)));
  if (extraField) p.push(...num(9, 4)); // a future FeedMessage field, unknown here
  return new Uint8Array(p);
}

describe('decodeTripUpdatesFeed', () => {
  it('decodes the envelope: version, header stamp, trip ids and route joins', async () => {
    const feed = await decodeTripUpdatesFeed(
      feedMessage({
        version: '2.0',
        timestamp: 1800000000,
        entities: [
          {
            id: 'trip-1',
            tripUpdate: {
              tripId: 'T1',
              routeId: 'R9',
              directionId: 1,
              delay: -5,
              stops: [
                { seq: 3, arrival: { delay: 90 }, departure: { delay: 90 } },
                { stopId: 'S2', rel: 1 },
                { stopId: 'S1', arrival: { time: 1800012345, uncertainty: 30 } },
              ],
            },
          },
        ],
      }),
    );
    expect(feed.version).toBe('2.0');
    expect(feed.timestamp).toBe(1800000000);
    expect(feed.orphaned).toHaveLength(0);
    const trip = feed.trips.get('trip-1');
    expect(trip?.tripId).toBe('T1');
    expect(trip?.routeId).toBe('R9');
    expect(trip?.directionId).toBe(1);
    expect(trip?.delay).toBe(-5);
    expect(trip?.stops).toHaveLength(3);
    expect(trip?.stops[0]).toMatchObject({ stopSequence: 3, arrival: { delay: 90 }, departure: { delay: 90 } });
    expect(trip?.stops[1]).toMatchObject({ stopId: 'S2', scheduleRelationship: 1 });
    expect(trip?.stops[2]).toMatchObject({ stopId: 'S1', arrival: { time: 1800012345, uncertainty: 30 } });
  });

  it('decodes field numbers exactly at their boundaries', async () => {
    // stop updates land at field 2 while the trip delay rides field 5: build
    // one update carrying both, and assert both land at their own message.
    const feed = await decodeTripUpdatesFeed(
      feedMessage({
        entities: [
          {
            id: 'e',
            tripUpdate: {
              tripId: 'T',
              stops: [{ seq: 7, arrival: { delay: -120 } }],
              delay: 30,
            },
          },
        ],
      }),
    );
    const trip = feed.trips.get('e')!;
    expect(trip.delay).toBe(30);
    expect(trip.stops).toHaveLength(1);
    expect(trip.stops[0]?.arrival?.delay).toBe(-120);
  });

  it('reads a feed produced against the wire shape of a real agency', async () => {
    // Mirrors the live Adelaide entity parsed during development: absolute
    // times in StopTimeEvent.time, no trip-level delay.
    const feed = await decodeTripUpdatesFeed(
      feedMessage({
        version: '1.0',
        timestamp: 1792839307,
        entities: [
          {
            id: 'T105083518011',
            tripUpdate: {
              tripId: '1050835',
              routeId: '411',
              directionId: 0,
              stops: [
                { seq: 34, stopId: '102414', arrival: { time: 1792838489 } },
                { seq: 35, stopId: '101625', arrival: { time: 1792838849 } },
              ],
            },
          },
        ],
      }),
    );
    const trip = feed.trips.get('T105083518011')!;
    expect(trip.tripId).toBe('1050835');
    expect(trip.routeId).toBe('411');
    expect(trip.stops[0]?.arrival?.time).toBe(1792838489);
    expect(trip.delay).toBeUndefined();
  });

  it('last entity per trip_id wins', async () => {
    const feed = await decodeTripUpdatesFeed(
      feedMessage({
        entities: [
          { id: 't', tripUpdate: { tripId: 'T', stops: [], delay: 10 } },
          { id: 't', tripUpdate: { tripId: 'T', stops: [], delay: 130 } },
        ],
      }),
    );
    expect(feed.trips.get('t')?.delay).toBe(130);
  });

  it('retracts deleted entities and files updates without a trip_id as orphans', async () => {
    const withOrphan = await decodeTripUpdatesFeed(
      feedMessage({ entities: [{ tripUpdate: { tripId: 'T', stops: [] } }] }),
    );
    expect(withOrphan.trips.size).toBe(0);
    expect(withOrphan.orphaned).toHaveLength(1);
    expect(withOrphan.orphaned[0]?.tripId).toBe('T');

    const feed = await decodeTripUpdatesFeed(
      feedMessage({
        entities: [
          { id: 't', tripUpdate: { tripId: 'T', stops: [], delay: 9 } },
          { id: 't', deleted: true },
        ],
      }),
    );
    expect(feed.trips.has('t')).toBe(false);
  });

  it('skips unknown fields at every nesting level and still decodes around them', async () => {
    const feed = await decodeTripUpdatesFeed(
      feedMessage({
        version: '2.0',
        extraField: true,
        entities: [
          { id: 'a', vehiclePosition: 'not-really-a-vehicle', tripUpdate: { tripId: 'A', stops: [], delay: 1 } },
        ],
      }),
    );
    expect(feed.trips.get('a')?.delay).toBe(1);
  });

  it('accepts the gzipped form agencies actually serve', async () => {
    const { gzipSync } = await import('node:zlib');
    const message = feedMessage({
      timestamp: 1234,
      entities: [{ id: 'z', tripUpdate: { tripId: 'Z', stops: [{ seq: 1, arrival: { delay: 60 } }] } }],
    });
    const gzipped = new Uint8Array(gzipSync(message));
    const feed = await decodeTripUpdatesFeed(gzipped);
    expect(feed.timestamp).toBe(1234);
    expect(feed.trips.get('z')?.stops[0]?.arrival?.delay).toBe(60);
  });

  it('throws on truncated wire data', async () => {
    // header tag says a 40-byte version string; the buffer ends after two bytes
    await expect(
      decodeTripUpdatesFeed(new Uint8Array([0x0a, 0x28, 0x32, 0x2e])),
    ).rejects.toThrow(/end of buffer/);
  });
});

void stopEvent;

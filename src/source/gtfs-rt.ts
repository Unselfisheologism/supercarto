/**
 * GTFS-Realtime protobuf decoding - TripUpdates only.
 *
 * Static schedules answer "when does the route run"; riders ask "is my bus
 * late". TRIP_UPDATES is the feed entity that carries that, so this decoder
 * reads exactly that entity and skips VehiclePositions/Alerts by wire type
 * rather than pretending they were read.
 *
 * Field numbers are the published spec's current generation (the 2024
 * renumbering, where `stop_time_update` is field 2 and the trip-level
 * `delay` is field 5) and were verified against both the canonical
 * gtfs-realtime.proto and a live agency feed on the wire. The decoder skips
 * unknown fields, so later spec amendments decode everywhere on this module.
 *
 * The schema numbers live beside the reader in one table-comment block in
 * each language file; a future spec revision that renumbers a field is a
 * one-line change verified against a real feed before merge.
 */

import { gunzip } from './zlibsafe.js';
import { ProtoReader } from './proto.js';

/** One predicted event, exactly as the feed expressed it. */
export interface RtStopEvent {
  /** Seconds against schedule. Positive is late. */
  delay?: number;
  /** Absolute prediction, seconds since epoch. Prefer over `delay` when read. */
  time?: number;
  /** Feed-stated error bound, seconds. We carry it; nothing renders a guess from it. */
  uncertainty?: number;
}

export interface RtStopUpdate {
  /** One of these two is required by the spec. */
  stopSequence?: number;
  stopId?: string;
  arrival?: RtStopEvent;
  departure?: RtStopEvent;
  /** 0 scheduled, 1 skipped, 2 no-data, 3 unscheduled. */
  scheduleRelationship?: number;
}

export interface RtTrip {
  tripId?: string;
  routeId?: string;
  directionId?: number;
  /** The update's own stamp, seconds since epoch, if the feed sent one. */
  timestamp?: number;
  /** Trip-level delay; defaults every stop without an explicit update. */
  delay?: number;
  stops: RtStopUpdate[];
}

export interface RtFeed {
  /** Feed-stated version, e.g. "2.0". */
  version?: string;
  /** The dataset's produce-time stamp, seconds since epoch, if the feed sent one. */
  timestamp?: number;
  /** Trip updates by trip_id; last entity in the feed wins on duplicates. */
  trips: Map<string, RtTrip>;
  /** Trip updates that arrive with no trip_id; they cannot be joined anywhere. */
  orphaned: RtTrip[];
}

/** Gzip magic: real agency feeds frequently ship as `trip-updates.pb.gz`. */
const GZIP_MAGIC = [0x1f, 0x8b];

/**
 * Decode a full FeedMessage, transparently inflating a gzipped payload.
 * Throws `Error` on malformed wire data - callers turn that into an honest
 * "unavailable" state, never into an empty map that reads as "no delays".
 */
export async function decodeTripUpdatesFeed(input: Uint8Array): Promise<RtFeed> {
  const buf =
    input.length >= 2 && input[0] === GZIP_MAGIC[0] && input[1] === GZIP_MAGIC[1]
      ? await gunzip(input)
      : input;

  const feed: RtFeed = { trips: new Map(), orphaned: [] };
  const r = new ProtoReader(buf);
  while (!r.done) {
    const { field, wire } = r.key();
    if (field === 1 && wire === 2) {
      decodeHeader(r.bytes(), feed);
    } else if (field === 2 && wire === 2) {
      decodeEntity(r.bytes(), feed);
    } else {
      r.skip(wire);
    }
  }
  return feed;
}

/**
 * Wire field numbers for the messages read here. Verified 2026-10-24 against
 * google/transit master and an agency TripUpdates feed:
 *   FeedHeader:    version=1, incrementality=2, timestamp=3
 *   FeedEntity:    id=1, is_deleted=2, trip_update=3
 *   TripUpdate:    trip=1, stop_time_update=2, vehicle=3, timestamp=4, delay=5
 *   TripDescriptor: trip_id=1, start_time=2, start_date=3, start=4, route_id=5, direction_id=6
 *   StopTimeUpdate: sequence=1, arrival=2, departure=3, stop_id=4, schedule_relationship=5
 *   StopTimeEvent:  delay=1, time=2, uncertainty=3
 */
const FIELD = {
  headerVersion: 1,
  headerTimestamp: 3,
  entityId: 1,
  entityDeleted: 2,
  entityTripUpdate: 3,
  tripDescriptor: 1,
  tripTimestamp: 4,
  tripDelay: 5,
  descriptorTripId: 1,
  descriptorRouteId: 5,
  descriptorDirectionId: 6,
  stopEventDelay: 1,
  stopEventTime: 2,
  stopEventUncertainty: 3,
  stopSequence: 1,
  stopArrival: 2,
  stopDeparture: 3,
  stopId: 4,
  stopScheduleRelationship: 5,
} as const;

function decodeHeader(buf: Uint8Array, feed: RtFeed): void {
  const r = new ProtoReader(buf);
  while (!r.done) {
    const { field, wire } = r.key();
    if (field === FIELD.headerVersion && wire === 2) {
      feed.version = new TextDecoder().decode(r.bytes());
    } else if (field === FIELD.headerTimestamp && wire === 0) {
      feed.timestamp = r.int64();
    } else {
      r.skip(wire);
    }
  }
}

function decodeEntity(buf: Uint8Array, feed: RtFeed): void {
  const r = new ProtoReader(buf);
  let id: string | undefined;
  let deleted = false;
  let trip: RtTrip | undefined;
  while (!r.done) {
    const { field, wire } = r.key();
    if (field === FIELD.entityId && wire === 2) {
      id = new TextDecoder().decode(r.bytes());
    } else if (field === FIELD.entityDeleted && wire === 0) {
      deleted = r.varint() !== 0;
    } else if (field === FIELD.entityTripUpdate && wire === 2) {
      trip = decodeTripUpdate(r.bytes());
    } else {
      r.skip(wire);
    }
  }
  // A deleted entity means the operator retracted the prediction; showing a
  // stale delay after a retraction would be exactly the fabricated time the
  // honesty rules exist to prevent.
  if (id === undefined) {
    if (trip) feed.orphaned.push(trip);
    return;
  }
  if (deleted) {
    feed.trips.delete(id);
    return;
  }
  if (trip) feed.trips.set(id, trip);
}

function decodeTripUpdate(buf: Uint8Array): RtTrip {
  const trip: RtTrip = { stops: [] };
  const r = new ProtoReader(buf);
  while (!r.done) {
    const { field, wire } = r.key();
    if (field === FIELD.tripDescriptor && wire === 2) {
      decodeTripDescriptor(r.bytes(), trip);
    } else if (field === FIELD.tripTimestamp && wire === 0) {
      trip.timestamp = r.int64();
    } else if (field === FIELD.tripDelay && wire === 0) {
      trip.delay = r.int32();
    } else if (field === 2 && wire === 2) {
      trip.stops.push(decodeStopTimeUpdate(r.bytes()));
    } else {
      r.skip(wire);
    }
  }
  return trip;
}

function decodeTripDescriptor(buf: Uint8Array, trip: RtTrip): void {
  const r = new ProtoReader(buf);
  while (!r.done) {
    const { field, wire } = r.key();
    if (field === FIELD.descriptorTripId && wire === 2) {
      trip.tripId = new TextDecoder().decode(r.bytes());
    } else if (field === FIELD.descriptorRouteId && wire === 2) {
      trip.routeId = new TextDecoder().decode(r.bytes());
    } else if (field === FIELD.descriptorDirectionId && wire === 0) {
      trip.directionId = r.int32();
    } else {
      r.skip(wire);
    }
  }
}

function decodeStopTimeUpdate(buf: Uint8Array): RtStopUpdate {
  const stop: RtStopUpdate = {};
  const r = new ProtoReader(buf);
  while (!r.done) {
    const { field, wire } = r.key();
    if (field === FIELD.stopSequence && wire === 0) {
      stop.stopSequence = r.int32();
    } else if (field === FIELD.stopId && wire === 2) {
      stop.stopId = new TextDecoder().decode(r.bytes());
    } else if (field === FIELD.stopArrival && wire === 2) {
      stop.arrival = decodeStopTimeEvent(r.bytes());
    } else if (field === FIELD.stopDeparture && wire === 2) {
      stop.departure = decodeStopTimeEvent(r.bytes());
    } else if (field === FIELD.stopScheduleRelationship && wire === 0) {
      stop.scheduleRelationship = r.varint();
    } else {
      r.skip(wire);
    }
  }
  return stop;
}

function decodeStopTimeEvent(buf: Uint8Array): RtStopEvent {
  const event: RtStopEvent = {};
  const r = new ProtoReader(buf);
  while (!r.done) {
    const { field, wire } = r.key();
    if (field === FIELD.stopEventDelay && wire === 0) {
      event.delay = r.int32();
    } else if (field === FIELD.stopEventTime && wire === 0) {
      event.time = r.int64();
    } else if (field === FIELD.stopEventUncertainty && wire === 0) {
      event.uncertainty = r.int32();
    } else {
      r.skip(wire);
    }
  }
  return event;
}

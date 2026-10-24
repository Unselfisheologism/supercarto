"""GTFS-Realtime protobuf decoding, TripUpdates only — port of ``src/source/gtfs-rt.ts``.

Static schedules answer "when does the route run"; riders ask "is my bus
late". TRIP_UPDATES is the feed entity that carries that, so this decoder
reads exactly that entity and skips VehiclePositions/Alerts by wire type
rather than pretending they were read.

Field numbers are the published spec's current generation (the 2024
renumbering, where ``stop_time_update`` is field 2 and the trip-level
``delay`` is field 5) and were verified against both the canonical
gtfs-realtime.proto and a live agency feed on the wire. The decoder skips
unknown fields, so later spec amendments decode everywhere on this module.

The schema numbers live in the ``FIELD`` table; a future spec revision that
renumbers a field is a one-line change verified against a real feed before
merge.
"""

from __future__ import annotations

import gzip

from .proto import ProtoReader


class RtStopEvent:
    """One predicted event, exactly as the feed expressed it."""

    def __init__(self) -> None:
        self.delay: int | None = None  # seconds against schedule; positive is late
        self.time: int | None = None  # absolute prediction, seconds since epoch
        self.uncertainty: int | None = None  # feed-stated error bound, seconds


class RtStopUpdate:
    """One stop's update on one trip."""

    def __init__(self) -> None:
        self.stop_sequence: int | None = None  # one of these two is required
        self.stop_id: str | None = None
        self.arrival: RtStopEvent | None = None
        self.departure: RtStopEvent | None = None
        self.schedule_relationship: int | None = None  # 0 sched, 1 skip, 2 no-data, 3 unsched


class RtTrip:
    """One trip's realtime state."""

    def __init__(self) -> None:
        self.trip_id: str | None = None
        self.route_id: str | None = None
        self.direction_id: int | None = None
        self.timestamp: int | None = None  # the update's own stamp, epoch seconds
        self.delay: int | None = None  # trip-level delay; defaults every stop
        self.stops: list[RtStopUpdate] = []


class RtFeed:
    """A decoded FeedMessage."""

    def __init__(self) -> None:
        self.version: str | None = None  # feed-stated version, e.g. "2.0"
        self.timestamp: int | None = None  # the dataset's produce-time stamp
        self.trips: dict[str, RtTrip] = {}  # by trip_id; last entity wins on duplicates
        self.orphaned: list[RtTrip] = []  # updates with no trip_id: unjoinable


# Wire field numbers for the messages read here. Verified 2026-10-24 against
# google/transit master and an agency TripUpdates feed:
#   FeedHeader:     version=1, incrementality=2, timestamp=3
#   FeedEntity:     id=1, is_deleted=2, trip_update=3
#   TripUpdate:     trip=1, stop_time_update=2, vehicle=3, timestamp=4, delay=5
#   TripDescriptor: trip_id=1, start_time=2, start_date=3, start=4, route_id=5, direction_id=6
#   StopTimeUpdate: sequence=1, arrival=2, departure=3, stop_id=4, schedule_relationship=5
#   StopTimeEvent:  delay=1, time=2, uncertainty=3
FIELD = {
    "header_version": 1,
    "header_timestamp": 3,
    "entity_id": 1,
    "entity_deleted": 2,
    "entity_trip_update": 3,
    "trip_descriptor": 1,
    "trip_timestamp": 4,
    "trip_delay": 5,
    "descriptor_trip_id": 1,
    "descriptor_route_id": 5,
    "descriptor_direction_id": 6,
    "stop_event_delay": 1,
    "stop_event_time": 2,
    "stop_event_uncertainty": 3,
    "stop_sequence": 1,
    "stop_arrival": 2,
    "stop_departure": 3,
    "stop_id": 4,
    "stop_schedule_relationship": 5,
}


def decode_trip_updates_feed(input_: bytes) -> RtFeed:
    """Decode a full FeedMessage, transparently inflating a gzipped payload.

    Raises ``ValueError`` on malformed wire data - callers turn that into an
    honest "unavailable" state, never into an empty map that reads as "no
    delays".
    """
    if len(input_) >= 2 and input_[0] == 0x1F and input_[1] == 0x8B:
        body = gzip.decompress(input_)
    else:
        body = input_

    feed = RtFeed()
    r = ProtoReader(body)
    while not r.done:
        k = r.key()
        if k.field == 1 and k.wire == 2:
            _decode_header(r.bytes(), feed)
        elif k.field == 2 and k.wire == 2:
            _decode_entity(r.bytes(), feed)
        else:
            r.skip(k.wire)
    return feed


def _decode_header(buf: bytes, feed: RtFeed) -> None:
    r = ProtoReader(buf)
    while not r.done:
        k = r.key()
        if k.field == FIELD["header_version"] and k.wire == 2:
            feed.version = r.bytes().decode()
        elif k.field == FIELD["header_timestamp"] and k.wire == 0:
            feed.timestamp = r.int64()
        else:
            r.skip(k.wire)


def _decode_entity(buf: bytes, feed: RtFeed) -> None:
    r = ProtoReader(buf)
    entity_id: str | None = None
    deleted = False
    trip: RtTrip | None = None
    while not r.done:
        k = r.key()
        if k.field == FIELD["entity_id"] and k.wire == 2:
            entity_id = r.bytes().decode()
        elif k.field == FIELD["entity_deleted"] and k.wire == 0:
            deleted = r.varint() != 0
        elif k.field == FIELD["entity_trip_update"] and k.wire == 2:
            trip = _decode_trip_update(r.bytes())
        else:
            r.skip(k.wire)
    # A deleted entity means the operator retracted the prediction; showing a
    # stale delay after a retraction would be exactly the fabricated time the
    # honesty rules exist to prevent.
    if entity_id is None:
        if trip is not None:
            feed.orphaned.append(trip)
        return
    if deleted:
        feed.trips.pop(entity_id, None)
        return
    if trip is not None:
        feed.trips[entity_id] = trip


def _decode_trip_update(buf: bytes) -> RtTrip:
    trip = RtTrip()
    r = ProtoReader(buf)
    while not r.done:
        k = r.key()
        if k.field == FIELD["trip_descriptor"] and k.wire == 2:
            _decode_trip_descriptor(r.bytes(), trip)
        elif k.field == FIELD["trip_timestamp"] and k.wire == 0:
            trip.timestamp = r.int64()
        elif k.field == FIELD["trip_delay"] and k.wire == 0:
            trip.delay = r.int32()
        elif k.field == 2 and k.wire == 2:
            trip.stops.append(_decode_stop_time_update(r.bytes()))
        else:
            r.skip(k.wire)
    return trip


def _decode_trip_descriptor(buf: bytes, trip: RtTrip) -> None:
    r = ProtoReader(buf)
    while not r.done:
        k = r.key()
        if k.field == FIELD["descriptor_trip_id"] and k.wire == 2:
            trip.trip_id = r.bytes().decode()
        elif k.field == FIELD["descriptor_route_id"] and k.wire == 2:
            trip.route_id = r.bytes().decode()
        elif k.field == FIELD["descriptor_direction_id"] and k.wire == 0:
            trip.direction_id = r.int32()
        else:
            r.skip(k.wire)


def _decode_stop_time_update(buf: bytes) -> RtStopUpdate:
    stop = RtStopUpdate()
    r = ProtoReader(buf)
    while not r.done:
        k = r.key()
        if k.field == FIELD["stop_sequence"] and k.wire == 0:
            stop.stop_sequence = r.int32()
        elif k.field == FIELD["stop_id"] and k.wire == 2:
            stop.stop_id = r.bytes().decode()
        elif k.field == FIELD["stop_arrival"] and k.wire == 2:
            stop.arrival = _decode_stop_time_event(r.bytes())
        elif k.field == FIELD["stop_departure"] and k.wire == 2:
            stop.departure = _decode_stop_time_event(r.bytes())
        elif k.field == FIELD["stop_schedule_relationship"] and k.wire == 0:
            stop.schedule_relationship = r.varint()
        else:
            r.skip(k.wire)
    return stop


def _decode_stop_time_event(buf: bytes) -> RtStopEvent:
    event = RtStopEvent()
    r = ProtoReader(buf)
    while not r.done:
        k = r.key()
        if k.field == FIELD["stop_event_delay"] and k.wire == 0:
            event.delay = r.int32()
        elif k.field == FIELD["stop_event_time"] and k.wire == 0:
            event.time = r.int64()
        elif k.field == FIELD["stop_event_uncertainty"] and k.wire == 0:
            event.uncertainty = r.int32()
        else:
            r.skip(k.wire)
    return event

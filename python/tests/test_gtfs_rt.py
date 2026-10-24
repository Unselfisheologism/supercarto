"""The TripUpdates schema against bytes built by hand — port of ``test/gtfs-rt.test.ts``.

Field numbers changed between spec generations (the trip-level delay now rides
field 5, stop_time_update field 2), and a decoder built off the old 2015
numbers reads real agency feeds into wrong-shaped silence. These tests pin the
current numbering through the same envelope the real wire uses, plus the
honesty cases: deletion retraction, orphans, unknown fields, and gzip.

Reviewer's field-number facts, straight from the canonical gtfs-realtime.proto:
  header: version=1, timestamp=3
  entity: id=1, is_deleted=2, trip_update=3
  trip:   descriptor=1, stops=2, timestamp=4, delay=5
  stop:   seq=1, arrival=2, departure=3, stop_id=4, relationship=5
  event:  delay=1, time=2, uncertainty=3
"""

import gzip

import pytest

from supercarto.gtfs_rt import decode_trip_updates_feed


def _varint(value: int) -> bytes:
    x = value if value >= 0 else value + (1 << 64)
    out = bytearray()
    while True:
        byte = x & 0x7F
        x >>= 7
        if x:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def _key(field: int, wire: int) -> bytes:
    return _varint((field << 3) | wire)


def _len(field: int, payload: bytes) -> bytes:
    return _key(field, 2) + _varint(len(payload)) + payload


def _num(field: int, value: int) -> bytes:
    return _key(field, 0) + _varint(value)


def _str(field: int, text: str) -> bytes:
    return _len(field, text.encode())


def _event(delay: int | None = None, time: int | None = None, uncertainty: int | None = None) -> bytes:
    p = b""
    if delay is not None:
        p += _num(1, delay)
    if time is not None:
        p += _num(2, time)
    if uncertainty is not None:
        p += _num(3, uncertainty)
    return p


def _stop_update(*, seq: int | None = None, stop_id: str | None = None, arrival: dict | None = None, departure: dict | None = None, rel: int | None = None) -> bytes:
    p = b""
    if seq is not None:
        p += _num(1, seq)
    if stop_id is not None:
        p += _str(4, stop_id)
    if arrival is not None:
        p += _len(2, _event(**arrival))
    if departure is not None:
        p += _len(3, _event(**departure))
    if rel is not None:
        p += _num(5, rel)
    return p


def _trip_update(*, trip_id: str | None = None, route_id: str | None = None, direction_id: int | None = None, delay: int | None = None, stops: tuple[dict, ...] | tuple = (), unknown_field: bool = False) -> bytes:
    desc = b""
    if trip_id is not None:
        desc += _str(1, trip_id)
    if route_id is not None:
        desc += _str(5, route_id)
    if direction_id is not None:
        desc += _num(6, direction_id)
    p = _len(1, desc)
    for s in stops:
        p += _len(2, _stop_update(**s))
    if delay is not None:
        p += _num(5, delay)
    if unknown_field:
        p += _num(7, 1)  # a future enum, unknown to this decoder
    return p


def _entity(*, id=None, deleted=False, tu: bytes | None = None) -> bytes:
    p = b""
    if id is not None:
        p += _str(1, id)
    if deleted:
        p += _num(2, 1)
    if tu is not None:
        p += _len(3, tu)
    return p


def _feed_message(*, version=None, timestamp=None, entities=(), extra_field=False) -> bytes:
    header = b""
    if version is not None:
        header += _str(1, version)
    if timestamp is not None:
        header += _num(3, timestamp)
    p = _len(1, header)
    for e in entities:
        p += _len(2, e)
    if extra_field:
        p += _num(9, 4)  # a future FeedMessage field, unknown here
    return p


def test_envelope_decodes() -> None:
    feed = decode_trip_updates_feed(
        _feed_message(
            version="2.0",
            timestamp=1800000000,
            entities=[
                _entity(
                    id="trip-1",
                    tu=_trip_update(
                        trip_id="T1",
                        route_id="R9",
                        direction_id=1,
                        delay=-5,
                        stops=[
                            {"seq": 3, "arrival": {"delay": 90}, "departure": {"delay": 90}},
                            {"stop_id": "S2", "rel": 1},
                            {"stop_id": "S1", "arrival": {"time": 1800012345, "uncertainty": 30}},
                        ],
                    ),
                )
            ],
        )
    )
    assert feed.version == "2.0"
    assert feed.timestamp == 1800000000
    assert feed.orphaned == []
    trip = feed.trips["trip-1"]
    assert trip.trip_id == "T1"
    assert trip.route_id == "R9"
    assert trip.direction_id == 1
    assert trip.delay == -5
    assert len(trip.stops) == 3
    assert trip.stops[0].stop_sequence == 3
    assert trip.stops[0].arrival.delay == 90
    assert trip.stops[1].stop_id == "S2"
    assert trip.stops[1].schedule_relationship == 1
    assert trip.stops[2].arrival.time == 1800012345
    assert trip.stops[2].arrival.uncertainty == 30


def test_stop_updates_at_field_2_and_delay_at_field_5() -> None:
    feed = decode_trip_updates_feed(
        _feed_message(
            entities=[
                _entity(
                    id="e",
                    tu=_trip_update(
                        trip_id="T",
                        stops=[{"seq": 7, "arrival": {"delay": -120}}],
                        delay=30,
                    ),
                )
            ]
        )
    )
    trip = feed.trips["e"]
    assert trip.delay == 30
    assert len(trip.stops) == 1
    assert trip.stops[0].arrival.delay == -120


def test_live_agency_wire_shape() -> None:
    """Mirrors the live Adelaide entity parsed during development."""
    feed = decode_trip_updates_feed(
        _feed_message(
            version="1.0",
            timestamp=1792839307,
            entities=[
                _entity(
                    id="T105083518011",
                    tu=_trip_update(
                        trip_id="1050835",
                        route_id="411",
                        direction_id=0,
                        stops=[
                            {"seq": 34, "stop_id": "102414", "arrival": {"time": 1792838489}},
                            {"seq": 35, "stop_id": "101625", "arrival": {"time": 1792838849}},
                        ],
                    ),
                )
            ],
        )
    )
    trip = feed.trips["T105083518011"]
    assert trip.trip_id == "1050835"
    assert trip.route_id == "411"
    assert trip.stops[0].arrival.time == 1792838489
    assert trip.delay is None


def test_last_entity_wins() -> None:
    feed = decode_trip_updates_feed(
        _feed_message(
            entities=[
                _entity(id="t", tu=_trip_update(trip_id="T", delay=10)),
                _entity(id="t", tu=_trip_update(trip_id="T", delay=130)),
            ]
        )
    )
    assert feed.trips["t"].delay == 130


def test_deletion_and_orphans() -> None:
    feed = decode_trip_updates_feed(
        _feed_message(entities=[_entity(tu=_trip_update(trip_id="T"))])
    )
    assert feed.trips == {}
    assert len(feed.orphaned) == 1

    feed = decode_trip_updates_feed(
        _feed_message(
            entities=[
                _entity(id="t", tu=_trip_update(trip_id="T", delay=9)),
                _entity(id="t", deleted=True),
            ]
        )
    )
    assert "t" not in feed.trips


def test_unknown_fields_skipped() -> None:
    feed = decode_trip_updates_feed(
        _feed_message(
            version="2.0",
            extra_field=True,
            entities=[
                _entity(id="a", tu=_trip_update(trip_id="A", delay=1, unknown_field=True))
            ],
        )
    )
    assert feed.trips["a"].delay == 1


def test_gzipped_payload() -> None:
    gzipped = gzip.compress(
        _feed_message(
            timestamp=1234,
            entities=[
                _entity(
                    id="z",
                    tu=_trip_update(trip_id="Z", stops=[{"seq": 1, "arrival": {"delay": 60}}]),
                )
            ],
        )
    )
    feed = decode_trip_updates_feed(gzipped)
    assert feed.timestamp == 1234
    assert feed.trips["z"].stops[0].arrival.delay == 60


def test_truncated_wire_throws() -> None:
    with pytest.raises(ValueError, match="past end"):
        decode_trip_updates_feed(b"\x0a\x28\x32\x2e")

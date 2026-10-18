"""Unit tests for the ported live sources: Overpass, weather, routing,
terrain, heat. Everything runs against stubs or synthetic payloads — no
network.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from supercarto import overpass as ov
from supercarto import routing
from supercarto import weather as wx
from supercarto.heat import density_to_heat, slope_to_heat
from supercarto.terrain import decode_raw_terrarium, sample_bilinear, tiles_for

# ---------------------------------------------------------------------------
# Layer normalization
# ---------------------------------------------------------------------------


def test_normalize_layers_expands_aliases_in_priority_order():
    # `poi` expands, `road` joins the highway machinery; both sort into the
    # documented priority order, not the caller's order.
    out = ov.normalize_layers(["poi", "road", "natural"])
    assert out[0] == "highway"
    assert "amenity" in out and "shop" in out and "tourism" in out
    assert out.index("natural") > out.index("amenity")


def test_normalize_layers_dedupes_after_expansion():
    # `poi` expands to amenity/shop/tourism; shop and amenity add nothing new.
    out = ov.normalize_layers(["poi", "shop", "amenity"])
    assert out == ["amenity", "shop", "tourism"]


def test_normalize_layers_rejects_unknown_names_loudly():
    with pytest.raises(ValueError) as e:
        ov.normalize_layers(["roads"])
    assert '"roads"' in str(e.value)
    assert "Valid:" in str(e.value)


# ---------------------------------------------------------------------------
# Query building
# ---------------------------------------------------------------------------


def test_build_query_bbox_inside_statement():
    q = ov.build_query(
        {
            "bbox": {"south": 37.76, "west": -122.42, "north": 37.77, "east": -122.41},
            "layers": ["highway"],
            "maxFeatures": 0,
        }
    )
    # bbox filters go inside the statement parentheses, in positional form —
    # the ``bbox:`` prefixed form is rejected for negative latitudes.
    assert "way(37.76,-122.42,37.77,-122.41)[highway=motorway];" in q
    assert "node(37.76,-122.42,37.77,-122.41)[highway=bus_stop];" in q
    assert q.rstrip().endswith("out geom qt 5000;")


def test_build_query_excludes_micro_pathways_from_way_queries():
    q = ov.build_query(
        {
            "bbox": {"south": 0, "west": 0, "north": 0.001, "east": 0.001},
            "layers": ["amenity"],
            "maxFeatures": 0,
        }
    )
    assert 'way(0,0,0.001,0.001)[amenity][highway!~"^(footway|path|steps|cycleway|track|bridleway|corridor)$"];' in q


def test_build_query_uses_separate_natural_statements():
    q = ov.build_query(
        {"bbox": {"south": 0, "west": 0, "north": 0.001, "east": 0.001}, "layers": ["natural"], "maxFeatures": 0}
    )
    assert "[natural=water];" in q
    assert "[natural=wood];" in q
    assert "[natural=scrub];" in q
    # A bare [natural] match would also return natural=tree on every way.
    assert "[natural];" not in q


# ---------------------------------------------------------------------------
# Response conversion + safety filters
# ---------------------------------------------------------------------------


def _stub_response(body: dict):
    class R:
        status = 200
        ok = True
        text = json.dumps(body)

    return R()


def test_fetch_converts_ways_with_inline_geom_to_features():
    elements = [
        {"type": "way", "id": 7, "tags": {"highway": "residential", "name": "Folsom"},
         "geometry": [{"lat": 37.0, "lon": -122.0}, {"lat": 37.001, "lon": -122.0}]},
    ]

    sources = []

    def fetcher_factory(source):
        def stub(url, **kw):
            sources.append(source)
            return _stub_response({"elements": elements})
        return stub

    src = ov.OverpassSource(fetch=fetcher_factory("used"))
    res = src.fetch({"bbox": {"south": 36.99, "west": -122.01, "north": 37.01, "east": -121.99},
                     "layers": ["highway"], "maxFeatures": 50000})
    assert len(res["features"]) == 1
    f = res["features"][0]
    assert f["geometry"]["type"] == "LineString"
    assert f["properties"]["name"] == "Folsom"


def test_closed_area_way_becomes_polygon():
    # The way->feature conversion decides area vs line from the tags alone.
    coords = [(2.0, 1.0), (2.0, 1.001), (2.001, 1.001), (2.001, 1.0), (2.0, 1.0)]
    f = ov.way_to_feature({"id": 9, "tags": {"building": "yes"}}, coords)
    assert f["geometry"]["type"] == "Polygon"
    assert f["geometry"]["coordinates"][0][0] == [2.0, 1.0]
    # A closed waterway is a line, not a lake; a bare natural=yes is not an
    # area either.
    assert ov.way_to_feature({"id": 1, "tags": {"waterway": "stream"}}, coords) is not None
    assert ov.way_to_feature({"id": 1, "tags": {"waterway": "stream"}}, coords)["geometry"]["type"] == "LineString"
    ring_open = [(2.0, 1.0), (2.0, 1.001), (2.001, 1.001)]
    assert ov.way_to_feature({"id": 2, "tags": {"building": "yes"}}, ring_open)["geometry"]["type"] == "LineString"


def test_polygon_clipping_keeps_rings_that_stay_closed():
    """Vertex matching is by value here: ``keep`` holds fresh coordinate copies
    while the ring holds the arrays referenced by the geometry, so an identity
    comparison matches nothing and the reference (as of 0.4.11) silently
    emptied every polygon. Milestone 3 fixed both sides together."""

    class R:
        status = 200
        ok = True

        def __init__(self, payload):
            self.text = json.dumps(payload)

    def do(elements):
        src = ov.OverpassSource(fetch=lambda url, **kw: R({"elements": elements}))
        return src.fetch({"bbox": {"south": 0.99, "west": 1.99, "north": 1.01, "east": 2.01},
                          "layers": ["building"], "maxFeatures": 50000})

    closed_ring = [
        {"lat": 1.0, "lon": 2.0}, {"lat": 1.001, "lon": 2.0},
        {"lat": 1.001, "lon": 2.001}, {"lat": 1.0, "lon": 2.001},
        {"lat": 1.0, "lon": 2.0},
    ]

    # Everything in range: the ring survives untouched.
    res = do([{"type": "way", "id": 9, "tags": {"building": "yes"}, "geometry": closed_ring}])
    assert res["features"][0]["geometry"]["coordinates"] == [[
        [2.0, 1.0], [2.0, 1.001], [2.001, 1.001], [2.001, 1.0], [2.0, 1.0],
    ]]

    # One mid-run vertex flagged as corrupt: the surviving ring still closes,
    # so the polygon is kept with 4 vertices.
    clipped = list(closed_ring)
    clipped[2] = {"lat": 50.0, "lon": 90.0}
    res2 = do([{"type": "way", "id": 9, "tags": {"building": "yes"}, "geometry": clipped}])
    assert res2["features"][0]["geometry"]["coordinates"] == [[
        [2.0, 1.0], [2.0, 1.001], [2.001, 1.0], [2.0, 1.0],
    ]]

    # The closing vertex flagged instead: the dirty ring no longer closes, so
    # the way was never classified as an area — it is a line of the surviving
    # vertices.
    unclosed = list(closed_ring)
    unclosed[4] = {"lat": 50.0, "lon": 90.0}
    res3 = do([{"type": "way", "id": 9, "tags": {"building": "yes"}, "geometry": unclosed}])
    assert res3["features"][0]["geometry"]["type"] == "LineString"
    assert res3["features"][0]["geometry"]["coordinates"] == [
        [2.0, 1.0], [2.0, 1.001], [2.001, 1.001], [2.001, 1.0],
    ]


def test_multiline_clipping_keeps_the_longest_surviving_run():
    # MultiLineString is defensive this source never emits, but the clip must
    # still keep the longest run rather than fuse separate roads into one.
    g = {
        "type": "MultiLineString",
        "coordinates": [
            [[0.0, 0.0], [1.0, 0.0], [90.0, 0.0]],  # second vertex flagged
            [[2.0, 3.0], [2.0, 4.0], [2.0, 5.0]],   # fully in range, longest
        ],
    }
    f = {"id": 1, "properties": {}, "geometry": g}
    keep = [[0.0, 0.0], [1.0, 0.0], [2.0, 3.0], [2.0, 4.0], [2.0, 5.0]]
    out = ov.clip_geometry(f, keep)
    assert out["geometry"]["type"] == "LineString"
    assert out["geometry"]["coordinates"] == [[2.0, 3.0], [2.0, 4.0], [2.0, 5.0]]


def test_untagged_way_vertex_nodes_are_skipped():
    elements = [
        {"type": "node", "id": 1, "lat": 1.0, "lon": 2.0},  # geometry, no tags
        {"type": "node", "id": 2, "lat": 1.0, "lon": 2.0, "tags": {"name": "Point"}},
    ]
    src = ov.OverpassSource(fetch=lambda url, **kw: _stub_response({"elements": elements}))
    res = src.fetch({"bbox": {"south": 0.9, "west": 1.9, "north": 1.1, "east": 2.1},
                     "layers": ["highway"], "maxFeatures": 50000})
    assert [f["id"] for f in res["features"]] == [2]


def test_features_outside_area_are_discarded_with_warning():
    elements = [
        {"type": "node", "id": 1, "lat": 90.0, "lon": 0.0, "tags": {"name": "implausible"}},
        {"type": "node", "id": 2, "lat": 1.0, "lon": 2.0, "tags": {"name": "fine"}},
    ]
    src = ov.OverpassSource(fetch=lambda url, **kw: _stub_response({"elements": elements}))
    res = src.fetch({"bbox": {"south": 0.9, "west": 1.9, "north": 1.1, "east": 2.1},
                     "layers": ["highway"], "maxFeatures": 50000})
    assert [f["id"] for f in res["features"]] == [2]
    assert any("outside the requested area" in w for w in res["warnings"])


def test_all_features_implausible_is_a_loud_error_not_a_blank_map():
    elements = [{"type": "node", "id": 1, "lat": 90.0, "lon": 0.0, "tags": {"name": "x"}}]
    src = ov.OverpassSource(fetch=lambda url, **kw: _stub_response({"elements": elements}))
    with pytest.raises(ov.OverpassError) as e:
        src.fetch({"bbox": {"south": 0.9, "west": 1.9, "north": 1.1, "east": 2.1},
                   "layers": ["highway"], "maxFeatures": 50000})
    assert e.value.status == 502
    assert "every feature was outside" in str(e.value)


def test_rate_limit_error_is_surfaced_not_XML_blob():
    class R:
        status = 429
        ok = False
        text = "<p>Error: Too Many Requests. Slow down.</p>"

    src = ov.OverpassSource(fetch=lambda url, **kw: R())
    with pytest.raises(ov.OverpassError) as info:
        src._request("query", {})
    assert info.value.status == 429
    assert "Too Many Requests" in str(info.value)


def test_empty_result_on_populated_land_is_a_loud_refusal():
    """HTTP 200 with no elements is ambiguous, so the result is re-asked
    EMPTY_RETRY_BUDGET times; after that the query refuses a populated land
    box rather than serving a blank map that reads as nothing-there."""
    calls = {"n": 0}

    def stub(url, **kw):
        calls["n"] += 1

        class R:
            status = 200
            ok = True
            text = json.dumps({"elements": []})

        return R()

    src = ov.OverpassSource(fetch=stub, max_attempts=3)
    with pytest.raises(ov.OverpassError) as e:
        src.fetch(
            {
                "bbox": {"south": 10, "west": 10, "north": 10.01, "east": 10.01},
                "layers": [],
                "maxFeatures": 50000,
            }
        )
    assert e.value.status == 502
    assert "no data for a populated area" in str(e.value)
    assert calls["n"] == 3  # two probes, then the refusal


class _RateLimited:
    status = 429
    ok = False
    text = "<p>Error: Rate limited</p>"


class _NodesOnly:
    status = 200
    ok = True
    text = json.dumps({"elements": [
        {"type": "node", "id": 1, "lat": 10.0, "lon": 10.0, "tags": {"name": "p"}},
    ]})


def test_non_retryable_error_breaks_the_loop():
    calls = {"n": 0}

    def stub(url, **kw):
        calls["n"] += 1
        class R:
            status = 400
            ok = False
            text = "<p>Error: parse error: Query run out of memory</p>"
        return R()

    src = ov.OverpassSource(fetch=stub, max_attempts=5)
    with pytest.raises(ov.OverpassError):
        src.fetch({"bbox": {"south": 10, "west": 10, "north": 10.01, "east": 10.01},
                   "layers": ["highway"], "maxFeatures": 50000})
    assert calls["n"] == 1  # a 400 says nothing a smaller query can fix


def test_no_road_geometry_after_refusals_raises_starved_error():
    """The Tokyo failure: refuse, refuse, then a 200 with nodes only. Serving
    it would report a roadless city as success."""
    seq = [_RateLimited, _RateLimited, _NodesOnly]
    state = {"i": 0}

    def stub(url, **kw):
        cls = seq[min(state["i"], len(seq) - 1)]
        state["i"] += 1
        return cls()

    src = ov.OverpassSource(fetch=stub, max_attempts=3)
    with pytest.raises(ov.OverpassError) as e:
        src.fetch({"bbox": {"south": 10, "west": 10, "north": 10.01, "east": 10.01},
                   "layers": ["highway"], "maxFeatures": 50000})
    assert e.value.status == 502
    assert "no road geometry" in str(e.value)


def test_best_result_survives_later_refusals():
    """A good map on attempt 1 followed by a busy server must not throw away
    the map the caller already earned."""
    class GoodR:
        status = 200
        ok = True
        text = json.dumps({"elements": [
            # One way whose single inline vertex is junk (so no usable way
            # feature and `countWays == 0`, which triggers the shrink path),
            # plus a real in-area node.
            {"type": "way", "id": 1, "tags": {"highway": "residential"},
             "geometry": [{"lat": 50.0, "lon": 50.0}]},
            {"type": "node", "id": 2, "lat": 10.0, "lon": 10.0,
             "tags": {"name": "A St Cafe", "amenity": "cafe"}},
        ]})

    class BadR:
        status = 503
        ok = False
        text = "<p>Error: busy</p>"

    seq = [GoodR, BadR, GoodR, BadR]
    state = {"i": 0}

    def stub(url, **kw):
        cls = seq[min(state["i"], len(seq) - 1)]
        state["i"] += 1
        return cls()

    src = ov.OverpassSource(fetch=stub, max_attempts=4)
    res = src.fetch({"bbox": {"south": 9.99, "west": 9.99, "north": 10.01, "east": 10.01},
                     "layers": [], "maxFeatures": 50000})
    assert len(res["features"]) == 1
    assert res["features"][0]["properties"]["name"] == "A St Cafe"
    assert any("best result obtained" in w for w in res["warnings"])


def test_tighten_shrinks_and_gives_up():
    big = {"west": -0.01, "south": -0.01, "east": 0.01, "north": 0.01}
    smaller = ov.tighten(big)
    assert smaller["east"] - smaller["west"] < big["east"] - big["west"]
    assert ov.tighten({"west": 0, "south": 0, "east": 0.0005, "north": 0.0003}) is None


def test_is_populated_land_boundaries():
    assert ov.is_populated_land({"west": 0, "south": 14, "east": 1, "north": 15})
    assert not ov.is_populated_land({"west": 0, "south": 70, "east": 1, "north": 71})
    assert not ov.is_populated_land({"west": 0, "south": -60, "east": 1, "north": -59})


# ---------------------------------------------------------------------------
# Weather
# ---------------------------------------------------------------------------


def test_weather_unknown_conditions_use_nan_not_zero():
    # precipMm: 0 would tell an agent to leave the umbrella; NaN says unknown.
    now = wx.unknown_conditions()
    assert math.isnan(now["precipitationMm"])
    assert now["summary"].startswith("unknown")
    assert now["code"] == -1


def test_weather_degraded_fetch_returns_labelled_unknown():
    def boom(url, **kw):
        raise Exception("network down")  # noqa: TRY002

    w = wx.OpenMeteoWeather(fetch=boom).fetch(1.0, 2.0)
    assert w["degraded"] == "network down"
    assert math.isnan(w["now"]["tempC"])
    assert w["hourly"] == []
    assert w["source"] == "open-meteo"


def test_weather_parses_recorded_payload():
    body = json.loads((ROOT.parent / "scripts/parity/fixtures/live/weather.json").read_text())

    class _WeatherResp:
        status = 200
        ok = True

        def __init__(self, text):
            self.text = text

    w = wx.OpenMeteoWeather(
        fetch=lambda url, **kw: _WeatherResp(json.dumps(body))
    ).fetch(37.75991, -122.41425, 12)

    assert w["source"] == "open-meteo"
    assert w["lat"] == body["latitude"]
    # The grid point served is not the point asked for; the metre offset
    # tells the caller roughly how far off the forecast is.
    assert w["gridOffsetM"] >= 0
    assert w["now"]["at"].endswith("Z")
    assert len(w["hourly"]) == min(12, 24 - int(w["now"]["at"][11:13]))
    # The window starts at the current hour, not at 00:00.
    assert w["hourly"][0]["at"][:13] == w["now"]["at"][:13]
    assert len(w["daily"]) == 1


def test_describe_code_covers_wmo_range():
    assert wx.describe_code(0, True) == "clear"
    assert wx.describe_code(0, False) == "clear night"
    assert wx.describe_code(65) == "heavy rain"
    assert wx.describe_code(95) == "thunderstorm"
    assert wx.describe_code(96) == "thunderstorm with hail"
    assert wx.describe_code(32767) == "unknown"


def test_classify_precipitation():
    assert wx.classify_precipitation(1.0, 0, 61) == "rain"
    assert wx.classify_precipitation(0.1, 0, 51) == "drizzle"
    assert wx.classify_precipitation(0.5, 0.5, 61) == "sleet"
    assert wx.classify_precipitation(0, 0.4, 71) == "snow"
    assert wx.classify_precipitation(0.2, 0, 95) == "hail"
    assert wx.classify_precipitation(0.1, 0, 0) == "rain"
    assert wx.classify_precipitation(0, 0, 0) == "none"


def test_null_forecast_cells_become_nan_not_zero():
    # A null in a gap read as 0 invents a comfortable 0 degrees in the Sahara.
    assert math.isnan(wx.cell(None))
    assert math.isnan(wx.cell(""))
    assert wx.cell("25.5") == 25.5
    assert wx.cell_or_zero(None) == 0


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------


def test_route_instruction_prose_from_recorded_osrm():
    body = json.loads((ROOT.parent / "scripts/parity/fixtures/live/route.json").read_text())

    class _R:
        status = 200
        ok = True

        def __init__(self, text):
            self.text = text

    router = routing.OsrmRouter(
        fetch=lambda url, **kw: _R(json.dumps(body))
    )
    out = router.route(
        {"from": {"lat": 37.75991, "lon": -122.41425},
         "to": {"lat": 37.76069, "lon": -122.41286}, "mode": "walk"}
    )
    r = out["route"]
    assert r.dist == round(body["routes"][0]["distance"])
    assert out["source"] == "osrm"
    assert out["geometry"][0][0] == pytest.approx(body["routes"][0]["geometry"]["coordinates"][0][0])
    steps = r.steps
    assert steps[0].instruction == "head out"  # no road name on the fixture's depart
    turns = [s.turn for s in steps if s.turn]
    assert turns, "real OSRM steps carry street names"
    dists = [s.dist for s in steps]
    assert all(d is not None for d in dists)


def test_fork_without_road_name_is_dropped():
    router = routing.OsrmRouter()
    assert router._instruction({"distance": 10, "maneuver": {"type": "fork", "modifier": "left"}}) is None
    assert (
        router._instruction({"distance": 10, "name": "I-280", "maneuver": {"type": "fork", "modifier": "left"}})
        == "keep left onto I-280"
    )


def test_routing_falls_back_to_an_honest_straight_line():
    out = routing.straight_line_route(
        {"lat": 37.75991, "lon": -122.41425}, {"lat": 37.76069, "lon": -122.41286}, "walk"
    )
    r = out["route"]
    assert r.mode == "walk-approx"
    assert "no routing engine configured" in r.steps[0].instruction
    # 149m great-circle between those points; the flat-world number is close.
    assert 120 < r.dist < 180
    assert r.steps[0].dist == r.dist


def test_straight_line_modes_scale_speeds():
    a = {"lat": 10.0, "lon": 10.0}
    b = {"lat": 10.01, "lon": 10.0}
    walk = routing.straight_line_route(a, b, "walk")["route"]
    drive = routing.straight_line_route(a, b, "drive")["route"]
    assert drive.time < walk.time


# ---------------------------------------------------------------------------
# Heat composition
# ---------------------------------------------------------------------------


def test_density_layer_is_sparse_and_bounded():
    pts = [{"x": x * 7, "y": x * 3, "value": 1} for x in range(10)]
    layer = density_to_heat(pts, None)
    assert layer.name == "poi_density"
    assert layer.encoding == "sparse"
    assert len(layer.cells) <= 24
    assert layer.minValue >= 1
    assert layer.maxValue <= 10


def test_density_empty_is_absent():
    assert density_to_heat([], None) is None


def test_slope_flat_terrain_is_absent():
    layer = slope_to_heat([0.0] * 64, 8, 8)
    assert layer is None


def test_slope_real_terrain_is_clamped_at_20_pct():
    # clamping before ranking wiped real gradients; post-selection clamp is
    # tested here by monotonic values at 20.
    grid = [(x % 8) * 40 for x in range(64)]  # 40m steps every cell
    layer = slope_to_heat(grid, 8, 8, metres_per_unit=5)
    assert layer is not None
    assert layer.maxValue <= 20
    assert layer.cells


# ---------------------------------------------------------------------------
# Terrain
# ---------------------------------------------------------------------------


def test_decode_raw_terrarium_and_bilinear():
    import struct

    w, h = 3, 2
    # Raw values may sit below the (signed) 32768 baseline; terrarium decodes
    # to (raw - 32768) / 256 metres either way.
    samples = [32760, 32761, 32762, 32760, 32761, 32762]
    body = struct.pack("<II", w, h) + b"".join(struct.pack(">h", min(s, 32767)) for s in samples)
    grid = decode_raw_terrarium(body)
    assert grid is not None
    gw, gh, data = grid
    v0 = sample_bilinear((gw, gh, data), gw, gh, 0, 0, 2)
    v1 = sample_bilinear((gw, gh, data), gw, gh, 1, 0, 2)
    # Terrarium baseline (raw 32768) is 0m; every sample rises to the right.
    assert v1 > v0


def test_truncated_buffer_rejected():
    assert decode_raw_terrarium(b"\x00" * 7) is None


def test_tiles_for_covers_the_box_without_fanning_out():
    z, tiles = tiles_for({"west": -122.42, "south": 37.76, "east": -122.41, "north": 37.77}, 16)
    assert z >= 0
    assert 0 < len(tiles) <= 16
    # A huge box is capped, not exploded.
    _z2, tiles2 = tiles_for({"west": -130, "south": 30, "east": -110, "north": 50}, 16)
    assert len(tiles2) <= 16


# ---------------------------------------------------------------------------
# js-float helpers used across the port
# ---------------------------------------------------------------------------


def test_js_fixed_matches_wgsl_to_fixed_semantics():
    from supercarto.types import js_fixed

    assert js_fixed(0.5, 0) == "1"  # half away from zero, not half-to-even
    assert js_fixed(1.05, 1) == "1.1"
    assert js_fixed(-0.0005, 4) == "-0.0005"
    assert js_fixed(122.41425, 5) == "122.41425"


def test_format_radius_scales_over_a_kilometre():
    from supercarto.live import format_radius

    assert format_radius(300) == "300m"
    assert format_radius(999) == "999m"
    assert format_radius(1500) == "1.5km"
    assert format_radius(1000) == "1.0km"


# ---------------------------------------------------------------------------
# Overpass query form (port of test/overpass.query.test.ts)
# ---------------------------------------------------------------------------


def test_overpass_emits_positional_bbox_filter_for_negative_latitudes():
    """Regression: the public instance rejects ``bbox:`` for negative
    latitudes with 400 "bbox-query: n must be greater or equal than s"
    (measured against overpass-api.de on 2026-10-17 for Yogyakarta), while
    the positional form ``way(s,w,n,e)[tag]`` succeeds. The emitted query
    must stay positional.
    """
    import json
    from urllib.parse import unquote

    yogyakarta = {"west": 110.3739, "south": -7.775, "east": 110.3812, "north": -7.7677}
    with_way = {
        "elements": [
            {"type": "node", "id": 1, "lat": -7.771, "lon": 110.377,
             "tags": {"amenity": "cafe", "name": "Kopi"}},
            {"type": "node", "id": 2, "lat": -7.772, "lon": 110.378, "tags": {}},
            {"type": "way", "id": 10, "nodes": [1, 2],
             "tags": {"highway": "residential", "name": "Jl. Contoh"}},
        ],
    }

    bodies: list[str] = []

    class R:
        def __init__(self, payload):
            self.status = 200
            self.ok = True
            self._payload = payload
            self.headers = {"content-type": "application/json"}
            self.text = json.dumps(payload)

    def fetch(_url, body=None, **kw):
        bodies.append(unquote(str(body or "")))
        return R(with_way)

    src = ov.OverpassSource(fetch=fetch, max_attempts=1)
    res = src.fetch({"bbox": yogyakarta, "layers": [], "maxFeatures": 100})
    assert res["features"]
    assert bodies
    query = bodies[0]
    assert "bbox:" not in query
    assert (
        f"({yogyakarta['south']},{yogyakarta['west']},"
        f"{yogyakarta['north']},{yogyakarta['east']})" in query
    ), query


def test_linestring_clipping_keeps_the_in_range_stretch():
    """LineStrings clip correctly on both sides: the in-range stretch survives,
    split so the clipped feature does not still carry the corrupt vertex."""

    class R:
        status = 200
        ok = True

        def __init__(self, payload):
            self.text = json.dumps(payload)

    def do(elements):
        src = ov.OverpassSource(fetch=lambda url, **kw: R({"elements": elements}))
        return src.fetch({"bbox": {"south": 0.99, "west": 1.99, "north": 1.01, "east": 2.6},
                          "layers": ["highway"], "maxFeatures": 50000})

    line_far = [
        {"lat": 1.0, "lon": 2.0}, {"lat": 1.0, "lon": 2.5},
        {"lat": 1.0, "lon": 90.0},
    ]
    res = do([{"type": "way", "id": 10, "tags": {"highway": "residential"}, "geometry": line_far}])
    line = [list(c) for c in res["features"][0]["geometry"]["coordinates"]]
    assert line == [[2.0, 1.0], [2.5, 1.0]]


# --------------------------------------------------------------------------
# move_view: the agent moves (port of the TS `moveView: the agent moves`
# describe block).
# --------------------------------------------------------------------------


def _cafe(fid, lon, name):
    return {
        "type": "Feature",
        "id": fid,
        "properties": {"amenity": "cafe", "name": name},
        "geometry": {"type": "Point", "coordinates": [lon, 37.78]},
    }


class MovingSource:
    """A source whose features change step by step: the walk."""

    def __init__(self, steps):
        self.steps = steps
        self.i = 0

    def available(self):
        return True

    def fetch(self, request):
        features = list(self.steps[min(self.i, len(self.steps) - 1)])
        self.i += 1
        return {
            "features": features,
            "source": "moving",
            "elapsedMs": 1,
            "warnings": [],
            "truncated": False,
        }


def _stub_carto(steps):
    from supercarto.live import SuperCarto

    return SuperCarto(sources=[MovingSource(steps)], weather=False, heat=False)


def test_move_view_reports_a_walk_as_deltas_and_replaces_state():
    carto = _stub_carto([
        [_cafe(20, -122.4155, "Terminal East"), _cafe(21, -122.4045, "Terminal West")],
        [
            _cafe(20, -122.4150, "Terminal East"),  # moved ~90m east
            _cafe(21, -122.4045, "Terminal West"),  # unchanged: same cell
            _cafe(22, -122.4100, "Mezzanine Bar"),  # newcomer
        ],
    ])
    first = carto.maplet(lat=37.78, lon=-122.41, radius_m=400, layers=["poi"], budget=4096)
    assert first["scr"].startswith("SCR 1")

    move = carto.move_view(first["scr"], lat=37.78, lon=-122.41, radius_m=400,
                           layers=["poi"], budget=4096)
    assert move["counts"] == {"added": 1, "removed": 0, "updated": 1}
    assert "~ 20 Terminal East (poi) (geometry)" in move["report"]
    assert "+ 22 Mezzanine Bar (poi)" in move["report"]
    assert "- 21" not in move["report"]
    assert move["scr"].startswith("SCR 1")

    # A move reprinting the same step: nothing changed at all.
    again = carto.move_view(move["scr"], lat=37.78, lon=-122.41, radius_m=400,
                            layers=["poi"], budget=4096)
    assert again["report"] == ""


def test_move_view_refuses_to_leave_the_session_envelope():
    carto = _stub_carto([
        [_cafe(20, -122.4155, "Terminal East"), _cafe(21, -122.4045, "Terminal West")],
    ])
    first = carto.maplet(lat=37.78, lon=-122.41, radius_m=400, layers=["poi"], budget=4096)
    with pytest.raises(ValueError, match="leaves the session envelope"):
        carto.move_view(first["scr"], lat=37.9, lon=-122.41, radius_m=5000)


def test_move_view_within_a_wrap_crossing_session():
    # Same content as the TS test: a wrap-crossing session works on the east
    # side of the antimeridian, refused on the far side (quantization would
    # land on negative grid x).
    wrap = {"type": "bbox", "west": 179.5, "south": -18.15, "east": -179.5, "north": -18.1}
    step = [
        {
            "type": "Feature",
            "id": 30,
            "properties": {"amenity": "cafe", "name": "Dateline Cafe"},
            "geometry": {"type": "Point", "coordinates": [179.7, -18.12]},
        }
    ]

    from supercarto.ingest import from_geojson
    from supercarto.wire import encode_document

    first = from_geojson({"type": "FeatureCollection", "features": step}, {"envelope": wrap})
    scr = encode_document(first, {"group": False})

    carto = _stub_carto([step])
    move = carto.move_view(scr, lat=-18.12, lon=179.7, radius_m=100)
    assert move["counts"] == {"added": 0, "removed": 0, "updated": 0}
    assert move["scr"].startswith("SCR 1")

    with pytest.raises(ValueError, match="leaves the session envelope"):
        carto.move_view(scr, lat=-18.12, lon=-179.7, radius_m=30)

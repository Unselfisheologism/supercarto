"""Unit tests for the traffic flow providers (``supercarto.traffic``).

Replay fixtures through stub fetch callables; the byte-level url/shape asserts
keep the providers honest against the TS reference.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from supercarto.routing import straight_line_route
from supercarto.traffic import (
    HereFlow,
    TomTomFlow,
    TrafficRouter,
    level_for_ratio,
)

REQ = {
    "from": {"lat": 37.76, "lon": -122.41},
    "to": {"lat": 37.77, "lon": -122.4},
    "mode": "drive",
}

FREE = {
    "durationS": 600,
    "roads": ["Mission Street"],
    "geometry": [[-122.41, 37.76], [-122.4, 37.77]],
}


def _router():
    class R:
        def route(self, req):
            return straight_line_route(req["from"], req["to"], req.get("mode") or "drive")

    return R()


def _stub(url: str, body: str, ok: bool = True, status: int = 200):
    def fetch(got_url, **kw):
        assert got_url == url, f"unexpected provider url:\n  {got_url}\n  {url}"
        return SimpleNamespace(ok=ok, status=status, text=body, body=body.encode())

    return fetch


def test_level_for_ratio_thresholds():
    assert level_for_ratio(0.95) == "free"
    assert level_for_ratio(0.9) == "free"
    assert level_for_ratio(0.8) == "light"
    assert level_for_ratio(0.6) == "moderate"
    assert level_for_ratio(0.45) == "heavy"
    assert level_for_ratio(0.1) == "severe"


def test_tomtom_flow_url_and_parse():
    body = (
        '{"flows":[{"flows":[{"currentSpeed":30,"freeFlowSpeed":60,"confidence":"low",'
        '"roadName":"Mission Street"},{"currentSpeed":65,"freeFlowSpeed":60}]}]}'
    )
    fetch = _stub(
        "https://api.tomtom.com/traffic/services/flowinformation"
        "?key=KEY&points=37.76000,-122.41000;37.77000,-122.40000"
        "&unit=kmh&language=en&departureTime=now",
        body,
    )
    flow = TomTomFlow(api_key="KEY", fetch=fetch, timeout_s=4)
    got = flow.flow(REQ, FREE)
    assert got and got["source"] == "tomtom"
    a, b = got["segments"]
    # Ratio clamps a mis-tagged "faster than the limit" sample instead of
    # reporting speed above free flow.
    assert a == {
        "road": "Mission Street",
        "level": "heavy",
        "speedKmh": 30,
        "freeFlowKmh": 60,
        "ratio": 0.5,
        "stale": True,
    }
    assert b["level"] == "free" and b["ratio"] == 1


def test_tomtom_flow_requires_key():
    flow = TomTomFlow(api_key=None, fetch=lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("network call without a key")
    ))
    # strip ambient credentials the environment may carry in this sandbox
    import os

    saved = {k: os.environ.pop(k) for k in ("TOMTOM_API_KEY", "TRAFFIC_API_KEY") if k in os.environ}
    try:
        assert not flow.configured()
        assert flow.flow(REQ, FREE) is None
    finally:
        os.environ.update(saved)


def test_tomtom_flow_degrades_to_none_on_http_error():
    flow = TomTomFlow(api_key="KEY", fetch=_stub("x", "boom", ok=False, status=500))
    # the url shape only matters for the success path; a miss returns None
    got = flow.flow(REQ, FREE)
    assert got is None


def test_tomtom_flow_degrades_to_none_on_bad_json():
    flow = TomTomFlow(api_key="KEY", fetch=lambda url, **kw: SimpleNamespace(
        ok=True, status=200, text="not json", body=b"not json"
    ))
    assert flow.flow(REQ, FREE) is None


def test_here_flow_reverses_pairs_and_skips_unknown_ratios():
    body = (
        '{"currentFlow":['
        '{"location":{"roadName":"Oak Street","currentSpeed":20,"freeFlowSpeed":80}},'
        '{"location":{"currentSpeed":10}},'
        '{"confidence":"low","location":{"roadName":"5th Street","currentSpeed":0,"freeFlowSpeed":50}}'
        "]}"
    )
    fetch = _stub(
        "https://traffic.ls.hereapi.com/traffic/v2/flow?apiKey=HKEY"
        "&points=-122.41000;37.76000|-122.40000;37.77000&return=summary,polyline",
        body,
    )
    flow = HereFlow(api_key="HKEY", fetch=fetch)
    got = flow.flow(REQ, FREE)
    assert got and got["source"] == "here"
    a, c = got["segments"]
    assert a["road"] == "Oak Street" and a["level"] == "severe" and a["ratio"] == 0.25
    # the ratio-less middle entry is skipped entirely
    assert c["road"] == "5th Street" and c["stale"] is True


def test_router_uses_provider_and_scales_duration():
    body = (
        '{"flows":[{"flows":[{"currentSpeed":30,"freeFlowSpeed":60},'
        '{"currentSpeed":45,"freeFlowSpeed":60}]}]}'
    )
    fetch = _stub(
        "https://api.tomtom.com/traffic/services/flowinformation?key=K"
        "&points=37.76000,-122.41000;37.77000,-122.40000"
        "&unit=kmh&language=en&departureTime=now",
        body,
    )
    tom = TomTomFlow(api_key="K", fetch=fetch)
    # mean ratio (0.5 + 0.75) / 2 = 0.625 -> moderate; delay scales free flow.
    # Worst segment is the stronger congestion, the heavy 0.5 sample.
    got = TrafficRouter(_router(), [tom]).route(REQ)
    assert got["source"] == "tomtom" and got["freeFlowOnly"] is False
    assert got["level"] == "moderate"
    assert got["worstLevel"] == "heavy"
    assert got["freeFlowS"] == got["durationS"] - got["delayS"]


def test_router_falls_back_and_labels_when_no_provider():
    got = TrafficRouter(_router(), []).route(REQ)
    assert got["freeFlowOnly"] is True
    assert got["source"] == "none"
    assert got["delayS"] == 0
    assert "TOMTOM_API_KEY" in got["unavailable"]


def test_router_honours_has_flow_gate():
    assert TrafficRouter(_router(), []).has_flow is False
    assert TrafficRouter(_router(), [TomTomFlow(api_key="")]).has_flow is False
    assert TrafficRouter(_router(), [TomTomFlow(api_key="K")]).has_flow is True


def test_waypoints_dedupe_and_thin():
    from supercarto.traffic import _waypoints

    geometry = [[-122.41, 37.76], [-122.41, 37.76], [-122.4, 37.77]]
    pts = _waypoints(geometry, REQ)
    assert pts[0] == "37.76000,-122.41000"
    assert pts[-1] == "37.77000,-122.40000"
    # consecutive duplicates collapse
    assert len(pts) == len(set(range(len(pts)))) and pts[1] != pts[0]

    # large geometry is strided to roughly the cap
    big = [[-122.4 + i * 1e-5, 37.7] for i in range(500)]
    assert len(_waypoints(big, REQ)) <= 107

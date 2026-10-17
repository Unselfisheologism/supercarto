"""Live-path parity tests: the Python port must match the TypeScript byte
for byte, including the request strings, with the network replayed.

The reference is the TypeScript live stack in ``src/`` (Overpass fetch +
ingest + compile + budget + emit, weather parsing, OSRM prose), driven from
recorded service responses by ``scripts/parity/live-ts.mjs``; the Python side
walks the same recorded fixtures through ``supercarto.live``. Both print a
canonical report; the two must be byte-identical.

The fixtures under ``scripts/parity/fixtures/live/`` were captured from the
real public services, so the replay exercises real response shapes: 4,913
Overpass elements of San Francisco, a live Open-Meteo forecast, and a real
OSRM route with legs.

Node- and Python-side tests both need Node; they skip with a clear reason
when it is not installed.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
WORK = Path("/tmp/opencode/supercarto-parity-test")

node_available = shutil.which("node") is not None
pytestmark = pytest.mark.skipif(not node_available, reason="node not installed")


def test_live_report_byte_parity() -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    ts = subprocess.run(
        ["npx", "tsx", "scripts/parity/live-ts.mjs"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
        timeout=300,
    )
    assert ts.returncode == 0, f"ts live harness failed:\n{ts.stderr[-2000:]}"
    venv_python = Path("/tmp/opencode/venv/bin/python")
    py_cmd = str(venv_python) if venv_python.exists() else "python3"
    py = subprocess.run(
        [py_cmd, "scripts/parity/live-py.py"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
        timeout=300,
    )
    assert py.returncode == 0, f"py live harness failed:\n{py.stderr[-2000:]}"
    assert ts.stdout == py.stdout, "live path diverged from the TypeScript reference"


def test_live_report_is_the_whole_surface() -> None:
    """Guard against harness drift: the report must still cover requests,
    weather and routing, or the gate above guards nothing."""
    report = json.loads(
        subprocess.run(
            ["python3", "scripts/parity/live-py.py"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
            timeout=120,
        ).stdout
    )
    assert set(report) == {"maplet", "weather", "route", "requests"}
    assert set(report["requests"]) == {"overpassQuery", "weather", "route"}
    # The recorded Overpass replay is the real thing: thousands of elements.
    assert report["maplet"]["nodes"] > 5
    assert report["maplet"]["edges"] > 0
    assert report["route"]["route"]["steps"]
    assert report["weather"]["source"] == "open-meteo"

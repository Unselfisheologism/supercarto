"""Parity tests: the Python-native compiler must emit byte-identical YAML.

The reference is the TypeScript compiler in ``src/``, run through
``scripts/parity/ts.mjs`` with fixed options (a pinned instant and UTC offset,
so time-dependent metadata is reproducible). Every fixture is compiled at
several budgets on both sides and the YAML must diff clean.

These tests need Node (the reference side) and skip with a clear reason when
it is not installed; the Python side alone still runs everywhere.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PARITY = ROOT / "scripts" / "parity"
WORK = Path("/tmp/opencode/supercarto-parity-test")

#: Pinned so sun position and opening hours are reproducible.
PINNED_OPTS = {"compile": {"now": "2026-10-01T12:00:00Z", "utcOffsetMinutes": -420}}

#: (fixture, budgets) pairs. Fixtures live in examples/; the kitchen-sink one
#: exists to exercise hours, heat, blocked paths, crosswalks and furniture
#: filtering, which the city fixtures only cover incidentally.
CASES = [
    ("examples/sf-mission-5th.geojson", [128, 1024, 4096]),
    ("examples/synthetic-dense.geojson", [128, 512, 2048]),
    ("scripts/parity/fixtures/parity-kitchen-sink.geojson", [256, 1024]),
    # Layer filtering and caller envelopes exercise filter_layers and the
    # dict-shaped envelope path that arrives straight from a request.
    (
        "examples/sf-mission-5th.geojson",
        [
            {
                "budget": 900,
                "layers": ["building", "poi"],
                "bbox": {"west": -122.42, "south": 37.76, "east": -122.40, "north": 37.78},
            }
        ],
    ),
]

node_available = shutil.which("node") is not None

pytestmark = pytest.mark.skipif(not node_available, reason="node not installed")


def _ensure_typescript_build() -> None:
    """The reference compiler ships compiled to ``dist/``.

    A fresh checkout (a CI runner, a new clone) has no ``dist``, and building
    it is not the Python package's job to remember — so the parity tests build
    it themselves rather than failing with ``Cannot find module dist/index.js``
    three parameters in. Idempotent: an existing ``dist`` is left alone, so
    local reruns stay fast.
    """
    if not node_available or (ROOT / "dist" / "index.js").exists():
        return
    if not (ROOT / "node_modules").exists():
        proc = subprocess.run(
            ["npm", "ci"], cwd=ROOT, capture_output=True, text=True, timeout=600
        )
        assert proc.returncode == 0, f"npm ci failed:\n{proc.stderr[-2000:]}"
    proc = subprocess.run(
        ["npm", "run", "build"], cwd=ROOT, capture_output=True, text=True, timeout=600
    )
    assert proc.returncode == 0, f"npm run build failed:\n{proc.stderr[-2000:]}"


_ensure_typescript_build()


def _run(cmd: list[str], opts: dict) -> dict:
    proc = subprocess.run(
        cmd,
        check=False,
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert proc.returncode == 0, f"{cmd[0]} failed:\n{proc.stderr[-2000:]}"
    return json.loads(proc.stderr.strip().splitlines()[-1])


@pytest.mark.parametrize(
    "fixture,spec",
    [(f, s) for f, bs in CASES for s in bs],
    ids=[
        f"{Path(f).stem}-{s['budget'] if isinstance(s, dict) else s}"
        for f, bs in CASES
        for s in bs
    ],
)
def test_yaml_parity(fixture: str, spec) -> None:
    if isinstance(spec, int):
        budget = spec
        opts = {"budget": budget, **PINNED_OPTS}
    else:
        opts = {**spec, "compile": {**PINNED_OPTS["compile"], **spec.get("compile", {})}}
        budget = opts["budget"]

    opts_json = json.dumps(opts)
    WORK.mkdir(parents=True, exist_ok=True)
    tag = f"{Path(fixture).stem}-{budget}"

    ts_metrics = _run(
        ["node", "scripts/parity/ts.mjs", fixture, str(WORK / f"{tag}.ts.yaml"), opts_json],
        opts,
    )
    py_metrics = _run(
        [sys.executable, "scripts/parity/py.py", fixture, str(WORK / f"{tag}.py.yaml"), opts_json],
        opts,
    )

    ts_yaml = (WORK / f"{tag}.ts.yaml").read_text()
    py_yaml = (WORK / f"{tag}.py.yaml").read_text()

    assert ts_metrics["nodes"] == py_metrics["nodes"], (
        f"node count differs: ts={ts_metrics} py={py_metrics}"
    )
    assert ts_metrics["edges"] == py_metrics["edges"], (
        f"edge count differs: ts={ts_metrics} py={py_metrics}"
    )
    if ts_yaml != py_yaml:
        ts_lines, py_lines = ts_yaml.splitlines(), py_yaml.splitlines()
        first = next(
            (i for i, (a, b) in enumerate(zip(ts_lines, py_lines)) if a != b),
            min(len(ts_lines), len(py_lines)),
        )
        ctx_ts = "\n".join(ts_lines[max(0, first - 2) : first + 3])
        ctx_py = "\n".join(py_lines[max(0, first - 2) : first + 3])
        pytest.fail(f"YAML diverges at line {first + 1}:\nts: {ctx_ts}\npy: {ctx_py}")

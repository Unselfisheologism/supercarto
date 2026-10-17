"""Parity harness, Python side — the mirror of ``scripts/parity/ts.mjs``.

Runs the Python-native compiler on the same GeoJSON fixture with the same
fixed options and writes the emitted YAML. ``bash scripts/parity/check.sh``
diffs the two outputs; a first diff is expected while a stage is mid-port.
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python" / "src"))

from supercarto.pipeline import to_maplet  # noqa: E402

input_path, output_path = sys.argv[1], sys.argv[2]
opts = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}

req = dict(opts)
compile_opts = dict(opts.get("compile") or {})
if "now" in compile_opts:
    compile_opts["now"] = datetime.fromisoformat(
        compile_opts["now"].replace("Z", "+00:00")
    ).astimezone(timezone.utc)
req["compile"] = compile_opts

data = json.loads(Path(input_path).read_text(encoding="utf-8"))
m = to_maplet(data, req)
Path(output_path).write_text(m["yaml"], encoding="utf-8")
print(
    json.dumps(
        {
            "tokens": m["metrics"]["tokens"],
            "nodes": m["metrics"]["nodes"],
            "edges": m["metrics"]["edges"],
            "dropped": m["metrics"]["droppedNodes"],
        }
    ),
    file=sys.stderr,
)

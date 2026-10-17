#!/usr/bin/env python3
"""SCR codec parity harness, Python side — the mirror of ``scr-ts.mjs``.

Compiles the same fixture with the same options, writes the Python encoder's
output for the post-filter document, and verifies decode->re-encode is a fixed
point. The file must come out byte-identical to the TypeScript one.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python" / "src"))

from supercarto.pipeline import to_maplet  # noqa: E402
from supercarto.wire import decode_document, encode_document  # noqa: E402

input_path, output, opts_json = sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "{}"
data = json.loads(Path(input_path).read_text(encoding="utf-8"))
opts = json.loads(opts_json)

req = dict(opts)
compile_opts = dict(opts.get("compile") or {})
if compile_opts.get("now"):
    from datetime import datetime, timezone

    compile_opts["now"] = datetime.fromisoformat(
        str(compile_opts["now"]).replace("Z", "+00:00")
    ).astimezone(timezone.utc)
    req["compile"] = compile_opts
req["budgetOpts"] = opts.get("budgetOpts")

m = to_maplet(data, req)
Path(output).write_text(m["scr"], encoding="utf-8", newline="")

round_ = encode_document(decode_document(m["scr"]), {"group": False})
print(
    json.dumps({"wireBytes": m["metrics"]["wireBytes"], "roundtrip": round_ == m["scr"]}),
    file=sys.stderr,
)

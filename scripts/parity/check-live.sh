#!/usr/bin/env bash
# Parity gate for the live path: run the TypeScript live stack and the Python
# port against the same recorded service responses, diff the canonical report.
#
# The report covers the whole live surface: maplet YAML + metrics, weather
# parsing, route prose, and the exact request strings each side builds
# (Overpass QL, weather URL, OSRM URL).
#
# Fixtures under scripts/parity/fixtures/live/ were captured from the real
# services (Overpass, Open-Meteo, OSRM); the harnesses replay them, so this
# gate never touches the network.
#
#   bash scripts/parity/check-live.sh

set -u

cd "$(dirname "$0")/../.."
work=/tmp/opencode/supercarto-parity
mkdir -p "$work"

npx tsx scripts/parity/live-ts.mjs >"$work/live.ts.json" 2>"$work/live.ts.err" || {
  echo "ts live harness failed:"; head -c 2000 "$work/live.ts.err"; exit 1; }
python3 scripts/parity/live-py.py >"$work/live.py.json" 2>"$work/live.py.err" || {
  echo "py live harness failed:"; head -c 2000 "$work/live.py.err"; exit 1; }

if cmp -s "$work/live.ts.json" "$work/live.py.json"; then
  python3 -c "
import json
r = json.load(open('$work/live.ts.json'))
m = r['maplet']
print(f'PASS live (maplet {m[\"tokens\"]} tokens, {m[\"nodes\"]} nodes, {m[\"edges\"]} edges; route {len(r[\"route\"][\"route\"][\"steps\"])} steps; weather code {r[\"weather\"][\"now\"][\"code\"]})')"
  exit 0
else
  echo "FAIL live"
  diff <(python3 -m json.tool "$work/live.ts.json") <(python3 -m json.tool "$work/live.py.json") | head -40
  exit 1
fi

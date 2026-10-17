#!/usr/bin/env bash
# Parity gate for the Python-native port: run the TypeScript compiler and the
# Python port on the same fixture with the same fixed options, diff the YAML.
#
#   bash scripts/parity/check.sh                # all fixtures, all budgets
#   bash scripts/parity/check.sh my.city.geojson 2048
#
# Exit status 0 means byte-identical output on every case. A run that reports
# "skipped (unported feature)" is not parity — it means the fixture used a
# milestone-2 feature and the Python result cannot be compared yet.

set -u

cd "$(dirname "$0")/../.."
work=/tmp/opencode/supercarto-parity
mkdir -p "$work"

OPTS_BASE='{"compile":{"now":"2026-10-01T12:00:00Z","utcOffsetMinutes":-420}}'
fail=0

run_case() { # file budget opts
  local file="$1" budget="$2" opts="$3"
  local name
  name="$(basename "$file" .geojson)-${budget}"
  node scripts/parity/ts.mjs "$file" "$work/${name}.ts.yaml" "$opts" 2>"$work/${name}.ts.json" || {
    echo "ts failed: $name"; fail=1; return; }
  python3 scripts/parity/py.py "$file" "$work/${name}.py.yaml" "$opts" 2>"$work/${name}.py.json" || {
    echo "py failed: $name"; fail=1; return; }
  if diff -q "$work/${name}.ts.yaml" "$work/${name}.py.yaml" >/dev/null; then
    echo "PASS $name ($(python3 -c "import json,sys;print(json.load(open('$work/${name}.ts.json'))['tokens'])") tokens)"
  else
    echo "FAIL $name"
    echo "  ts: $(grep -o '"tokens":[0-9]*' "$work/${name}.ts.json" || head -c 120 "$work/${name}.ts.json")"
    echo "  py: $(grep -o '"tokens":[0-9]*' "$work/${name}.py.json" || head -c 120 "$work/${name}.py.json")"
    echo "  first diff:"
    diff "$work/${name}.ts.yaml" "$work/${name}.py.yaml" | head -8 | sed 's/^/    /'
    fail=1
  fi
}

if [ $# -ge 1 ]; then
  files="$1"; budgets="${2:-1024}"
else
  files=$(ls examples/*.geojson); budgets="1024 2048"
fi

for f in $files; do
  for b in $budgets; do
    run_case "$f" "$b" "{\"budget\":$b,\"compile\":{\"now\":\"2026-10-01T12:00:00Z\",\"utcOffsetMinutes\":-420}}"
  done
done
exit $fail

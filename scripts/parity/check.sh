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
  # SCR codec gate: the post-filter document encoded by both sides, byte for
  # byte. Runs once per fixture (budget shapes features, and scr encodes the
  # doc before compilation, so both budgets exercise the shrink path).
  local scr_ok=1
  npx tsx scripts/parity/scr-ts.mjs "$file" "$work/${name}.ts.scr" "$opts" 2>/dev/null || scr_ok=0
  python3 scripts/parity/scr-py.py "$file" "$work/${name}.py.scr" "$opts" >/dev/null 2>&1 || scr_ok=0
  if [ $scr_ok -eq 1 ]; then
    cmp -s "$work/${name}.ts.scr" "$work/${name}.py.scr" || scr_ok=0
  fi
  [ $scr_ok -eq 0 ] && { echo "FAIL $name (scr)"; fail=1; }
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
  files=$(ls examples/*.geojson scripts/parity/fixtures/*.geojson); budgets="128 256 512 1024 2048"
fi

# Run the TS side against a build no older than the sources. A stale dist
# reported parity that the checked-in code no longer had.
if [ dist/index.js -ot src/pipeline.ts ]; then
  echo "(rebuilding stale dist first)"
  npm run build >/dev/null 2>&1 || { echo "FAIL dist build"; exit 1; }
fi

for f in $files; do
  for b in $budgets; do
    run_case "$f" "$b" "{\"budget\":$b,\"compile\":{\"now\":\"2026-10-01T12:00:00Z\",\"utcOffsetMinutes\":-420}}"
  done
done

# PMTiles/MVT reader gate: both sides build the same spec-written archive,
# fetch through their own reader, and compile the result. The canonical JSON
# reports must be byte-identical.
pt_ok=1
npx tsx scripts/parity/pmtiles-ts.mjs "$work/pmtiles.ts.json" 2>"$work/pmtiles.ts.err" || pt_ok=0
python3 scripts/parity/pmtiles-py.py "$work/pmtiles.py.json" 2>"$work/pmtiles.py.err" || pt_ok=0
if [ $pt_ok -eq 1 ] && cmp -s "$work/pmtiles.ts.json" "$work/pmtiles.py.json"; then
  echo "PASS pmtiles (spec archive: header, directory, mvt, features, yaml)"
else
  echo "FAIL pmtiles"
  diff <(python3 -c "print(open('$work/pmtiles.ts.json').read()[:400])") \
       <(python3 -c "print(open('$work/pmtiles.py.json').read()[:400])") 2>/dev/null | head -6 | sed 's/^/    /'
  fail=1
fi

# State-diff gate: both sides ingest the same two views under one envelope,
# diff them by wire feature id, and render the + / - / ~ report. Canonical
# JSON reports must be byte-identical.
df_ok=1
node scripts/parity/diff-ts.mjs >"$work/diff.ts.json" 2>"$work/diff.ts.err" || df_ok=0
python3 scripts/parity/diff-py.py >"$work/diff.py.json" 2>"$work/diff.py.err" || df_ok=0
if [ $df_ok -eq 1 ] && cmp -s "$work/diff.ts.json" "$work/diff.py.json"; then
  echo "PASS diff (+/-/-/~ engine: move, rename, tag, enter, leave)"
else
  echo "FAIL diff"
  diff "$work/diff.ts.json" "$work/diff.py.json" 2>/dev/null | head -6 | sed 's/^/    /'
  fail=1
fi
exit $fail

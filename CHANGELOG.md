# Changelog

## Unreleased — Python-native live sources (milestone 2a)

The pip package can now **fetch and compile any location on earth without
Node**: Overpass (OSM data), Open-Meteo (weather) and OSRM (turn-by-turn
routing) are ported over `urllib`, keeping the package at zero runtime
dependencies. All under the same byte-parity gate as milestone 1.

- New `python/src/supercarto/` modules, ports of `src/source/*.ts` and
  `src/live.ts`: `net.py` (a zero-dependency `urllib` fetch shaped like the
  WHATWG API), `overpass.py` (query builder, element→GeoJSON conversion,
  retry with layer-dropping / box-shrinking / best-result retention,
  implausible-coordinate rejection), `weather.py` (Open-Meteo with null-safe
  cells, WMO code prose, NaN "unknown" degradation), `routing.py` (OSRM with
  maneuver→sentence prose and the labelled `*-approx` fallback),
  `heat.py` (poi density + slope layers), `terrain.py` (Terrarium elevation
  tiles, raw decoding + bilinear sampling), and `live.py` (the `SuperCarto`
  orchestration: document cache with TTL/eviction, heat derivation,
  capability-driven tool advertisement, landmark starvation safety net).
- `supercarto.live.SuperCarto` is synchronous (no event loop — `urllib`
  under the hood) and shares the module namespace with the stdio client's
  `SuperCarto`, so the native one is imported as `from supercarto.live
  import SuperCarto`.
- `toMaplet` accepts a prebuilt document (`req.doc`) so live-attached heat
  layers survive compilation, plus a top-level `capabilities` override —
  both mirroring the TypeScript pipeline.
- Parity gate extended to the live path: `scripts/parity/live-ts.mjs` /
  `live-py.py` / `check-live.sh` replay recorded service responses through
  both stacks and require byte-identical canonical reports — maplet YAML +
  metrics, weather parsing, route prose, and the exact request strings each
  side builds (Overpass QL, weather URL, OSRM URL). Fixtures captured from
  the real public services in `scripts/parity/fixtures/live/`.
- Deferred to still later milestones: SCR wire codec, indoor floors,
  PMTiles/MVT, and the TomTom/HERE traffic flow providers (requiring paid
  credentials; `route_with_traffic` reports free-flow labelled
  `freeFlowOnly`, identical to the TS class with no key configured).
- Port notes worth keeping: Overpass `normalizeLayers`/`buildQuery` are
  string-identical; `clipGeometry` matches vertices by object reference on
  the TS side (so polygons needing any clip come back with an empty ring and
  are dropped downstream) — reproduced faithfully in Python (identity, not
  value, equality) for byte parity, marked as a milestone-3 revisit when the
  reference is fixed.

## 0.4.11

Bug fixes:

- Live Overpass fetch now works for negative latitudes: supercarto emits the
  positional `(s,w,n,e)` bbox form instead of the `bbox:`-prefixed form, which
  the public Overpass instance rejects with HTTP 400 for negative-latitude
  boxes. Includes a regression test.
- Connectivity fixes for token-budgeted map graphs (PR #1,
  fix-connected-budget).

## Unreleased — Python-native core (milestone 1)

The pip package gets a **pure-Python compile core**: GeoJSON in,
token-budgeted topological YAML out, no Node involved. Milestone 1 of the
port; enforced by byte-level output parity against the TypeScript compiler.

- `python/src/supercarto/`: ported in dependency order with parity as the
  gate — wire model (`types.py`), projection + tile envelopes
  (`project.py`), grid geometry (Visvalingam-Whyatt with the TS heap ported
  verbatim so simplification tie-breaks match), per-axis grid scale,
  GeoJSON ingest (OSM classification, attribute sets, token semantics),
  the topology compiler, the opening-hours grammar, solar position (NOAA
  approximation), tool catalogue, token budget (rank, cut-vertex
  protection, chain contraction, batch shrink with stall handling), YAML
  emission, and the `toMaplet` pipeline with real-output budget
  verification.
- `to_maplet()` / `compile_file()` / `compile_maplet()` public API; both
  data and file inputs. JSON-string input accepted.
- Parity harness `scripts/parity/` (ts.mjs / py.py / check.sh / debug-py.py)
  and `python/tests/test_parity.py`: identical options pinned to a fixed
  instant and UTC offset; YAML must diff clean across budgets, layer
  filters, bbox and tile envelopes.
- Deferred to milestone 2, tracked in the port decision record: the SCR
  wire codec (the `doc`/`scr` result fields exist in memory, not yet on the
  wire), indoor floors (`python/src/supercarto/indoor.py` is an
  empty-graph bridge), PMTiles/MVT, and network sources.
- Port notes worth keeping: JS `Math.round` ties-up semantics preserved
  (`js_round`), string lengths counted in UTF-16 units for the token
  estimator, and the budgeter's cut-vertex rule ports faithfully — its
  read-before-update `parentLow` makes the result DFS-order-dependent, so
  the Python adjacency iterates in the same insertion order as the
  TypeScript's `Set`.
- Fixed en route (pre-existing, surfaced by lint): `client._await_response`
  referenced an out-of-scope `method`, which raised `NameError` instead of
  `ConnectionError` when the server replied with an error frame.

## 0.4.9

Tool-surface additions the benchmark repo needs (no behavior changes to
existing APIs):

- `src/diff/`: `diffDocuments` + `renderDiff` (benefit #5 implementation).
- Ingest `heat` member on feature collections (benefit #3 fixture support).
- `GraphNode.layer`: names the layer instead of generic feature labels.

Releases are cut from `master`. Benchmark-affecting changes are listed under
each release because a score is meaningless without the harness version that
produced it; every run archive records its commit hash for the same reason.

## Unreleased

- State-diff track, phases 1–2: `src/diff/` library, single-turn
  `synthetic-diff/diff` task. Multi-turn accumulation parked by design
  decision (agent harness's job, not the tool's).
- Heat track: ingest `heat` member, `synthetic-heat/heat` task.
- Expansion track, reformulated from containment (guessable) to footprint
  area (unguessable).
- Isolation: subjects run with a clean config home; tool detection matches
  `tool_use` events and nested MCP calls (voiding was inert before).
- Codenames retired from default models (`space-bunny`, `cat-jam`).
- Paperwork: `fixtures/bench/ATTRIBUTION.md` (ODbL answer),
  `croissant.json`, canary strings in all fixtures.

## 0.4.8

- Benchmark core per the SOP work list: frozen fixture truth, safe resume
  with prompt-hash guard, real call cap, run metadata, committed raw
  archives, 13-section datasheet with related work.
- Measured results (both official free models): omission/nearest/
  connectivity 9/9 supercarto vs ~4/9 geojson vs 0/9 none on the synthetic
  area; route/turn-by-turn unmeasurable (reference router returns impossible
  distances).

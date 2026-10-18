# Changelog

## Unreleased — landmark recall and pruning cost (issue #3)

Fixes the budgeter regression the benchmark surfaced in 0.4.11; report at
<https://github.com/Unselfisheologism/supercarto/issues/3>. At low budgets
the connected-first pruning exhausted its anonymous street supply and fell
through to named landmarks — sf-cbd at budget 1024 named 3 places where
0.4.9 named 10 — and dense extracts paid for per-removal articulation
recomputes with tens of seconds of compile time.

- **Names are the last resort, not the pressure valve** (`budget.ts` /
  `budget.py`): the selection walk takes anonymous candidates first and a
  named node only above its floor; cut vertices join the candidate pool
  only after connected pruning is proven unable to reach the budget plus
  overhead. The batch validator (`applyRemovalsValidated`) never strands a
  landmark: a batch that would leave a name with no road either couples the
  landmark to its last access (one removal: name and dead end go together),
  or withdraws the culprit so the access survives.
- **Connectivity stays where it is affordable**: no pre-batch component is
  ever split while the fragmentation valve is shut. The valve is validated
  per batch — one component-count pass, plus a bisected rollback when a
  batch refuses — replacing the per-removal Tarjan. Synthetic-dense at
  budget 8192 stays a single component; synthetic-dense at 512-4096 and
  sf-cbd at 1024 fragment only to save names. sf-cbd, budget 1024: 10
  named places, 986 tokens.
- **Compiles faster for it**: sf-cbd 5.3s → 3.6s; synthetic-pacific (4,570
  features) 43.5s → 13.6s.
- **Tests**: `test/connectivity.test.ts` (+ `python/tests/test_connectivity.py`)
  re-express the tiered promise — no stranding, no cross-merging, mirrored
  edges — plus a canary that full connectivity holds exactly where it is
  affordable. Parity gate byte-identical on all fixtures, including the
  bench set (sf-cbd 512/1024/4096, synthetic-pacific 512/1024/4096).

## Unreleased — milestone 4: the agent moves (session views)

The planning doc's differentiator #5 — a moving agent that keeps a persistent
spatial memory without re-paying tokens for what it already knows — is now a
product on both sides:

- **Diff engine ported** (`python/src/supercarto/diff.py`): the `+/−/~`
  engine was TypeScript-only before. The port compares by wire feature id
  (stable because ingest prefers the source's own id), resolves layer/class/
  attributes by name and content, and compares geometry exactly on grid
  integers. Gated by a new `diff` step in `scripts/parity/check.sh` —
  canonical change lists and rendered diff text must be byte-identical.
- **Session views** (`src/session/session.ts` /
  `python/src/supercarto/session.py`): `moveMaplet(scr, features, opts)` takes
  the agent's current map (an SCR string), re-ingests the new view's features
  under the *session's* envelope so quantization never drifts, and returns
  only the delta plus the replaced compact state. The LLM context pays for
  the diff; the harness keeps the SCR in its own RAM.
- **The `localize` tool** (`src/server/mcp.ts`, `toolcatalog.ts` /
  `toolcatalog.py`): MCP surface for the same engine, with the catalogue
  invariant updated on both sides. `get_maplet` gained `returnScr` so a
  harness can seed a session; `localize` returns the diff as its first
  content block and the updated state as the second — the caller's memory
  slot, not another read for the model.
- **Live wiring** (`src/live.ts`): `SuperCarto.moveView` fetches the new
  view and refuses moves that leave the session envelope with an instruction
  to open a new session, rather than serving a diff that a foreign grid would
  make a lie.
- Python stdio client gained `localize`, and the package re-exports the
  diff engine (`diff_documents`, `render_diff`, `FeatureChange`) and session
  core (`move_maplet`, `session_doc`).

## Unreleased — milestone 3: clipped polygons survive

`clipGeometry` used to match vertices by object reference, while the vertex
lists it matched against were fresh copies — so every polygon that passed
through the Overpass clip step came back with an empty ring (clipped or not)
and was dropped downstream as "not a real area". Both sides are fixed
together, so byte parity holds:

- `src/source/overpass.ts` / `python/src/supercarto/overpass.py`: vertex
  matching in the clip step is now by value. A clipped polygon whose
  surviving ring still closes is kept with its in-range vertices; a clipped
  line keeps its in-range stretch; a multi-line keeps its longest surviving
  run by mapped length (the Python port had mapped the hold/whole-line
  distinction itself wrong, which the identity bug had masked — longest run
  selection now also maps each run).
- New regression tests on both sides pin all three outcomes: intact ring,
  closed-after-clip ring, and ring broken by a corrupt closing vertex (the
  dirty ring stops being an area at classification time, so the way is a
  line of surviving vertices).
- Still deferred, unchanged since milestone 1: the greedy `(dist|ref|turn)`
  wire kv regex and its lossy `turn="19th"` roundtrip stay aligned with the
  reference until the reference changes.

## Unreleased — back-port of the 0.4.11 reference fixes

The TypeScript reference gained two fixes (PR #1, 0.4.11) that change byte
output; the Python port follows them and the parity gate stays green:

- **Real mirror edges in the compiler** (`compiler.py`): the reverse of every
  bidirectional line now swaps endpoints and negates its axis deltas instead
  of duplicating the forward edge with a reversed `dir` label. This changes
  every compiled graph, so all parity fixtures were re-gated.
- **Correctness fixes in the budgeter** (`budget.py`, `pipeline.py`,
  `emit.py`, `graph.py`): best-first ranking before the worst-first prune
  walk, per-removal live articulation recompute so a batch cannot split a
  cycle, the root-child-count rule and Tarjan's proper cut test in
  `articulation_points`, chain contraction that fails closed (an
  uncontractable candidate is skipped, not the whole pass), path-length
  (`inLeg.dist + outLeg.dist`) and per-leg `segments` preservation with
  compass-of-displacement bearings, plus the same contraction and live cut
  recompute in the pipeline's real-output verify loop.
- Edge gains an optional `segments` field (`graph.py`) and the emitter sums
  leg-wise metres over it (`emit.py`), matching `yaml.ts`.
- `test_connectivity.py` (12 tests) and the Overpass positional-bbox
  regression test are ports of the reference's new tests.

## Unreleased — full milestone 2: SCR wire codec, indoor floors, traffic, PMTiles/MVT

Completes the live-source milestone: every `src/source/*.ts` provider, the SCR
wire codec and indoor floors are now native Python, all under the same
byte-parity gate. Zero runtime dependencies throughout (gzip via `zlib`, zstd
via the Python 3.14 stdlib `compression.zstd`, MVT via hand-rolled protobuf
varint parsing).

- **SCR wire codec** (`wire.py`, a full port of `src/wire/{geometry,encode,
  decode}.ts`): separators, delta paths and the ≥4-vertex smart threshold,
  rings/polygons with signed areas, the three heat encodings, properties and
  attr values, and `encode_document`/`decode_document` (5,000,000-feature cap,
  header/envelope/Q required). `pipeline.to_maplet` now carries the real `scr`
  and `wireBytes`/`wireTokens` fields (tokens are the ceil of bytes/4),
  `from_scr()` round-trips documents, and `live.SuperCarto.scr()` encodes the
  live-compiled document exactly like the Node server.
- **Indoor floors** (`indoor.py`, `compiler.py`, a port of `src/compile/
  indoor.ts` + the `compileIndoor` hook): `indoor=*`/`level=*` features become
  per-floor room graphs gated by a named-corridor requirement, shafts
  (`lift`/`stairs`) collapse into `VerticalLink`s keyed by a shared 32-unit
  grid cell, level names (`ground`, `mezzanine`-style tables, fractional
  `2.5` storeys) parse with the JS `Number()` semantics, and skipped storeys
  land in the omission ledger with their reason. Distances are metres via an
  envelope-calibrated `metresPerUnit`.
- **Traffic flow providers** (`traffic.py`, a port of `src/source/traffic.ts`):
  `TomTomFlow` and `HereFlow` with the same level-of-service thresholds and
  congestion-scaled ETA arithmetic (`TrafficRouter`, `level_for_ratio`),
  credentials from `TOMTOM_API_KEY`/`TRAFFIC_API_KEY`/`HERE_API_KEY`, and
  `live.SuperCarto(sources=..., tomTom={...}, here={...})` wiring — the
  no-credential fallback stays the labelled free-flow result, and `has_flow`
  gates tool advertisement.
- **PMTiles + MVT** (`protomaps.py`, `mvt.py`, ports of `src/source/
  protomaps.ts` + `mvt.ts`): a PMTiles v3 reader (magic-checked 127-byte
  header, column-major directory decode with the zero-offset contiguity
  marker, leaf-aware cache, local-file and HTTP-range fetch), Hilbert-curve
  TileIDs pinned to spec 4.1's worked table, and a minimal MVT 2.1 decoder
  (column-major layers, tag tables resolved after the wire, multi-point
  MoveTo kept in one part). `ProtomapsSource` fits the `MapSource` contract
  with per-zoom capping, per-feature dedup across tiles, and per-layer
  filtering, and its features compile like any other GeoJSON.
- Parity gates extended: `scr-ts.mjs`/`scr-py.py` round-trip fixed-point SCR
  bytes per fixture; `pmtiles-ts.mjs`/`pmtiles-py.py` build a spec-written
  archive on each side independently and require byte-identical canonical
  reports (header, directory, MVT decode, fetched features, compiled YAML).
  Offline `check.sh` now runs 7 cases green plus the pmtiles gate.
- Port notes worth keeping: `js_number()` is now a faithful JS `Number()` —
  bare hex strings parsed, `"0x…"` prefixes unsigned, `"infinity"` is NaN —
  and the SCR gate exposed that a bare-hex bug had corrupted ingest string
  interning. The SCR doc-side string sort reproduces the TS quirk of sorting
  `id,text` entries lexicographically rather than by id. MVT kv tags are
  greedy like the reference's `(\S+)` regex, so `turn=19th Street` keeps
  `turn="19th"` there too. PMTiles' `centerZoom` reads as a float32 at offset
  105 on both sides.

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
- Deferred to a later milestone (the rest of milestone 2, above): SCR wire
  codec, indoor floors, PMTiles/MVT, and the TomTom/HERE traffic flow
  providers.
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

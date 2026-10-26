# Changelog

## 0.5.6 — The join that was wired nowhere

A granting-regression fix, found two releases late:

- `transitAt` (the path every public entry point takes — MCP `get_transit`,
  the HTTP server, the CLI) fetched the realtime overlay and then never
  passed it to the schedule renderer. A deployment with `SUPERCARTO_GTFS_RT`
  set answered with the schedule only and no message saying why. The direct
  tests kept passing because they called the renderer with the overlay
  themselves — the wire existed, but nothing was driving it.
- Fixed in `src/live.ts`, and the `TransitSource` interface now carries the
  overlay parameter, so a future join wired nowhere fails the type check.
- Two regression tests pin the wire itself: an overlay-configured session
  must hand its overlay to the renderer, and a session without realtime
  must arrive clean.

316 unit tests (was 314); Python port untouched (the join lives in the
TypeScript-first transit layer); parity gate green.

## 0.5.5 — The next-departure board

A departure window (`first`/`last`) tells an agent the day's shape; a rider
asks "what comes next from this stop". 0.5.5 answers that:

- Node lines gain `next:` — upcoming departures in feed time order and in
  the feed's own clock (`tram 9 25:10` stays past midnight), capped at
  three with the hidden rest counted (`+2 more`). The cap is a token
  decision; the count is the omission record.
- Rows after the local query time only, computed through the feed timezone;
  when the day's last departure has run, the note says the day is over
  instead of letting an empty board read as a broken feed.
- With a realtime feed configured, the board speaks the prediction inline:
  `bus 16 07:05 +300s` or `cancelled`, joined by trip and stop with the
  same spec precedence as the live list. Predictions the board has spoken
  are removed from `live:` so one fact renders once.
- Scheduling honesty: a trip-level prediction decorates only its own trip's
  rows; another trip's departure stays unsuffixed — silence is not
  punctuality, and the note still carries the rule in words.

`live:` keeps its 0.5.4 meaning for stops whose prediction is not an
upcoming row (mid-trip vehicles, hours-old predictions). 314 unit tests
(was 310); parity gate green; byte-parity against the Python compile core
unchanged (transit stays TS-first, wire decoders mirrored).

## 0.5.4 — GTFS-Realtime: live delays join onto the schedule

Static schedules answer "when does the route run"; riders ask "is my bus
late". 0.5.4 adds the real-time half, with no dependency behind it:

- A minimal protobuf wire reader (`src/source/proto.ts` +
  `supercarto/proto.py`): int32 fields ride the wire as 64-bit
  two's-complement varints, so a delay of -2 arrives as ten bytes; absolute
  int64 times stay exact, and anything past Number fidelity is an honest
  rejection, not a lossy render.
- The TripUpdates schema (`src/source/gtfs-rt.ts` + `supercarto/gtfs_rt.py`)
  pins the **current spec field numbers** - `stop_time_update` is field 2 and
  the trip-level `delay` is field 5, both different from the 2015-era numbers
  most tutorial decoders still encode. Verified against the canonical
  gtfs-realtime.proto **and three live keyless agency feeds** (Adelaide
  Metro, Sofia, Translink SEQ): both ports decode each feed to identical
  counts. Deleted entities are retracted, never re-rendered as stale
  predictions; unknown fields skip by wire type, so later spec amendments
  decode everywhere; gzipped feeds inflate through a new `gunzip()` in
  `zlibsafe.ts`.
- `get_transit` joins the feed once per query: node lines gain a `live:`
  attribute (`bus 16 +300s`, `bus 16 cancelled`) beside `first`/`last`, and
  the note states how fresh the feed is. Join precedence follows the spec
  (explicit stop update beats trip-level delay; absolute-time predictions
  convert through the feed timezone; NO_DATA stays silent). The load-bearing
  sentence: **a stop without a live entry has no prediction - unknown, not
  on time**. A feed that will not read (404, timeout, malformed wire)
  degrades to the pure schedule answer with its reason quoted, never a
  silent drop and never a fabricated delay.
- Configure with `SUPERCARTO_GTFS_RT` (alongside the existing
  `SUPERCARTO_GTFS`). The hosted worker is unchanged: `/transit` still
  requires a static feed path an operator owns, and RT is opted in the same
  way.
- Also fixed: a latent wire-reader bug the live-feed trace exposed in the
  MVT decoder (`mvt.ts`/`mvt.py`) - `pos += varint()` loads the left value
  before the right-hand side advances it in both languages, landing skipped
  unknown length-fields one byte short.

Compiled against a live Translink SEQ feed end to end in the test suite.

## 0.5.3 — Real elevation: `/terrain` decodes PNG Terrarium tiles

`/terrain` answered an honest 503 at the hosted endpoint because every
real-world Terrarium tile is PNG-encoded and the bundled zero-dependency
decoder read a raw-sample variant only - realistic endpoints fetched fine and
decoded to nothing. Worse, once PNG decoding existed, the shared formula was
wrong by a factor of 256: the two live checks that proved it were Denver
reading 6.2 m (should be ~1600 m) and the Everest region reading 34 m.

- `src/source/png.ts` + port: chunk parser, scanline filters (None, Sub, Up,
  Average, Paeth) and the Terrarium formula `R*256 + G + B/256 - 32768`
  metres, for 8-bit RGB/RGBA, non-interlaced. Palettes, 16-bit depth and
  interlace are hard rejects, not guesses. Inflate is the Web
  `DecompressionStream` in Workers and Node's `zlib` under Node, via
  `zlibsafe.ts` - still zero runtime npm dependencies.
- The raw-sample decoder now also decodes to metres `((s - 32768) / 256)`,
  and the bilinear sampler is pure interpolation over metre-valued grids.
- Hosted `/terrain` returns real elevation: SF −25..143 m, Denver
  1568..1646 m, Everest region 5023..6948 m, verified live. The honest-503
  reason stays for tiles that genuinely fail to decode.

## 0.5.2 — PMTiles reads real archives at the true latitude

The tile-y conversion flipped every remote PMTiles fetch about the equator:
a real `build.protomaps.com` fetch of San Francisco streets decoded at
-37.77 against a query for +37.77. Local test archives had never caught it -
they were written by the same code under test and stayed self-consistent,
and the one geographic assertion matched digits without a sign, so
`-37.71` satisfied a check written for `+37.71`.

- Both ports fixed in lockstep: the slippy row is `y0 + v`, and the
  docstring now states why no flip may be inserted.
- The fixture test parses coordinates and asserts the hemisphere and loose
  bbox membership instead of a substring regex.
- Verified live: `lat 37.7164..37.7903, lon -122.43..-122.36` for the SF
  bbox against the real 2026-10-22 build.

Also carried: the parity gate now runs fixture budgets 128-2048 (the small
budgets are where shrink-loop bugs live) and rebuilds `dist/` when sources
are newer, after the 0.5.1 gate published against a stale build. In-memory
archive builder also exercises the worker's PMTiles path; the hosted
endpoint compiles real maplets from the fallback today.

416 tests; parity byte-clean across `parity-kitchen-sink`, `sf-mission-5th`,
`synthetic-dense`, `indoor-mall` at budgets 128/256/512/1024/2048.

## 0.5.1 — the budget kept its promise on dense small maps

Three fixes, all found by probing the token-budget contract end to end:

- **The exhaustion branch now opens the pressure valve on both ports.** A
  small dense graph reached the shrink loop with batch already at 1 and
  exited before cut vertices were ever admitted, silently returning 580
  tokens on a 512 budget - the one case where the product's central promise
  ("the budget is hard, re-measured on delivered output") lost. The valve
  opens in that branch too (580 -> 411 on the probe fixture).
- **Obstacles that name pruned edges no longer ship.** Shrinking or chain
  contraction removed an edge and left the warning behind - an agent told to
  avoid a route that no longer exists in the map it holds.
- **Uniform-plateau heat layers collapsed to their summary line**, and a
  cell at the ceiling of a degenerate declared range reports `rel: 1`, not
  the misleading `rel: 0`.

Also carried: hosted-worker readiness (detached-fetch safety across every
injectable `fetchImpl`, GTFS pulled from Worker bundles as types-only) and
`/healthz?endpoint=` probes against a closed list of Overpass instances.

416 tests; parity re-run; verified against the hosted endpoint.

## 0.5.0 — GTFS transit, and a slope-layer correctness fix

### get_transit: schedules for agents

`get_transit` answers "can you be somewhere by 9" from an actual schedule. Set
`SUPERCARTO_GTFS` to any static GTFS feed — a directory of tables or a single
.zip — and the tool appears in `npx supercarto mcp`, the HTTP API, and the CLI
(`supercarto transit --feed ... --lat ... --lon ...`). Every output re-uses the
maplet's own honesty rules, and adds three of its own:

- **Three service states, never two.** A running day shows today's routes and
  first/last departures. A date with nothing running keeps the stops with
  `routes: []` — "no transit" is not "no stops" — while adjacency edges stay,
  because a walk between stops does not need a timetable. A feed with no
  calendar shows the whole network and declares the service window unknown
  rather than labelling whole-feed facts as today's.
- **Times past midnight stay past midnight.** GTFS writes a departure after
  the service day's midnight as `25:10`; rendering it as `01:10` fits the eye
  and strands the person waiting for it. The feed's timezone, the evaluated
  instant, and every caveat travel in the map's `note`.
- **The tool is absent without a feed.** Like traffic, `get_transit` is not
  advertised unless the operator configured one — a schedule is only as fresh
  as the operator's last import, so serving one is an operator's decision, not
  a default. A configured-but-broken path degrades at query time with a clear
  error; the rest of the server keeps working.

Implementation is dependency-free again: an RFC 4180 CSV parser (quoted
fields, CRLF, UTF-8 BOM) and a minimal zip reader (STORE + DEFLATE) live in
`src/source/gtfs.ts`. The token budget is hard, re-measured on the emitted
YAML, with connectivity-preserving pruning first and an `omitted:` record of
every drop. 26 offline tests cover the parser, the three service states, both
budget passes, and the zip reader; the feature was additionally verified
end-to-end against the GTFS sample feed in all three states.

### Slope layers survive their own clamps

`compileHeat` dropped any layer whose surviving hotspots carried one distinct
value — the check meant to stop a flat-earth maplet printing `slope: {max: 0,
mean: 0}` was also erasing uniformly steep terrain, which is a fact an agent
acts on, not an absence. Only degenerate (all-zero) layers are dropped now, on
both ports, and the test terrain is a smooth hill whose grades stay under the
20% presentation clamp so the emitted cells can carry distinct values.

## Unreleased — route demoted from navigation to feasibility

The benchmark's honest finding — the public demo OSRM answers `Ok` with
physically impossible distances on foot profiles, and nothing in the response
looks wrong — pointed at a product defect, not just a fixture problem: the
strongest-sounding tool was the least verified one.

- **`route` defaults to a feasibility answer**: straight-line distance, the
  initial compass direction, and an instruction that ends in "then verify the
  approach on arrival". It claims exactly what it can compute and nothing
  more. `FeasibilityRouter` (TS `src/source/routing.ts`, Python
  `routing.py`) is the new default; an OSRM instance is now a strictly
  explicit choice, for operators who host and verify their own engine.
- Tool catalogue copy updated on both sides (byte-parity held: SCR encodes
  the catalogue, so both languages changed the string identically), and the
  MCP `route` description now states the exact contract.
- Tests on both sides pin the demotion: an unconfigured `SuperCarto` answers
  `straight-line`/`walk-approx` offline and the instruction ends in the
  verify clause.

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
Node**: Overpass (OSM data), Open-Meteo (weather) and the feasibility router
(routing demoted to feasibility; OSRM remains an explicit opt-in)
routing) are ported over `urllib`, keeping the package at zero runtime
dependencies. All under the same byte-parity gate as milestone 1.

- New `python/src/supercarto/` modules, ports of `src/source/*.ts` and
  `src/live.ts`: `net.py` (a zero-dependency `urllib` fetch shaped like the
  WHATWG API), `overpass.py` (query builder, element→GeoJSON conversion,
  retry with layer-dropping / box-shrinking / best-result retention,
  implausible-coordinate rejection), `weather.py` (Open-Meteo with null-safe
  cells, WMO code prose, NaN "unknown" degradation), `routing.py` (OSRM with
  maneuver→sentence prose and the labelled `*-approx` fallback, which is now
  the default route source after the feasibility demotion),
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

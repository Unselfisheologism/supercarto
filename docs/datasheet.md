# Datasheet: the supercarto spatial benchmark

Following Gebru et al., *Datasheets for Datasets* (arXiv:1803.09010).

This describes a benchmark **harness and dataset** that is not yet fit to produce a
published result. Several sections below say so directly. It is written now because
the failure modes it records were found the expensive way, and writing them down is
cheaper than rediscovering them.

---

## 1. Motivation

The claim under test is narrow: **an agent given a supercarto maplet answers map
questions correctly and cheaply, where the same agent given raw GeoJSON manages one
or the other.**

Token count is not the claim. Every agent can be made accurate by sending more
data. The claim is accuracy *at a fixed token budget*, and the crossover point —
where supercarto at budget *B* matches raw GeoJSON at budget *C* — is the number
that matters.

The comparison only means something if the two arms are looking at identical
underlying data and differ *only* in representation. That constraint has been
violated by this harness twice, described in §9.

## 2. Composition

**Areas.** 8, chosen to be awkward rather than representative:

| Area | Lat | Radius | Features | Named | Why |
|---|---|---|---|---|---|
| `sf-cbd` | 37.79 N | 400m | 720 | 336 | Dense CBD, maximum feature count |
| `oslo` | 59.91 N | 400m | 1112 | 604 | High latitude, where a wrong Mercator scale shows as a metres error |
| `singapore` | 1.28 N | 500m | 301 | 134 | Near-equatorial, longest longitude degrees |
| `tokyo-shimbashi` | 35.68 N | 400m | 443 | 230 | Non-Latin place names, stressing the emitter |
| `sydney` | 33.87 S | 400m | 1167 | 537 | Southern hemisphere, so a y-axis sign error inverts the map |
| `reykjavik` | 64.15 N | 500m | 1104 | 583 | Sparse, cold; few named places survive a small budget |
| `rural-montana` | 46.40 N | 2000m | 1 | 0 | Sparse rural geometry where most approaches return nothing |
| `kuala-lumpur` | 3.14 N | 400m | 183 | 47 | Complex road hierarchy, inconsistent tagging |

`lat` spans 64°N to 33°S. A benchmark run only at 37°N measures Web Mercator at one
latitude and hides every sign error toward the poles.

**Tasks.** 4 kinds per area, 32 total, generated rather than hand-written so every
area gets identical treatment. A hand-written set drifts toward whatever its author
found interesting.

| Kind | Question | Ground truth |
|---|---|---|
| `route` | How far along streets, versus straight line? | OSRM |
| `turns` | Which street names, in which direction? | OSRM step list |
| `nearest` | Which named places, of what type? | Source data |
| `connectivity` | Is everything walk-connected? | The emitted graph's components |

Questions that cannot be scored programmatically are deliberately absent. A
benchmark full of "summarise this neighbourhood" becomes an LLM-judged leaderboard
where the judge is the thing under test.

**Arms.** Three per task: `supercarto` (compiled YAML at each of 3 budgets),
`geojson` (the same source features, uncompiled), `none` (coordinates only).

## 3. Collection process

Fixtures are captured from **OpenStreetMap via Overpass**, one file per area under
`fixtures/bench/`, using `scripts/capture-bench-areas.ts`. Routing truth comes from
**OSRM** (`router.project-osrm.org`), the reference pedestrian router, queried live.

**Provenance of every feature.** OSM is community-contributed and the upstream data
is inconsistent. One live capture returned a maplet that discarded 4606 features
"with coordinates outside the requested area" and lost the `waterway` layer to a
retry, both of which are recorded in the response as `WARNING` lines rather than
being silently dropped. That is the intended behaviour and it is why the maplet
carries an `omitted:` count.

**Human involvement.** None in the current build. Task wording and area selection
were chosen by the author. No domain expert reviewed the questions, and no
inter-annotator agreement was measured because there is only one annotator. BetterBench
lists expert involvement as a design criterion; this dataset does not meet it.

**What this means for the data.** OSM names are the messiest part. They contain
commas, ampersands, initials, qualifiers and non-Latin scripts —
`Steven S. Miyake, Esq.`, `University of San Francisco - Folger Building`,
`Lookout, Inc.`, `Boudin Bakery & Cafe`. Every scoring rule in §5 had to be written
around that, and two of them were written wrongly at first (§9).

## 4. Preprocessing

`toMaplet` — ingest, project to a local metric, compile to a topological graph, fit
to a token budget, emit YAML. The benchmark always calls the production path rather
than a stub, so what the model sees is what the emitter actually produces.

**Filtering.** Budget fitting drops nodes by scored importance, with a reserved share
for named places so a dense area still names things. Dropped features are reported in
the emitted `omitted:` block rather than vanishing.

**Alias extraction.** Ground truth carries `alt_name`, `old_name`, `official_name`,
`short_name`, `loc_name` and `brand` alongside `name`, because a model quoting a
plaza's former name has not invented it.

## 5. Uses

**Intended.** Measuring whether a structured map representation helps an LLM answer
spatial questions, as a function of token budget. Intended users are the library's
maintainers and anyone choosing how to feed map data to an agent.

**Not intended, and actively misleading here:**

- **Effect size against a no-map baseline on well-known cities.** See §7.
- **Any claim about models.** A result on one model is a result about that model, and
  no panel spanning multiple families has been run.
- **Confidence intervals.** See §8.

## 6. Distribution

Apache-2.0, same as the code. `fixtures/bench/*.geojson` and `bench-results/*.jsonl`
are committed.

Not yet done, and required before release: Croissant dataset metadata, a persistent
identifier, and a stated licence for the underlying OSM extract (ODbL, which
obliges attribution and share-alike for derived databases — **this has not been
checked and is a real compliance question, not a formality**).

## 7. Maintenance

**The floor is memorisation, and it is currently above the treatment.** This is the
single most important fact in this datasheet.

The `none` arm receives coordinates and nothing else. Given downtown San Francisco
at 37.7936, −122.3958 and asked to walk 200m north, a free model answered:

> ~863 m street-network path: start facing north-east on **Market Street** (~24 m),
> turn right to face south-east on **Spear Street** (~197 m), turn right to face
> south-west on **Mission Street** (~109 m)…

OSRM's truth is **868m via Market Street → Spear Street → Mission Street → Main
Street → Drumm Street**. The prompts are 184–205 estimated tokens; there is no map
data in them to leak. The model recalled the city.

On that same task the **supercarto arm refused** — correctly reporting that the
maplet carries no routable street-name layer — and scored zero. Both archived runs
in `bench-results/` show `supercarto` below `none` on `route-distance` and
`turn-by-turn`.

Consequences:

- `supercarto − none` is **not an effect size** on these areas and can be negative.
- No figure from this harness should quote a supercarto-vs-none gap for a
  well-known city centre.
- **The honest floor needs an area the model has not memorised** — a small city, a
  rural area, or a synthetic extract at coordinates matching nowhere real. Note that
  `rural-montana`, the one candidate, captured with **1 feature**. It is currently
  empty, not sparse.
- **Refusal is scored as failure on every task.** Defensible for `nearest`, where
  inventing a shop is the worst outcome; indefensible for `turn-by-turn`, where
  declining to invent a route is correct. The scoring does not distinguish them.
  Fixing this means scoring "correctly reported insufficiency" as its own outcome.

Two independent causes, both live. Neither is a leak.

## 8. Related work

Drawn from the survey in the SOP. Note that some are very recent preprints and
should be checked before formal citation.

**MapEval** (arXiv:2501.00316) — 700 expert-written questions on place info,
nearby, routing and trips, from Google Maps data, 30 models evaluated. Has a
MapEval-API track where agents call map APIs. Closest in spirit to this benchmark
and the natural external check. Evaluates *models*, not map-data representations.

**MobilityBench** (arXiv:2602.22638v1) — 100,000 route-planning episodes from real
Amap queries, with deterministic API replay so live traffic cannot alter results,
and multi-dimension scoring (outcome, instruction understanding, planning, tool use,
efficiency). Methodologically the closest: the replay-cache idea is the right answer
to this benchmark's live-truth problem. Tests one vendor's API set.

**GeoAgentBench / GABench** (arXiv:2604.13888) — 117 GIS tools, 53 spatial analysis
tasks, dynamic sandbox, trajectory-level scoring (TAO/TIO/TEM) and VLM-judged map
similarity. GIS analysis, not navigation. Its task set barely overlaps this one's, so
a score there would mostly measure tasks supercarto does not attempt. It does
support HTTP MCP servers, which is why `supercarto mcp-http` now exists.

**Map2Route** (arXiv:2609.17910) — human-curated compositional language-grounded
route planning over semantic maps.

**MapQA** (arXiv:2503.07871v1) — open-domain geospatial QA over map data.

**GeoLLM-Engine** (arXiv:2404.15500), **GeoBenchLLM** (HF `rfr2003/GeoBenchLLM`) —
geospatial copilots and multi-dataset geo task suites.

**Map-image benchmarks** — MapBench (arXiv:2503.14607), MapVerse (WACV 2026),
FRIEDA, transit-map reading. Reading map *images* is a different input modality and
not comparable.

**Urban-graph QA across three cities** (ISPRS Annals XII-4-W2-2026) — compares
seven graph-language interfaces; graph tool access scored highest at 87.4%. The
closest published work to the question "how should a graph be presented to an LLM",
though it is research benchmark on graph QA, not a framework comparison.

**Generic MCP tool-use** — MCP-Atlas, MCP-Universe (arXiv:2508.14704v1). Not
map-specific.

### What is claimed as novel, and what is not

**Not claimed:** that public map/geospatial benchmarks for LLMs do not exist. They
do — MapEval, MobilityBench, GABench and others. Any writing implying otherwise will
be corrected by a reviewer in minutes.

**Claimed:** that no public benchmark makes the *map data system itself* the
variable under test — supercarto vs raw GeoJSON vs a vendor API — across spatial task
types, with context-token cost as a reported axis. No public dataset of paired
(map area, compact graph, verified answers) was found for that purpose either.

**This is a search result, not proof.** It came from web search, not an exhaustive
review of Google Scholar or Hugging Face. It is stated as a search result wherever it
appears.

## 9. Known defects found by running this

Every one of these was found by running the harness and reading its output. None was
found by reading the code. Each invalidated a run on its own.

1. **The raw baseline was rigged by the harness.** The live path serialised the
   *compiled* graph to build the geojson arm. Compiled nodes carry no coordinates
   and only budgeted nodes are named, so the "raw GeoJSON" arm was 66 features with
   **0 names and 0 geometries** against a 720-feature source with 336 names. The
   benchmark's central comparison was measuring the harness, in supercarto's favour.
   Fixed: the arm is rebuilt from the source features.

2. **Ground truth described a different question than the one asked.** The
   turn-by-turn prompt asked for 200m while the router was pointed at the area
   radius — 400m, or 2000m in rural Montana. Connectivity truth was compiled at
   budget 4000 while the model saw 1024 (8 components vs 33).

3. **The recall pass condition was unreachable.** Recall was measured against all
   336 area names while a 1024-token maplet carries about ten. Every arm scored 0% —
   indistinguishable from an impossible task. Now measured against what the arm was
   shown, with full-area recall still reported as `area recall`.

4. **The hallucination detector invented places that were in the data**, twice.
   First because it could not represent a lowercase connector, splitting
   `University of Phoenix` into `University` and `Phoenix`. Then because it could
   not match a fragment to its parent, reporting 20 invented places on one real
   answer — all 20 traceable to names in the fixture, including `Lookout, Inc.` →
   `Lookout`. Because hallucination is a hard failure, both forced entire runs to
   zero.

5. **The subject model ran in the repository**, where it could read `.bench/` and
   `fixtures/`. A smoke run's `none` arm answered with 895m against an OSRM truth of
   895.3m — a 0.03% match, which is not a guess. Fixed: a fresh empty temporary
   directory per driver, and a run that invokes a tool is voided.

6. **Protocol claims were false on the path anyone actually ran.** "Temperature 0,
   three seeds" and "provider tokenizers" describe the paid-provider path.
   `opencode run` has no `--temperature` or `--seed` flag, so neither reaches the
   model, and token counts are `chars/4`. Both are now stated per-path, including
   that **a spread of 0.00 is not an error bar**.

7. **Resume blended two harnesses.** The archive key is task/arm/budget/seed, none of
   which change when the code does, so a resumed run after a scoring change replayed
   old answers under new rules. The `promptHash` was stored for this purpose and
   nothing compared it. Now refused, with `allowMixedRuns` to opt out.

8. **A shipped test asserted two runs produce identical wall-clock timings.** It
   passed only while every call rounded to 0ms.

## 10. Oracle check

**Present for the fixture path.** `test/bench.validity.test.ts` asserts a solver
given the ground truth scores 100% on each task. Its absence is why defect 3 shipped.

**Absent for the live path.** Route truth was queried live at run time, so no offline
oracle could validate it. That path is now unreachable in practice: the demo router
returns impossible distances (§ "The routing oracle is unusable"), so route truth is
rejected before it can be graded. The live path is not trustworthy and is not used.

## 10a. Truth is frozen and reproducible

Every kind that still measures something derives its truth from the fixture through
`compileFixture`, a pure function of fixture, area and budget. There is no `Date.now`
and no `Math.random` anywhere in the truth path — those appear only in metadata and
timing.

This means a re-score reproduces the original run's truth exactly, not approximately.
Two runs a month apart cannot disagree, because nothing in the computation reaches
the network. The fixtures are committed and their sha256 is recorded in the archive
metadata, so the inputs are pinned as well as the outputs.

`test/bench.frozen-truth.test.ts` pins this by wiring the reference router and the
live maplet to throw, then asserting truth still comes back populated and identical
across two calls. It also carries the control that makes the other assertions mean
something: with the fixture removed, truth *must* come back empty, which proves the
stubs actually fired rather than the test passing vacuously against silently empty
truth.

The freeze machinery that would have been written for the live oracle turned out not
to be needed, because the only kinds that used it are the ones that turned out not to
be measurable.

## 11. Known limitations

- **No confidence intervals are possible on the free path.** No seed reaches the
  model. Repeats are not independent samples.
- **Token counts are estimates**, so only ratios between arms are meaningful.
- **Route and turn-by-turn are unmeasurable on every area** — the reference router is
  a shared demo server with an experimental walking profile that returns distances
  shorter than the straight line. Three of five task kinds measure something.
- **Ground truth is OSRM, not the real world**, for the two kinds it still applied
  to. The claim is about token cost and readability, not route optimality.
- **Distance tolerance is 15%.** A systematic bias inside that band passes.
- **Hallucination detection is an upper bound.** Messy OSM names are genuinely
  ambiguous in comma-separated prose; on an oracle listing all 181 sf-cbd names it
  still mis-segments 23.
- **Areas are hand-chosen, not randomised**, so aggregate accuracy is not a
  population estimate.
- **Live truth moves.** Two runs months apart can legitimately disagree.
- **Overpass is rate-limited and returns 504s under load.** A live `tools/call` probe
  failed outright while the same query via CLI succeeded seconds later. Any external
  harness will see flaky failures that read as model errors. `SUPERCARTO_PMTILES`
  is the intended fix and is not configured.

## 12. The `omission` task: measuring the protocol instead of the map

Every other task kind is satisfiable by a sufficiently good map of the area. The
`omission` kind is only satisfiable by a map that admits what it left out, which is
the protocol's actual claim and not its token count.

**The task.** On an area of 4,570 features compiled at budget 1024, the maplet
declares `omitted: - {layer: feature, count: 3966}` and keeps 34 nodes. The model
is asked whether the data it was given shows everything present. Passing requires
acknowledging the gap and **not** concluding the area is bare.

**Why it is not another accuracy number.** A raw GeoJSON cut short is *silently*
incomplete — nothing in it says data is missing, so the natural reading is "this
area holds only what I can see". At 12% of the file the truncated extract does not
even parse as JSON, shows 462 of 4,500 trees with no indication that the other
4,038 are absent rather than unshown, and mentions no category counts. There is no
token budget at which a truncated raw file tells a model that it is truncated.

**Where it runs.** Only on `synthetic-pacific`, because on a real city the no-map
arm bluffs it from memory. That area has open-North-Pacific coordinates and
synthetic names (`Cafe 0`, `Tree 1`), so memorisation is impossible by
construction rather than merely unlikely.

**Verified end to end** against the real fixture and the runner's own ground-truth
builder:

| Answer | Verdict |
|---|---|
| "3,973 features were omitted to fit the budget" | **PASS** |
| "Some features were omitted" | PASS, flagged for not sizing |
| "This area appears empty apart from a few cafes" | fail — both conditions |
| "I cannot determine this from the data" | fail — the data contains the answer |
| "A quiet residential grid with a few cafes, nothing more" | fail — the memory bluff |

The last row is the one that matters: the memorisation defence holds.

### What the synthetic area can and cannot measure

Measured, not assumed. Three kinds are generated there now (`route` and `turns`
were dropped: no valid ground truth), and all three were run on
`opencode/muse-spark-1.3-contributor-free` — an official, versioned model, not a
codename — at 3 repeats per arm, 27 calls, 0 failures.

| Kind | supercarto | geojson | none |
|---|---|---|---|
| `omission` | **3/3** | 1/3 | 0/3 |
| `nearest` | **3/3** | 0/3 | 0/3 |
| `connectivity` | **3/3** | 3/3 | 0/3 |
| **total** | **9/9** | 4/9 | 0/9 |

Three readings of that table, in decreasing order of comfort:

1. **The floor is clean.** The no-map arm scores 0/9 on a fixture nothing can have
   memorised. Every point the supercarto arm earns above zero is points for the
   representation, not for training data.
2. **Omission is the thesis, and it holds.** 3/3 against 1/3 against 0/3, on three
   uncontrolled repeats. The single geojson pass came from a model reasoning about
   the data's shape (suspiciously round bounds), not from reading a record — raw
   GeoJSON never signals incompleteness explicitly.
3. **`nearest` is where the arms separate hardest.** The geojson arm recalled 80%
   of the shown names all three times but invented 4 places each time, so it failed
   all three on hallucination. Burying a model in 173k tokens does not just cost
   tokens; it makes the model confabulate.

Two caveats that travel with these numbers wherever they go: 3 repeats are 3
uncontrolled draws, not 3 seeds — no seed reaches the model on the free path, so
there are no confidence intervals. And the geojson arm completed all 9 calls with no
timeouts on this model, where it timed out 2/3 on the earlier codename models; arm
reliability is a property of the model, not just of the fixture size.

### Second model, and the contamination it found

The same 27 calls were first run on `opencode/step-5-preview-free`: supercarto 7/9,
geojson 2/8 (one timeout), none 0/9. The ordering replicated — representation beats
raw file beats nothing — on a second official model.

The run also exposed an isolation failure in the harness, and it is recorded here
rather than quietly fixed because it affects how the earlier numbers must be read.
**5 of the 27 step-5 answers quote benchmark metaknowledge with an explicit memory
marker**: "the ~4,570-feature grid ◪ from supermemory that was compiled and frozen
in this repo", "the benchmark context recalled from supermemory shows the none arm
scoring 0/9", "the connectivity kind is the one this map can actually measure (3/3
in the benchmark)". None of that is attainable from the prompts — the fixture
details, the skipped-test count, the prior scores. The subject inherited the
operator's opencode config through the environment, and with it the memory plugin
with recall allowed. Memory recall is not a tool call by the model, so the
tool-voiding that guards every run never fired on it.

Three things limit the damage, all verified rather than assumed:

1. **All five contaminated answers failed.** The metaknowledge did not buy a single
   point — two concluded the map was complete from memory and were failed for it,
   three were refusals. Contamination is proven present and proven scoreless.
2. **The clean run is clean.** The Muse Spark archive carries zero memory markers
   across all 27 answers.
3. **The channel is closed going forward.** The driver now spawns every subject
   with a clean, empty `XDG_CONFIG_HOME`, alongside the existing scratch cwd. A/B
   verified: same probe, clean config → "I don't retain memory", no recall attempt;
   operator config → recall fires. Auth is unaffected (credentials live in the data
   home), and a probe call under the clean config succeeded. Pinned by a test that
   asserts the child's config home is a real, empty, non-operator directory.

### Clean replication: step-5 goes 9/9

Because markerless influence cannot be ruled out for the tainted run, the
replication was re-run under the clean config — 27 fresh calls, no tainted row
reused:

| | supercarto | geojson | none |
|---|---|---|---|
| omission | **3/3** | 1/3 | 0/3 |
| nearest | **3/3** | 0/3 | 0/3 |
| connectivity | **3/3** | 2/3 | 0/3 |
| **total** | **9/9** | 3/9 | 0/9 |

Zero memory markers across all 27 answers, zero failures (the tainted run's single
timeout did not recur). Both official models now agree exactly: **supercarto 9/9,
floor 0/9**. The tainted run's two supercarto misses do not reproduce under clean
conditions, which is consistent with contamination noise rather than model
capability — and is itself an argument for the isolation fix.

The Muse Spark 9/9 stands as the headline; step-5 confirms it at full strength,
not just the ordering.

The two failures share a root cause worth recording, because it is the worst kind of
benchmark bug: **a ground-truth source that reports success for a route it did not
compute.** OSRM answers `{"code":"Ok","routes":[{"distance":0,"duration":0}]}` for a
point with no road network. The runner took that at face value, so ground truth
became 0m and every arm was graded against "the true walking distance is zero" —
including the no-map arm that correctly observed the coordinate lies in open ocean
with no streets anywhere near it. A zero-metre route is now treated as no truth at
all, so the task surfaces as unscoreable rather than failing everything.

`turns` has a second, independent problem: it asks which street names a walker would
pass, and at budget 1024 the synthetic maplet emits 34 nodes and **zero street
names**. A model reporting that honestly is scored as failing.

Both kinds are therefore not generated for this area.

### The routing oracle is unusable, on real areas too

The comment above originally ended "they remain generated for the real areas, which
carry OSM geometry the reference router recognises." That was checked, and it is
false. `route` and `turns` were re-run on `sf-cbd` and produced 0% across every arm,
including answers that were individually reasonable. The cause is the reference
router, not the tasks and not the scorer.

`router.project-osrm.org` is a shared demo server with an experimental walking
profile. Measured from the centre of `sf-cbd`, walking north:

| Straight line | Walked | Factor |
|---|---|---|
| 50 m | **35 m** | 0.71 |
| 100 m | 725 m | 7.25 |
| 200 m | 868 m | 4.34 |
| 400 m | 897 m | 2.24 |

**A 50 m displacement cannot take 35 m of walking.** That is shorter than the
straight line and is physically impossible. Every one of these returns `code: Ok`,
and the endpoints snap within 9 m and 25 m of the points asked for, so neither the
response code nor the snapped geometry reveals the problem.

This is the same failure class as the zero-distance case above, and the second form
is the more dangerous one. Zero is visibly degenerate, so it gets noticed. 868 m for a
200 m walk looks like an ordinary urban detour, so it was silently accepted as truth
and graded against. The models answered "roughly 450–500 m" — a reasonable reading of
a grid city — and were marked wrong against a number that reflects a broken profile
rather than the walk.

Ground truth is therefore checked against the geometry the question describes: a
walking route must be at least 95% of the straight line and at most 3x it. Outside
those bounds the truth is unavailable rather than wrong, and the row surfaces as
unscoreable. On `sf-cbd` that makes both kinds unscoreable.

**What this costs the benchmark, stated plainly:** `route` and `turns` are
unmeasurable on every area, synthetic or real. Of the five task kinds, three measure
something and two depend on a routing oracle that would have to be a self-hosted
OSRM with a real walking profile — or a different question that does not require one.
This is recorded rather than worked around, because the alternative is publishing
numbers produced by an oracle that returns 35 m walks.

**Known gap in the underlying protocol — since fixed.** The omission record used to
read `layer: feature`, not `layer: tree`: the budgeter filed every removal under one
generic label because `GraphNode` carried no semantic layer, so an agent was told
3,966 features had been dropped without being told they were trees. Honest about
the gap, silent about its nature. `GraphNode` now carries the source layer and the
budgeter groups by it, so the record reads `{layer: tree, count: 3925}`.

Two things surfaced while fixing it:

- **`layerKey` is silently dropped at the top level.** It is a valid *ingest*
  option, but `MapletRequest` has no such field, so `toMaplet({layerKey: 'x'})`
  is accepted and ignored rather than rejected. Documented at the call site rather
  than validated, because the option is one level down and the mistake is easy.
- **Inference alone still separates categories.** Without any explicit tag, the
  same area yields `poi` and `road` omissions rather than one bucket, so the fix
  does not depend on a source labelling its data.

## 13. What would make this publishable

1. **A non-memorised area**, so the floor is a floor. Synthetic coordinates are the
   cheapest option and are not yet implemented.
2. **Score "correctly reported insufficiency" as its own outcome**, so a maplet that
   honestly lacks a layer is not scored as a wrong answer.
3. **Freeze ground truth to a versioned file**, so a re-score cannot disagree with the
   original run. The archive makes responses durable; truth is still live.
4. **A panel spanning model families**, with the small local model the docs call
   mandatory.
5. **The ODbL question answered**, not assumed.
6. **Croissant metadata and a persistent identifier.**
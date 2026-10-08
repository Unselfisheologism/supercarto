# The benchmark

`supercarto bench` measures token count. Token count is not the claim, and a
benchmark that only measures what a library is already good at is marketing.

The claim is this: **an agent given a supercarto maplet is correct and cheap,
where the same agent given raw GeoJSON manages one or the other.** Verifying it
requires tasks with known answers and a scoring rule that cannot be gamed by a
judge's opinion.

```bash
export ANTHROPIC_API_KEY=...
npx supercarto bench:tasks --budgets 512,1024,2048 --out report.json
```

---

## What gets compared

Same question, same model, same system prompt, same underlying map data. The
only variable is what sits in the context window.

| Arm | What the model sees |
|---|---|
| `supercarto` | The compiled topological YAML graph, at each budget. |
| `geojson` | Raw GeoJSON for the same features. This is what a map API returns today. |
| `none` | Coordinates and nothing else. |

The raw arm carries the source features, with their geometry and properties
intact. It is recovered from the same document the supercarto arm was compiled
from, not reconstructed from the compiled graph: projecting graph nodes back into
GeoJSON drops every name (only budgeted nodes are named) and all geometry
(compiled intersections carry no coordinates), which produced an arm of 66
nameless, geometry-less features against a 720-feature source. That measures the
harness rather than the compiler, and it flatters supercarto by making the
baseline unreadable.

`none` is the honest floor. Without it, a run can look good because a model
refused rather than because it reasoned well — and refusal is cheap. It is also
what a human gets with no map.

Reading the output correctly means reading accuracy **next to** the token
column. Accuracy alone is trivially achievable by sending more data. Accuracy at
a fixed token budget is the actual claim, and the crossover point — where
supercarto at budget *B* matches GeoJSON at budget *C* — is the most useful
number this produces.

---

## Ground truth

Three task kinds, each with an answer that can be checked without a judge.

| Kind | Question shape | Truth from |
|---|---|---|
| `route` | How far along streets, versus straight line? | **OSRM**, the reference router |
| `turns` | Which street names, in which direction? | **OSRM** step list |
| `nearest` | Which named places, of what type? | **The source data** |
| `connectivity` | Is everything walk-connected? | **The emitted graph's** components |

Questions that cannot be scored exactly are deliberately absent. A benchmark
full of "summarise this neighbourhood" becomes an LLM-judged leaderboard where
the judge is the thing under test.

### Scoring rules

**Distance.** Relative tolerance of 15%. A 200m walk along streets is typically
220–260m; judging on the ratio rather than an absolute band is what makes the
tolerance meaningful at both ends of the scale. A straight-line answer is wrong,
which is the specific failure being caught: a model reading the map centre and
echoing the radius back, having reasoned about nothing.

**Hallucination.** A place name in the answer that is not in the source data is a
failure regardless of recall. Telling someone to walk to a shop that does not
exist is the worst outcome this library could produce. Abbreviations are handled
(`Powell St Station` matches `Powell Street Station`) because that is a
legitimate partial reference; fuzzy string matching is not used, because it would
also excuse `Starbucks` against `Starbunks`, which is the error being measured.

**Recall is measured against what the arm was shown**, not against every name in
the area. A 1024-token maplet for San Francisco downtown names about ten of the
336 named features in the fixture, so a pass condition of "recall half the
area's names" is unreachable at every budget and the run reports zero for a model
that in fact reported its data accurately. Recall against the shown set is the
pass condition; recall against the whole area is reported alongside it as
`area recall`, because that is the number which says what a budget costs.

**Connectivity.** Self-consistent: an answer is correct *about the data it was
shown*. If the graph has two components, saying some places are isolated is
correct. Establishing the true components of the real world is a different and
much harder task that this does not claim.

---

## The panel

One model is not a result. A result on one model is a result about that model.

| id | family | why |
|---|---|---|
| `claude-sonnet` | Anthropic | Strong spatial reasoning, long context |
| `gpt` | OpenAI | Different tokenizer, different failure modes |
| `gemini` | Google | Very large context, strong structured output |
| `small-local` | open weights | **See below** |

The small model is not optional decoration. Winning with a 7B model is the one
claim a token-count benchmark cannot manufacture — anyone can win on a frontier
model by spending more tokens, and the small-model result is what makes the
efficiency argument falsifiable. It should be in every published run.

```bash
# vLLM, llama.cpp, Ollama, LM Studio — anything OpenAI-compatible
export SUPERCARTO_LOCAL_LLM=http://localhost:8000/v1/chat/completions
```

---

## Protocol

Stated in full because a benchmark without its protocol is a number with nothing
attached to it.

Each claim below states what actually happens, and names the path it holds on. A
protocol section that describes an intention rather than the code is worse than no
protocol section, because it cannot be checked.

**Holds on every path:**

- **Per-task detail in the JSON output.** Every row is auditable, with the exact
  prompt, its SHA-256, and the raw answer.
- **Failures reported separately from accuracy.** `completion` and `accuracy` are
  distinct columns for a reason.
- **Unscoreable tasks count as failures**, never passes.
- **The subject model runs in an empty directory**, never the repository, and any
  run that invoked a tool is voided rather than scored.

**Holds only on the paid-provider path** (`bench:tasks`, via `models.ts`):

- **Temperature 0**, three seeds minimum, spread reported.
- **Provider tokenizers.** Tokens counted by the provider under test, not by
  `chars / 4`.

**Holds on neither path — do not assume these:**

- **Seeds are not independent on the opencode path.** `opencode run` exposes no
  `--temperature` and no `--seed` flag, so `OpencodeDriver` cannot pass them and
  does not try. Three `--seeds` runs are three *repeats*, not three seeds: the
  model is free to return the same answer, and a spread of `0.00` across them is
  the expected result whether or not the model is deterministic. **A spread on this
  path is not an error bar.** It is the only evidence available that a run is
  stable, and it is much weaker than a seeded interval. This is why the free-tier
  numbers in this repo carry no confidence intervals.
- **Token counts on the opencode path are `chars / 4` estimates.** The free tier
  reports no usage block, so no provider tokenizer is available. Ratios between
  arms remain meaningful because both arms use the same estimator, and that is the
  only claim the context-cost column supports. Absolute token figures are not
  provider figures and must not be quoted as such.
- **Caches cannot be disabled on the opencode path.** `--standalone` gives each
  call a private server, which removes the shared-session cache, but any caching
  inside the provider is not reachable from here and is not measured.

---

## The areas

Chosen to be awkward rather than representative.

| Area | Why it is in the set |
|---|---|
| San Francisco downtown | Dense CBD, maximum feature count |
| Oslo central | High latitude, where a wrong Mercator scale shows as a metres error |
| Singapore Marina Bay | Near-equatorial, longest longitude degrees |
| Tokyo Shimbashi | Non-Latin place names, stressing the emitter |
| Sydney CBD | Southern hemisphere, where a y-axis sign error inverts the map |
| Reykjavik centre | Sparse and cold; few named places survive a small budget |
| Rural Montana | Sparse rural geometry at 2km radius, where most approaches return nothing |
| Kuala Lumpur | Complex road hierarchy, inconsistent tagging |

A benchmark of uniformly dense mid-size cities measures one case well and misses
the rest. These span the cases that break approaches — extreme latitude, sparse
coverage, no data, and scripts the emitter does not ASCII-fold.

`lat` spans 64°N to 33°S. A benchmark run only at 37°N measures Web Mercator at
one latitude and hides every sign error toward the poles, which is how a
distance bug survives to production.

---

## The adversarial cases

The areas flagged `adversarial` exist to break supercarto, not to flatter it.
A benchmark that only reports wins is a press release.

**Sparse areas.** Reykjavik and rural Montana have few named features. The
interesting question is not "does it work" but "does it say so" when there is
almost nothing to show. An agent that invents a cafe in an empty field is worse
than one that reports the emptiness.

**The `none` arm.** Reykjavik's cafe task with no map data should mostly fail. If
it succeeds, check *why* before concluding anything — see below, because on a
well-known city it succeeds for a reason that invalidates the comparison.

### The floor is memorisation, and it is currently above the treatment

This is the most important limitation in this document, and it was measured rather
than assumed.

The `none` arm receives coordinates and nothing else. Given downtown San Francisco
at 37.7936, −122.3958 and asked to walk 200m north, one free model answered:

> ~863 m street-network path: start facing north-east on **Market Street** (~24 m),
> turn right to face south-east on **Spear Street** (~197 m), turn right to face
> south-west on **Mission Street** (~109 m)…

OSRM's truth for that query is **868m via Market Street → Spear Street → Mission
Street → Main Street → Drumm Street**. The model produced the right distance and the
right street sequence with no map in its prompt. Those prompts are 184–205
estimated tokens; there is no map data in them to leak.

So the floor is memorised city knowledge, and the areas picked to be
"representative" are the places most likely to be memorised. Worse, on that same
task the **supercarto arm refused** — correctly reporting that the maplet carried
no routable street-name layer — and scored zero:

> I can't determine that from the provided map: it has no routable street-name
> layer, no graph node at the map centre, and 2286 features plus 21 landmarks are
> omitted, so the map is incomplete. Any street names or turn directions would be
> invented.

That answer is *right*. It is scored wrong because the pass condition wants a
distance and the maplet does not carry one. The result is a benchmark where the arm
given no map beats the arm given the map, on the task the library exists to
support.

What follows, stated plainly:

- **`supercarto − none` is not an effect size on these areas.** It can be negative.
- **No figure from this harness should quote a supercarto-vs-none gap for a
  well-known city centre.** One exists in this repository's history and it is wrong.
- **The honest floor needs an area the model has not memorised** — a small city, a
  rural area, or a synthetic extract at coordinates matching nowhere real. Nothing
  in this repo has that yet.
- **Refusal is scored as failure everywhere.** Defensible for `nearest`, where
  inventing a shop is the worst outcome; indefensible for `turn-by-turn`, where the
  map genuinely lacks the layer and saying so is correct. The scoring does not
  distinguish the two cases.

**No-data areas.** An area with nothing in OSM should produce an honest empty
maplet with `omitted:` populated, not a confident fabrication.

---

## Interpreting a result

Things worth checking before believing a table:

- **Did the `none` arm score near zero?** If not, find out why before using the
  number. On a well-known city the answer is usually memorisation, not leakage, and
  a non-zero floor means the supercarto-minus-none gap is not an effect size.
- **Which path produced this?** A table with no path named cannot be interpreted,
  because the two paths differ in what they can hold. See [Protocol](#protocol).
- **Is a spread of `0.00` being read as precision?** On the opencode path it is
  not. No seed reaches the model, so repeats agreeing is close to the floor of
  what that number can tell you.
- **Is `small-local` present?** Without it there is no efficiency result, only a
  quality result.
- **Is accuracy rising with budget for `geojson`?** It should plateau. If it
  keeps rising, the GeoJSON arm is being truncated rather than fitted, and the
  comparison is not like-for-like.
- **Are failures counted?** `completion` below 100% means some rows are missing,
  and an accuracy computed only over rows that answered is flattering.

---

## Ground truth is frozen per fixture, not rebuilt live

Truth for the `route` and `turns` kinds comes from OSRM, queried live. That is
reproducible only if the query is recorded: the answer for a given pair of
coordinates can change when OSM changes, so a run and a re-score months apart can
legitimately disagree.

Every exchange in the archive stores the exact prompt, its SHA-256, and the raw
answer, so a re-score is a pure function of the file and cannot silently drift.
What is *not* frozen is the route truth itself, and the honest statement is that a
run is reproducible from its archive rather than from the live map.

## What is not yet true of this harness

Stated so a reader does not have to discover it. These are known gaps, not
results.

- **No oracle solver.** A benchmark should demonstrate that a perfect solver
  scores 100%, which is what proves the pass condition is satisfiable. There is no
  such check, and the recall bug above is exactly the class of error it would have
  caught.
- **Free-model runs are not reproducible from the harness alone.** The subject is
  an unpinned free model behind `opencode run`, so a repeat run is a different
  model behind the same name. Only the archived exchanges are reproducible.
- **Token counts on the free path are `chars / 4` estimates.** The free tier
  reports no usage block, so the provider tokenizer promised above is not
  available there. Cost ratios are still meaningful because both arms use the same
  estimator; absolute token figures are not provider figures.
- **The dataset is not yet released.** No license note, no datasheet, no Croissant
  metadata, and `.bench/` is gitignored, so no raw results are committed.

## Reporting it

```bash
npx supercarto bench:tasks --out report.json
```

Plain text tables to stdout, full JSON including every answer and rationale to
disk. A benchmark result that exists only inside a web page cannot be diffed
between runs or checked by someone who does not trust the page.

If you publish results, publish the JSON with them. The tables are a summary of
a claim; the JSON is the claim.

---

## Known limits

Stated plainly, because a benchmark that overstates itself is worse than none.

- **Ground truth is OSRM, not the real world.** The claim under test is about
  token cost and readability, not route optimality. A route that is 5% longer than
  optimal is scored correct here.
- **Distance tolerance is 15%.** A systematic bias within that band would pass.
  The library's own test suite pins distance error at 0.11%, which is where the
  tight check lives.
- **Hallucination detection is heuristic, and it was measured to be wrong.** It
  works by finding runs of capitalised words and asking whether any known name sits
  inside one. Two failure modes are known and neither is fixed:
  - *False negatives.* An invented name with no capitalisation and no place word is
    not detected.
  - *False positives on messy real names.* OSM names contain commas, initials,
    ampersands and qualifiers — `Steven S. Miyake, Esq.`, `Lookout, Inc.`,
    `Taxi Stand at Hotel Vitale` — and a model quoting them back may drop the
    qualifier or keep only a fragment. The matcher accepts a run that sits inside
    a known name as well as one that contains it, which removes the common case;
    on a real 71%-recall answer the invented-place count went from 20 to 1. It is
    not zero, so an invented-place count from this harness should be read as an
    upper bound rather than a measurement.

  This metric was previously wrong in the opposite direction and far more
  damaging: an early extractor had no way to represent a lowercase connector, so
  `University of Phoenix` was split into `University` and `Phoenix` and both were
  reported as invented. A correct answer naming ten real businesses was scored as
  six hallucinations, and because hallucination is a hard failure, every arm in
  every run scored zero. A detector that cries wolf on every answer is worse than
  no detector, which is why there is now a test asserting a known-correct answer
  produces zero hallucinations.
- **Live data moves.** The same task on the same day next month may have a
  different answer because OSM changed. Reports should state the date, which the
  JSON does.
- **Areas are not randomised.** They are hand-chosen to span the hard cases, so
  aggregate accuracy across areas is not a population estimate.
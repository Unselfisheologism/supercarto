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

- **Temperature 0**, three seeds minimum, spread reported. Providers are not
  bit-deterministic even at temperature 0 — batching, kernel selection, and
  floating-point reduction order all move logit ties. One run reports noise as a
  result.
- **Caches disabled.** A cached response is a free run that never happened, and
  the token counts for it are not the ones being claimed.
- **Provider tokenizers.** Tokens are counted by the provider under test, not by
  `chars / 4`. This matters more than most benchmarks admit: the same bytes cost
  different amounts to different tokenizers, and grading the library with the
  wrong ruler flatters whichever provider is measured most favourably.
- **Judging from a different family** than the model under test, where a judge is
  used at all.
- **Per-task detail in the JSON output.** Every row is auditable.
- **Failures reported separately from accuracy.** `completion` and `accuracy`
  are distinct columns for a reason.

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

**The `none` arm.** Reykjavik's cafe task with no map data should mostly fail.
If it succeeds, something is leaking between arms and the run is invalid.

**No-data areas.** An area with nothing in OSM should produce an honest empty
maplet with `omitted:` populated, not a confident fabrication.

---

## Interpreting a result

Things worth checking before believing a table:

- **Did the `none` arm score near zero?** If not, something leaked.
- **Is the spread reported?** A zero spread across three seeds is suspicious —
  it usually means one seed was run and copied.
- **Is `small-local` present?** Without it there is no efficiency result, only a
  quality result.
- **Is accuracy rising with budget for `geojson`?** It should plateau. If it
  keeps rising, the GeoJSON arm is being truncated rather than fitted, and the
  comparison is not like-for-like.
- **Are failures counted?** `completion` below 100% means some rows are missing,
  and an accuracy computed only over rows that answered is flattering.

---

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
- **Hallucination detection is heuristic.** It looks for place-suffixed and
  title-cased names. An invented name with no place word and no capitalisation
  is not detected. Precision matters more than recall here, because a detector
  that cries wolf on every answer is worse than none.
- **Live data moves.** The same task on the same day next month may have a
  different answer because OSM changed. Reports should state the date, which the
  JSON does.
- **Areas are not randomised.** They are hand-chosen to span the hard cases, so
  aggregate accuracy across areas is not a population estimate.
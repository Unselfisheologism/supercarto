# Archived benchmark runs

Raw exchanges and scored reports for the runs referenced in
[docs/benchmark.md](../docs/benchmark.md).

These are published **to be checked**, not to be believed. The reports contain
numbers that a defect in the scoring harness would have produced, and two of them
are wrong in ways the reports themselves now flag.

## What is here

| File | What |
|---|---|
| smoke-full.opencode-fledge-alpha-free.jsonl | 15 rows, one model, sf-cbd, all 4 task kinds x 3 arms |
| smoke-full.report.json | Scores for the above, re-derivable with scripts/report-free-ladder.ts |
| smoke2.opencode-fledge-alpha-free.jsonl | 14 rows, same shape, a second smoke run |
| smoke2.report.json | Scores for the above |

Each JSONL line is one model call: the exact system and user prompts, a SHA-256
over them, the raw answer, token counts, and the timestamp. Nothing is summarised
away, so any scoring rule can be re-applied without spending a model call:

`
npx tsx scripts/report-free-ladder.ts --out bench-results --report recheck.json
`

That is the point of the archive format, and it is why these files are committed
rather than regenerated: the model behind a free-tier alias can be withdrawn, and
re-running would then measure something else.

## Read these before quoting any number

**The floor is memorisation, and in these runs it is above the treatment.** Both
smoke runs show supercarto scoring lower than 
one on
sf-cbd/route-distance and sf-cbd/turn-by-turn. Given only coordinates, the
model answered the turn-by-turn question with 863m via Market Street -> Spear
Street -> Mission Street; OSRM's truth is 868m via that same sequence. Meanwhile
the arm that *was* given the maplet correctly said the maplet has no routable
street-name layer, and was scored zero for it.

So supercarto - none is **negative** in these runs. Do not quote an advantage
from them. The causes are distinct and both real:

1. the areas are well-known city centres, which a model has memorised, so the
   no-map arm is not a floor at all;
2. refusal is scored as failure everywhere, which is right for the place-listing
   task and wrong for turn-by-turn, where declining to invent a route is correct.

**Nothing here establishes a result.** One model, one area, one task set, and a
token-cost figure that is a chars/4 estimate because the free tier reports no
usage block.

## Provenance

These archives predate src/bench/metadata.ts, so they carry no commit hash and no
fixture digest. The fixture files under ixtures/bench/ are committed and can be
hashed to check what they were scored against. Reports from a current run do record
commit, CLI version and fixture hashes.

A run whose prompt does not match the archive is now refused rather than replayed,
so a future re-score cannot silently blend these rows with rows from a different
harness.

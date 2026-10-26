# supercarto announcements — ready to fire

Every post below is plain text, paste-ready. The claim style is deliberate:
no "revolutionary", no emoji spam, no engagement bait. The product's voice
is measured claims with receipts (tests, benchmarks, honesty rules) — the
audience that matters (agent builders) reads claims like auditors.

## 1. Show HN (news.ycombinator.com, needs an account)

Title: `Show HN: Supercarto – an MCP server that gives AI agents a map, sized to their token budget`

Body:

I built supercarto because an AI agent trying to answer "where should we
meet" has two bad options: read a 40k-token POI dump, or guess from memory.

supercarto is an MCP server that takes a coordinate and returns a
token-budgeted topological graph of the area: streets as edges, crossings
as junctions, POIs attached by id, indoor floors as separate layers. Ask a
bigger question, raise the budget; move the session, and `localize` returns
only the delta.

The design constraint I kept returning to is honesty. Traffic needs a
provider key, so without one the tool is not advertised — the server never
substitutes free-flow as a live ETA (it's the most damaging thing a schedule
could do). Transit answers come from an operator-imported GTFS feed, dated
and certified against the service day; a stop with no realtime prediction
reads "no prediction: unknown, not on time" — silence is never punctuality.

Everything is measured in tokens, and the maplet format compresses hard: a
rounded replay of a mission-district block costs 224 tokens. Realtime
transit boards can be decorated with live per-trip delays ("bus 433, +27s")
at whole-metro scale — the Translink SEQ feed (35 MB zip) loads inside
Node's default heap since 0.6.1.

No API key of your own needed to try: npm install supercarto, npx
supercarto mcp, or the Claude Desktop bundle from the release page
(384 KB, zero npm dependencies). Apache-2.0. TypeScript server; Python
suite; 461 tests; a TS/Python wire-parity gate that compiles a
byte-identical answer both sides.

Repo + docs: https://github.com/Unselfisheologism/supercarto
Site: https://supercarto.pages.dev

## 2. X / Twitter thread (5 posts)

1/ An AI agent that knows "Brisbane has buses" is useless at 9pm at the
corner of two of them. I built supercarto: an MCP server that hands an
agent a map as a token-budgeted graph. One call, N tokens, no more, and
the budget is on the wire. #MCP

2/ What it returns: streets as edges, crossings as junctions, POIs as
ids you can expand one at a time (`expand_feature`), indoor floors as
layers, elevation/weather/daylight/transit as separate honest tools.

3/ The thing I'm most stubborn about: honesty. No key? The traffic tool
does not exist. Feed stale? It says which service day it certified
against, not "on time". A stop with no realtime prediction is "unknown",
never "on time". Absence reads as absence.

4/ One-click install in Claude Desktop: .mcpb from the release page,
384 KB, zero npm dependencies. Or `npx supercarto mcp`. Transit at
whole-metro scale: Translink SEQ (35 MB) loads in the default heap,
750+ realtime predictions joined to boards.

5/ Apache-2.0, 461 tests, TypeScript/Python parity gate, listed on the
official MCP registry. Repo: github.com/Unselfisheologism/supercarto
Docs: supercarto.pages.dev

## 3. Reddit r/LocalLLaMA / r/LangChain (one post)

Title: supercarto — token-budgeted maps for agents (MCP, Apache-2.0, zero deps)

Body mirrors the HN post but opens with the OOM story (35 MB GTFS feed used
to need NODE_OPTIONS=--max-old-space-size=4096; since 0.6.1 the columnar
load fits the default heap and the output is byte-identical), because that
audience asks "how much memory" before "how good".

## 4. One-line pitches (drop anywhere)

- "Google Maps for AI agents, one MCP call at a time — and every answer
  fits the budget you set."
- "A map server that refuses to lie: no key, no traffic tool; no feed,
  no schedule; silence never reads as 'on time'."
- "224 tokens for a city block, 1,014 for a transit board, and the agent
  spends none of its context window guessing."

## 5. Where to submit beyond what's done

Already live: official MCP registry, npm, PyPI, HF dataset
(supercarto-bench), awesome-list PRs (TensorBlock merged), GitHub topics,
site homepage link on the repo.

Needs a login (user action or user's browsing agent): Glama (submitted,
in review), mcp.so, mcpservers.org, Smithery (needs hosted HTTP endpoint or
their account), HN, X, Reddit posting.

No-login entity worth duplicating presence on: GitHub Trending comes from
stars — consider pointing existing README visitors at the star button by
trimming the README's top to the one-liner + demo + install (measure: does
the README answer "what/try/how" inside the first screen?).

## 6. mcpservers.org submit (routes into wong2's 4.4k-star list)

wong2/awesome-mcp-servers does NOT accept PRs — its README routes every
submission through https://mcpservers.org/submit (web form; needs you).
Paste-ready:

- **Name:** supercarto
- **Repo:** https://github.com/Unselfisheologism/supercarto
- **Install:** `npx supercarto mcp` (stdio MCP; also CLI and HTTP server on the same code path)
- **Category:** Maps / Location / GTFS
- **Description:**
  Compiles the map context an agent needs around any coordinate into one
  token-budgeted YAML maplet: named landmarks with metre distances, walkable
  topology, terrain slope, keyless weather, sun position/daylight, and GTFS
  transit with routes, service windows, a next-departure board, and a
  certified one-line ride plan. Every truncation is recorded in `omitted:`,
  so a model can tell "not there" from "not shown". Apache-2.0. Docs:
  https://supercarto.pages.dev/docs (llms.txt included).

## 7. appcypher/awesome-mcp-servers (5.8k stars) — 1-click finish

Push before any retry: branch `add-supercarto` already committed on fork
`Unselfisheologism/awesome-mcp-servers-2` with the entry in Location
Services. Open the PR yourself (1 command, works regardless of API state):

```
cd /tmp && gh pr create --repo appcypher/awesome-mcp-servers --base main   --head Unselfisheologism:awesome-mcp-servers-2:add-supercarto   --title "Add supercarto to Location Services"   --body "Adds supercarto to the Location Services section, alphabetically after QGIS. Token-budgeted maplets for AI agents: walkable topology, honest omissions, transit with certified ride plans. https://supercarto.pages.dev/docs"
```

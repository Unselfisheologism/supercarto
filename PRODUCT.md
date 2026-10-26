# SuperCarto — product sheet

**One sentence.** SuperCarto fits a neighborhood's stationary spatial truths
into about one kilobyte, models score 9/9 verified recall against it, and it
tells you what it did not show.

## The problem

An agent that can answer "what is near me" today is one that burned 100k
tokens of raw geojson, or one that called a hosted map API and got back
someone else's marketing numbers. Both fail the same way: the agent cannot
tell *not there* from *not shown*, so it invents.

## The product

A compiler, a document format, and eleven MCP tools. A budget (say 1024
tokens) buys a compiled maplet of one area: named landmarks, walkable
connectivity, heat, terrain, weather, omissions recorded per layer.

The tools: `get_maplet`, `localize`, `route`, `search_places`,
`expand_feature`, `get_terrain`, `get_weather`, `get_traffic`,
`get_daylight`, `get_transit`, `get_transit_route`.

`route` answers feasibility on purpose: straight-line distance, compass
direction, then verify the approach on arrival. It does not pretend to
navigate. Turn-by-turn comes only from a routing engine the operator has
verified; none ships by default.

Transit arrives with the same refusal to pretend. `get_transit` reads a
GTFS feed and names the stops, lines, and service windows around a point;
with a realtime feed configured, predicted delays join the schedule and a
stop without a prediction reads as unknown, not on time.
`get_transit_route` certifies a plan: walk to a stop, ride one line that
serves both ends, walk it off. It never proposes an interchange, because a
feed cannot prove one, and it answers "can you be somewhere by 9" without
guessing.

## The number to check us on

[supercarto-bench](https://github.com/Unselfisheologism/supercarto-bench)
runs the same question past the same model three ways:

| | supercarto | raw GeoJSON | no map |
|---|---|---|---|
| omission / nearest / connectivity | 9/9 | ~4/9 | 0/9 |
| full certificate (scoreC) | 38/47 | 15/44 | 0/47 |

- [Live certificate](https://github.com/Unselfisheologism/supercarto-bench/blob/master/bench-results/certificate.md) — every number re-derivable from committed archives, no model calls.
- [Live leaderboard](https://github.com/Unselfisheologism/supercarto-bench/blob/master/bench-results/leaderboard.md) — per model, per arm.

Rival tools join through a one-function adapter and get the same tasks,
models and pass rules.

## Who buys

1. **Agent-framework authors** who need a spatial tool and cannot afford
   100k-token map payloads. Integration is one `npx supercarto mcp` entry.
2. **Startups shipping agents** (travel, logistics, field ops, delivery,
   local discovery) who need grounded nearby-answers and honest refusals.
3. **Enterprises** that require self-hosting, zero third-party keys, and a
   dependency tree they can read. The Python port is byte-identical to the
   TypeScript; both are audited by a CI parity gate.
4. **Map-stack vendors** who want their tool benchmarked against the
   compact-graph arm. The bench is the meeting room.

## Packaging and pricing

| Tier | What it is | Price |
|---|---|---|
| Core (now) | npm + pip packages, MCP server, CLI, compiler, formats, benchmark | Free, forever. The credibility layer does not go behind a paywall. |
| Hosted maplets (planned) | You skip the fetch-and-compile ops; compiled areas cached and served per key | Per call; discounted per area-month |
| Solver endpoint (planned) | The proven snippet answering omission/nearest/connectivity at 9/9, hosted | Per resolution |
| Enterprise (planned) | Self-host support, pinning, anonymised omission auditing, benchmark runs against your own areas | Contract |

## Self-hosting

Yes, core is open. Both ports ship the whole engine:

```bash
npm i supercarto        # TypeScript
pip install supercarto  # Python, zero runtime deps, byte-identical output
```

Data comes from OpenStreetMap via Overpass, keyless. Weather is Open-Meteo,
keyless. Traffic needs your own TomTom or HERE key, and says so out loud
when it is absent. No other accounts, no other keys.

## Honest limits

- `route` does not navigate. Feasibility is checkable; unverifiable
  turn-by-turn is a confident lie.
- A name missing from the maplet is labelled missing, not hidden. The
  omission layer is a first-class output.
- The benchmark's archived route rows are unscoreable because the reference
  router lied; the tool was demoted to match the evidence, not the market.

---
name: supercarto
description: Use when an agent needs spatial answers - what is near a coordinate, place search by name/type, walkable connectivity, straight-line distance and direction (feasibility), drive congestion, elevation/slope, weather, or daylight - as a token-budgeted compiled maplet instead of raw GeoJSON or a hosted map API. Covers the supercarto MCP server, CLI, HTTP API, and Python client, plus the honesty rules that make its answers trustworthy (omission records, "not there" vs "not shown", feasibility routing).
---

# supercarto

SuperCarto compiles one small area of the world into a **maplet**: a compact
document (YAML or binary SCR) that fits a fixed token budget and carries
stationary ground truths - named places, walkable connectivity, heat,
terrain, weather, omissions. Median cost for a city block: ~1,000 tokens.
The same area as raw GeoJSON: ~70,000.

Data comes from OpenStreetMap (Overpass) and Open-Meteo. No API keys needed
for either. No hosted account. Zero runtime dependencies (Python port).

## Set it up (pick one)

**MCP server (preferred for agents):**

```json
{
  "mcpServers": {
    "supercarto": { "command": "npx", "args": ["supercarto", "mcp"] }
  }
}
```

**CLI (one-shot answers, no server):**

```bash
npx supercarto fetch --lat 35.6833 --lon 139.762 --radiusM 400 --budget 1024 --metrics
```

**HTTP API:**

```bash
npx supercarto serve --port 8787
curl 'localhost:8787/maplet?lat=35.6833&lon=139.762&radiusM=400&budget=1500&format=yaml'
```

**Python (byte-identical to the TS engine):** `pip install supercarto`

## The core flow

1. `get_maplet(lat,lon,radius,layers,budget)` once. Read the YAML it returns.
   It is a node/edge graph: named places with types and relative positions,
   which nodes connect to which, plus heat/terrain/weather summaries.
2. Answer from the maplet. The graph encodes counts, distances and
   connectivity - you can reason about "how many cafes", "nearest place",
   "are these two places connected by walkable streets" directly from it.
3. Moving within the same area? Call `localize(scr,lat,lon,radius,layers,budget)`
   with the previous document. It returns only what changed.
4. Need exact geometry for one feature (footprint shape, precise outline)?
   `expand_feature(id)`. Use it sparingly; a full polygon is a token cost.
5. Submit your final answer in under a couple of paragraphs. Cite names and
   counts you can see. Stop listing when you reach the edge of the maplet.

## The nine tools

| Tool | When to call |
| --- | --- |
| `get_maplet(lat,lon,radius,layers,budget)` | Starting point. Everything near a point, under a token budget. |
| `localize(scr,lat,lon,radius,layers,budget)` | You already have a maplet and the user moved. Cheap delta. |
| `route(from,to,mode)` | How far between two coordinates and which way to head. See the routing rule below. |
| `search_places(lat,lon,radius,query,limit)` | Find by name or type inside the current snapshot. |
| `expand_feature(id)` | Exact geometry for one feature you can already see. |
| `get_terrain(lat,lon,radiusM,samples)` | Ground elevation and slope. |
| `get_weather(lat,lon,hours)` | Current conditions and forecast. |
| `get_traffic(from,to,mode)` | Drive congestion and realistic arrival time. |
| `get_daylight(lat,lon,at)` | Sun position, sunrise/sunset, "does the walker need a light". |
| `get_transit(lat,lon,radiusM,budget)` | Stops, lines, service windows around a point, from the configured GTFS feed. With a realtime feed set, predicted delays join; a stop with no prediction is unknown, not on time. |
| `get_transit_route(fromLat,fromLon,toLat,toLon,maxWalkM,budget)` | A certified one-line ride plan between two points: walk, ride, walk. Refuses to invent an interchange or certify an uncertifiable day; the note names the leg that failed. |

## Budget discipline

- `budget` is a **token cap**, not a hint. Default `1024` covers most
  walk-scale questions in a district-sized neighborhood. Use `512` when the
  prompt is already long; `4096` when the user asks something like "map the
  whole neighborhood in detail".
- A smaller budget trades named places for coverage. The maplet records the
  trade in an omission line (`Incomplete: N features omitted to fit budget`).
  Never guess past it; say the known part and note the gap.
- `layers` is optional. Leave it unset and the compiler picks its default
  selection; pass layer names only when the question clearly needs a subset.

## Honesty rules (the part that makes the answers trusted)

The maplet distinguishes **"not there"** from **"not shown"**. Both look like
absence to a model that was not paying attention. The rules:

1. If a feature has a name in the maplet, you may state it. If a place you
   expected is absent, say "not shown at this budget" when the
   omission line says the budget cut features, and "not in the data" when the
   maplet claims completeness.
2. Never invent a place name. Adding one is the failure mode this tool
   exists to prevent. If the user asks about a place not in the data, say so
   plainly and offer the nearest named substitutes.
3. **Routing is feasibility, not navigation.** `route` returns straight-line
   distance, the initial compass direction, and ends with "then verify the
   approach on arrival". Pass that instruction through to the user. Do not
   narrate fake turn-by-turn steps ("turn left on Oak") - the tool computed
   two points and a distance, nothing more.
4. **Traffic needs a key.** With no TomTom/HERE key configured, traffic
   answers are labelled free-flow estimates. Say so, or skip the ETA.
5. **Weather can degrade.** When a cell is unavailable the tool flags it as
   unknown. Report the flag, not a confident number.
6. **Counts are exact.** The maplet does not round. If you say "about 7
   cafes" when the map shows exactly 7 listed plus an omission of 3 POIs,
   phrase it as "7 on the map, 3 places omitted by budget".

## Session behavior

- `get_maplet` opens a session document implicitly; pass the same document
  back into `localize` to move within it. `localize` re-cuts the map with
  per-axis scale correction and returns only the delta, so a viewer walking
  a district stays cheap.
- Crossing the antimeridian is handled. Do not special-case longitudes near
  ±180°.
- The session envelope is checked server-side; points outside the open area
  are refused rather than half-answered.

## CLI quick reference

```bash
npx supercarto fetch --lat LAT --lon LON --radiusM R --budget B --metrics  # compiled maplet
npx supercarto weather --lat LAT --lon LON --hours 12
npx supercarto route --from LAT,LON --to LAT,LON --mode walk   # walk|bike|drive
npx supercarto traffic --from LAT,LON --to LAT,LON             # needs key
npx supercarto compile area.geojson --budget 1024 --metrics     # local file -> maplet
npx supercarto encode area.geojson --out area.scr              # binary SCR
npx supercarto bench area.geojson                              # token-cost check
npx supercarto mcp                                             # stdio MCP server
npx supercarto serve --port 8787                               # HTTP
```

## If something fails

- No internet: the maplet compiles only from local data. Say so rather than
  passing an offline answer off as live.
- A tool errors (rate limit, proposal timeout): retry once, then report the
  failure and answer from whatever partial context you hold, labelled as
  partial.
- Hearing "No map data" in a prompt: that arm is the user explicitly asking
  what you can do without a map. Say what you cannot know instead of
  guessing city layouts.

## Verified, not claimed

[The benchmark](https://github.com/Unselfisheologism/supercarto-bench) gives
the same model the same spatial question as compiled maplet vs raw GeoJSON
vs no map: 9/9 on omission/nearest/connectivity for the maplet, ~4/9 raw,
0/9 none - at ~1/70th the tokens. If you build a rival map surface, the
benchmark accepts adapter arms from any repository.

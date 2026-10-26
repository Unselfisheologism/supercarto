# supercarto - LLM-native spatial middleware

> Compiles geospatial data into token-budgeted topological graphs that an AI
> agent can reason over directly.

Agent links: [npm](https://www.npmjs.com/package/supercarto) |
[GitHub](https://github.com/Unselfisheologism/supercarto) |
[Survey](/blog/maps-for-ai-agents-2026) |
[Transit in 0.5.0](/blog/get-transit-gtfs-schedules-for-agents) |
Apache-2.0

## Install

```
npm install supercarto
pip install supercarto
```

Claude Desktop user? Every release ships a one-click
[`.mcpb` bundle](https://github.com/Unselfisheologism/supercarto/releases/latest)
— 384 KB, zero npm dependencies, optional weather and transit configuration
at install time. [How the format works](/blog/one-click-mcp-install-claude-desktop).

Or try it hosted — no install. The endpoint compiles real maplets over HTTP,
and says plainly what it cannot serve:
[`supercarto-compile.jeffrinjames99.workers.dev`](https://supercarto-compile.jeffrinjames99.workers.dev/).
Transit needs a local feed, traffic needs a licence, and the maplet falls
back to a hosted planet extract because the shared Overpass instances refuse
this deployment's datacenter egress.

## Give it coordinates

Real OpenStreetMap data, fetched live, compiled into a graph an agent can
navigate. No API key, no tile archive, any point on earth.

```ts
import { SuperCarto } from 'supercarto';

const carto = new SuperCarto();

const result = await carto.maplet({
  lat: 35.6833,
  lon: 139.7620,
  radiusM: 400,
  budget: 1500,
});

console.log(result.yaml);
```

The result is plain YAML: nodes, edges with distances in metres and compass
directions, a record of what was left out, and the tools the agent can call
next.

```yaml
map:
  center: "35.6833, 139.762"
  radius: 400m
nodes:
  n186: {type: transit, name: 新橋駅(3), tags: [subway_entrance]}
edges:
  n1->n2: {dist: 120m, dir: east, path: road}
omitted:
  - {layer: feature, count: 1754}
tools:
  - expand_node(id)
  - route(from,to,mode)
```

## Measured, not claimed

Same questions, same models, same places. The only variable is what sits in
the context window: a compiled supercarto graph, raw GeoJSON, or no map at
all. Scripts, scoring, and raw answer archives are public and re-derivable —
no model calls needed to verify the score.

| Context | Score | Note |
| --- | --- | --- |
| supercarto graph | **38/47** | Token-budgeted topological YAML |
| Raw GeoJSON | 15/44 | 25x more tokens, worse answers |
| No map | 0/47 | The model invents places |

[Full certificate](https://github.com/Unselfisheologism/supercarto-bench/blob/master/bench-results/certificate.md) ·
[Leaderboard](https://github.com/Unselfisheologism/supercarto-bench/blob/master/bench-results/leaderboard.md)

## What it does

- **Token budget.** Named landmarks survive, anonymous intersections go
  first, and the surviving network stays connected.
- **Honest omissions.** Every drop is recorded in `omitted:`, so the model
  can tell "not there" from "not shown".
- **Weather.** Current conditions and an hourly forecast with no key. If the
  source is down it says so instead of returning zeroes.
- **Traffic.** Live with a TomTom or HERE key. Without one it reports
  free-flow and labels it as such.
- **Indoor floors.** Floor-by-floor graphs with lifts collapsed into one
  vertical link.
- **Transit schedules.** Stops, lines and first/last departures from any
  GTFS feed, built into the same map. Three honest service states: running,
  none, unknown — so an agent can answer "can you be somewhere by 9" without
  guessing.
- **Live transit delays.** Point it at an agency's GTFS-Realtime TripUpdates
  feed and predictions join the schedule: a stop with no prediction reads as
  unknown, not on time.
- **Departure board.** Each stop lists the next departures in feed order and
  the feed's own clock, capped and counted — "what comes next" answered
  where the schedule is.
- **Certified ride plan.** `get_transit_route` walks to a stop, rides one
  line that serves both ends, and walks it off. Certified against the
  service day; never an interchange a feed cannot prove.
- **MCP.** Works as an MCP tool server for agents.

## Data sources

| Source | Use |
| --- | --- |
| Overpass | Default map data, for development |
| PMTiles / Protomaps | Production map data |
| OSRM | Walk, bike and drive routing |
| Open-Meteo | Weather, no key |
| TomTom / HERE | Live traffic, key required |
| Terrarium tiles | Elevation and slope, no key |
| GTFS feed | Stops, lines and schedules; SUPERCARTO_GTFS or `?feed=` |
| GTFS-Realtime | Live delay predictions; SUPERCARTO_GTFS_RT, no key |

---

supercarto is open source under Apache-2.0. Full documentation:
https://supercarto.pages.dev/docs

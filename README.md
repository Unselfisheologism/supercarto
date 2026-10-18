# supercarto

**LLM-native spatial middleware.** Compiles geospatial data into token-budgeted
topological graphs that an AI agent can reason over directly.

Give an agent a map without paying the token tax. One file in, both numbers
out: examples/synthetic-dense.geojson is 272,993 bytes (~68,000 tokens) raw
and compiles at a 1024-token budget to about 890 tokens - 26 nodes
(10 named) on 34 edges (streets plus access links), ~99% smaller.
Rerun it yourself: `supercarto compile examples/synthetic-dense.geojson
--budget 1024`. Token counts are character-based estimates on a fixed test
file; the sun and timestamp lines shift them by a few tokens run to run.

```bash
npm install supercarto
pip install supercarto      # Python client, talks MCP over stdio
```

---

## Give it coordinates

This is the whole product:

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

The same file from the headline, compiled below (truncated output;
warnings travel inside the map, where an agent reading only the map sees them):

```yaml
map:
  center: "37.7749, -122.4194"
  source: geojson
  note: Simplified for reasoning; call expand_feature for exact geometry.
nodes:
  n530: {type: poi, name: Bank 0, tags: [bank]}
  n531: {type: poi, name: Cafe 1, tags: [cafe]}
  n673: {type: transit, name: Station 0, tags: [subway_entrance]}
edges:
  n515->n516: {dist: 80m, dir: east, path: road}
  n516->n517: {dist: 80m, dir: east, path: road}
omitted:
  - {layer: building, count: 259}
  - {layer: poi, count: 141}
  - {layer: road, count: 441}
tools:
  - expand_feature(id)
```

That is about 890 tokens for the whole extract at a 1024 budget: every drop named
by layer, nothing silently vanished.

---

## The problem

You want an agent to know where things are and how to get between them. Three
options, all bad:

- **Paste GeoJSON into the prompt.** Thousands of tokens per block. The model
  reasons badly about raw coordinates and will hallucinate them.
- **Call a map API.** You get back the same GeoJSON. The token cost is
  unchanged; only the HTTP round trip differs.
- **Invent a compact wire format and teach the model to read it.** A novel
  grammar in a context window produces hallucinated coordinates and tokens
  burned inferring the grammar. A model was not trained on your format.

supercarto takes the third option seriously and solves it the only way it can be
solved: **the model never reads the wire format.**

```
  coordinates          live sources             reasoning format
  35.68, 139.76  ──▶  Overpass / PMTiles  ──▶  topological YAML graph
                                           distances in metres,
                                           compass directions,
                                           built for models
```

The wire format is a spec you own, optimized for machines. The reasoning format
is standard YAML in flow style, using only constructs a model has read billions
of times. A deterministic compiler in the middleware does the translation.

---

## An agent works for a person

The person is standing outside. Rain and traffic change whether the trip happens
at all, so those are first-class layers here, not an afterthought bolted onto a
routing engine.

### Weather

No API key. No account. No billing.

```ts
const w = await carto.weatherAt(35.6833, 139.7620, 12);

w.now.summary;          // "heavy rain"
w.now.precipitation;    // "rain" | "snow" | "sleet" | "hail" | "drizzle"
w.now.feelsLikeC;       // what they actually feel
```

```
$ supercarto weather --lat 35.6833 --lon 139.762
now  clear night, 23.2C (feels 26.9C), wind 4.3km/h, precip none
  2026-10-01T13:00:00Z  22.7C  none      3.5km/h
  2026-10-01T14:00:00Z  22.1C  none      3.1km/h
```

The MCP tool returns prose rather than fields, because a model repeats "it is
raining, take the bus" reliably and re-derives it from twelve numbers
unreliably.

When the source is unreachable it returns `NaN` for every reading and sets
`degraded`, and the tool raises. It does not return zeroes. An agent handed
`precipitationMm: 0` concludes the weather is dry and sends someone cycling into
a storm.

### Traffic

```ts
const t = await carto.routeWithTraffic({ from, to, mode: 'drive' });

t.freeFlowOnly;   // true when no flow credential is configured
t.worstLevel;     // "severe" - the segment that makes someone late
t.delayS;
```

Traffic needs a credential, so `get_traffic` is **absent from the tool list**
until you set one. With no key the routing path reports free-flow and labels it:

```
$ supercarto traffic --from 37.7749,-122.4194 --to 37.7849,-122.4194
traffic: unknown (no flow source configured)
free-flow estimate: 244s, ignores congestion
note: set TOMTOM_API_KEY or HERE_API_KEY for live conditions
```

A free-flow estimate for a congested route is worse than no answer, because the
person leaves on the schedule the agent gave them. Presenting one as live is the
single most damaging thing this library could do, so it does not.

Set `TOMTOM_API_KEY` or `HERE_API_KEY` and it becomes live, reporting the worst
segment rather than an average.

### Indoor floors

Nobody else publishes this. Google builds indoor maps for its own users and has
no reason to hand a third-party agent a clean floor-by-floor graph; Mapbox has
nothing comparable; every MCP wrapper returns the same flat GeoJSON.

```yaml
indoor:
  storeys: 0,1,2
  multi_storey: true
  0: {label: ground, rooms: 12}
    L0n1: {type: corridor}
    L0n2: {type: shop, name: "Blue Bottle"}
    L0n1->L0n2: {dist: 11m}
  v1: {type: lift, levels: [0,1,2], wheelchair: true}
  missing: [1]
```

Lifts are collapsed across storeys into one vertical link. Rooms only connect to
corridors **on the same floor** — an edge through a concrete slab would send
someone through a floor. A room more than 40m from any corridor is left
unattached, because a straight line through intervening walls is worse than no
edge. Untagged storeys are reported as `missing` rather than invented.

---

## The budget is a real budget

Most map-for-agents code truncates and hopes. supercarto treats truncation as a
correctness problem:

- **Ranking.** Named landmarks survive; anonymous intersections are cut first.
- **Connectivity.** Cut vertices are never removed, so the surviving network
  stays connected. A map the agent can traverse but not connect is worse than a
  smaller map it can use.
- **No stranded names.** A landmark the agent can see but cannot route to is
  removed. It would confidently try to walk to it.
- **Verification.** `emitAndVerify` re-measures the actual emitted YAML and cuts
  again until it fits. The reported budget is the budget delivered, not an
  estimate.
- **Honesty.** Every drop is recorded in `omitted:`, aggregated per layer, so
  the model can tell "not there" from "not shown".

---

## The benchmark

Lives in its own repo now:
[supercarto-bench](https://github.com/Unselfisheologism/supercarto-bench).

Same question, same model, same map — the only variable is what sits in
the context window: compiled graph vs raw GeoJSON vs nothing. Raw runs,
frozen test maps, and the scoring code all live there, so anyone building
a rival map tool can run the same test and try to beat the score.

Current headline there: 9/9 for the compact graph against ~4/9 raw and 0/9
with no map, on two AI models. Route questions are unmeasurable (the public
test router gives impossible answers) — stated, not hidden.

The score now ships with its own reproduction recipe (`scoreC certificate`,
re-derived from raw answer archives without model calls), a per-model
leaderboard, and adapter arms: a rival tool registers itself with a single
`{ name, prepare }` module and gets the same tasks, models and pass rules.
The current certificate: supercarto 36/44 · geojson 14/41 · none 0/44
across every archived run.

What this repo keeps is a quick token-cost check:

```bash
npx supercarto bench <file.geojson>
```

---

## Data sources

| Source | Status | Use |
|---|---|---|
| **Overpass** | default | Development. 15-40s per call, rate limited. |
| **PMTiles / Protomaps** | `SUPERCARTO_PMTILES` | **Production.** Range requests against object storage, milliseconds, no rate limit. |
| **OSRM** | default | Turn-by-turn routing, walk/bike/drive. |
| **Open-Meteo** | default | Weather. No key. |
| **TomTom / HERE** | key required | Live traffic. |
| **Terrarium tiles** | default | Elevation and slope. No key. |

```bash
export SUPERCARTO_PMTILES=https://your-bucket/planet.pmtiles
```

PMTiles is the answer at production volume. The reader is included — no `pmtiles`
dependency, no `mapbox-gl`, zero transitive packages.

Everything is read from the environment by one factory, so the CLI and the MCP
server cannot disagree about where data came from. They did once, and nothing
reported it.

```
SUPERCARTO_PMTILES      PMTiles archive URL; primary source when set
OVERPASS_ENDPOINT       your own Overpass instance
TERRARIUM_ENDPOINT      elevation tile template
TOMTOM_API_KEY          enables get_traffic
HERE_API_KEY            enables get_traffic
SUPERCARTO_NO_TERRAIN   disable elevation
SUPERCARTO_NO_WEATHER   disable weather
```

---

## Agent integration

### MCP

```json
{
  "mcpServers": {
    "supercarto": { "command": "npx", "args": ["supercarto", "mcp"] }
  }
}
```

Seven tools: `get_maplet`, `route`, `search_places`, `expand_feature`,
`get_daylight`, `get_terrain`, `get_weather`, plus `get_traffic` when a key is
present. Each maplet lists exactly the tools that deployment can answer, so an
agent never calls one that cannot work. `get_daylight` is always available: sun
position is arithmetic, needing no source and no credential.

### What a maplet says about a place

Beyond topology and distance, a node can carry the facts that decide whether a
trip is worth making:

```yaml
n3: {type: poi, name: Blue Bottle, tags: [cafe], hours: 07:00-18:00, brand: Blue Bottle}
n4: {type: poi, name: Central Rx, tags: [pharmacy], hours: 09:00-17:00}
map:
  sun: up, elevation: 43.4deg, twilight: day, azimuth: 22deg, sunrise: "..."
```

Both shops above are open at 12:00 local. At 04:00 the same two read
`hours: closed`, because their hours are known and they are shut. A bench with
no recorded hours emits no `hours` field at all.

`hours` is evaluated against an instant and evaluated in the **map's** timezone,
not the server's. Three states, never two: a time range, `closed`, or absent
because nobody recorded it. Absent is deliberately not `closed` — those lead to
opposite advice, one means go and find out, the other means go elsewhere.

`twilight` is `day`, `civil`, `nautical`, or `night` rather than a boolean,
because the three lead to different decisions: walking is fine at civil
twilight and unwise at nautical. Above the Arctic circles in summer and winter
the map reports `polar: day` or `polar: night` instead of inventing a sunrise.

Pass `compile.utcOffsetMinutes` and `compile.now` to fix both to a known place
and instant, which is what the tests do.

### Python

```python
import asyncio
from supercarto import SuperCarto

async def main():
    async with SuperCarto() as carto:
        m = await carto.maplet(lat=35.6833, lon=139.7620, radius_m=400, budget=1500)
        print(m.yaml)
        w = await carto.weather(lat=35.6833, lon=139.7620)

asyncio.run(main())
```

Zero runtime dependencies. It speaks JSON-RPC to the Node server over stdio
rather than importing an SDK, because the `mcp` package pulls in httpx and
pydantic and an agent framework that already depends on one of them should not
get a second copy.

### HTTP

```bash
curl 'localhost:8787/maplet?lat=35.6833&lon=139.762&radiusM=400&budget=1500&format=yaml'
```

---

## CLI

```bash
supercarto fetch --lat 35.6833 --lon 139.762 --radiusM 400 --budget 1500 --metrics
supercarto weather --lat 35.6833 --lon 139.762 --hours 12
supercarto traffic --from 37.7749,-122.4194 --to 37.7849,-122.4194
supercarto route --from 37.7749,-122.4194 --to 37.7849,-122.4194 --mode walk
supercarto mcp
supercarto serve --port 8787
supercarto compile city.geojson --budget 1024 --metrics
supercarto encode city.geojson --out city.scr
supercarto decode city.scr
supercarto bench city.geojson
```

`fetch` layers accept `road` and `poi` alongside raw OSM tags; anything
else is rejected rather than silently returning nothing. A request that
would yield named places with no streets fails with a clear error instead
of a misleading map — pass `--layers poi` for a POI-only map. Warnings
travel inside the map output, not just stderr, so agents see them.

---

## Accuracy

Distances are verified against haversine ground truth at mid and high latitude:

- 0.11% error at San Francisco (37.77°N)
- 0.11% error at Oslo (59.91°N)

This required getting the Web Mercator scale correction right: mercator distances
exceed ground distance by `1/cos(latitude)` on both axes, and getting the sign
wrong produces a 26% error at mid latitude that compounds toward the poles. A
mean isotropic scale is also wrong for a non-square bbox, so the scale is applied
per axis.

The benchmark task set spans 64°N to 33°S deliberately. A benchmark run only at
37°N measures one case and hides every sign error toward the poles.

---

## Status

282 tests passing: 162 unit, 111 against live OpenStreetMap, and 9 MCP end-to-end.
Verified against live OpenStreetMap, live Open-Meteo, and the live MCP server
driven from Python.

Implemented: SCR codec (text and binary, delta geometry, ring groups, three heat
encodings, omissions, routes, refs), Web Mercator with per-axis scale correction,
Visvalingam-Whyatt simplification, GeoJSON ingestion with OSM classification,
topology compilation with junction welding and landmark attachment, token
budgeting with connectivity guarantees, YAML emission, **indoor floor graphs
with vertical circulation**, **place-density heatmaps**, live Overpass, **PMTiles
with a built-in MVT decoder**, OSRM turn-by-turn routing, **keyless weather with
a degraded path that refuses to invent readings**, **traffic with an honest
free-flow fallback**, terrain elevation and slope, MCP over stdio, HTTP API, CLI,
a Python client, and a **task-level benchmark with OSRM ground truth**.

Not implemented: hosted vector tiles with style delivery, and full indoor room
geometry beyond centroids.

---

## License

Apache-2.0
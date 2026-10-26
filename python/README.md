# supercarto (Python)

mcp-name: io.github.Unselfisheologism/supercarto

LLM-native spatial middleware for Python. Give an AI agent a map of any
location on earth as a token-budgeted topological graph it can reason over.

```bash
pip install supercarto
```

Two surfaces, one package, no runtime dependencies:

- **Native core** — pure Python with no Node. The compile path (GeoJSON in,
  token-budgeted topological YAML out, with the same honesty invariants as the
  Node library: the omission ledger, connectivity guarantees, and a budget that
  is verified against the emitted bytes) **and** the live sources it feeds on:
  Overpass for OSM data, Open-Meteo for weather, OSRM for turn-by-turn routing —
  all over `urllib`, all keyless, still zero dependencies — **plus the SCR wire
  codec** (`scr` field, `from_scr()` round-trips), **indoor floors** (per-storey
  room graphs with lift/stairs vertical links), **traffic flow providers**
  (TomTom/HERE, key-optional), and **PMTiles/MVT** (vector tile archives over
  HTTP range requests or local files).
- **stdio client** — for MCP-style integration with the Node server; the native
  core now covers everything the server's compile and source layers can do, so
  the client is an alternative interface rather than a missing-feature stopgap.
  See [the client](#use).

The native core is ported stage by stage with **byte-level output parity
against the TypeScript as the gate per stage** (`scripts/parity/` in the repo).
The gate covers the full offline pipeline (projection, ingest with OSM
classification, topology compilation, opening-hours grammar, solar position,
token budget, YAML emission), the SCR wire bytes per fixture, the live path
replayed against recorded service responses, and PMTiles/MVT end-to-end: both
sides build a spec-written archive independently and must agree on the header,
directory, decoded MVT, fetched features and the compiled YAML.

```python
from supercarto import compile_file

r = compile_file("city.geojson", budget=1024)
print(r["yaml"])
print(r["metrics"]["tokens"], "tokens")
```

`to_maplet(features_dict, budget=512)` works straight from dicts parsed off an
API, and rejects nothing that the Node path accepts for offline input.

## Native live service

Sync (no event loop), keyless, zero dependencies.

```python
from supercarto.live import SuperCarto

carto = SuperCarto()  # Overpass + Open-Meteo + OSRM by default
m = carto.maplet(37.7599, -122.4142, radius_m=400, budget=1500)
print(m["yaml"])          # budget-verified YAML, same shape as the Node server
print(m["fetchedFrom"], m["fetchMs"], m["sourceTruncated"])

route = carto.route({"from": {"lat": ..., "lon": ...}, "to": {...}, "mode": "walk"})
route["route"].steps[0].instruction   # "turn right onto 19th Street" prose

weather = carto.weather_at(37.7599, -122.4142, 12)
weather["now"]["summary"]             # "heavy rain", or NaN + "degraded" when unreachable

# Live congestion, only when a flow provider has a credential — otherwise a
# labelled free-flow estimate (`freeFlowOnly: true`), which is the difference
# between a useful answer and a confidently wrong ETA.
traffic = carto.route_with_traffic({"from": {"lat": ..., "lon": ...},
                                    "to": {...}, "mode": "drive"})
traffic["level"], traffic["worstLevel"], traffic["delayS"]
```

Traffic and PMTiles sources are injectable the same way everything else is:

```python
from supercarto.traffic import TomTomFlow, HereFlow
from supercarto.protomaps import ProtomapsSource
from supercarto.live import SuperCarto

carto = SuperCarto(
    sources=[ProtomapsSource("https://example.com/city.pmtiles", max_zoom=14)],
    tomTom={"api_key": "…"},        # or TOMTOM_API_KEY / TRAFFIC_API_KEY environment
    here={"api_key": "…"},          # or HERE_API_KEY
    elevation=...,                  # optional; omitted maplets carry no slope layer
)
```

PMTiles/MVT notes: `ProtomapsSource` reads local files or any `http(s)` URL with
the same range-request logic, accepts `max_zoom`, `max_tiles` and `layers`
filters, and reports the area as incomplete when the tile cap bites — an agent
told a map is complete will route across a gap it cannot see.

Sources are injectable for tests and self-hosting: pass
`overpass={"endpoint": "https://my.overpass.local/api/interpreter"}`,
`openMeteo={"endpoint": ...}`, `router=OsrmRouter(endpoint=...)`, or your own
`fetch`-shaped callables (`overpass={"fetch": ...}`). Elevation comes via
`elevation=TerrariumElevation(...)` once configured; without it the maplet
simply carries no slope layer.

The honesty invariants carry over: a rate-limited shared Overpass degrades to a
smaller box before failing loudly, an unreachable weather source reports
"unknown" instead of invented sunshine, and a routing failure falls back to a
route labelled `walk-approx`, never presented as real turns.

**Live sources need no Node anymore.** Node is still required for the stdio
client below.

```bash
npm install -g supercarto     # or: npx supercarto mcp
```

---

## Use (stdio client)

```python
import asyncio
from supercarto import SuperCarto

async def main():
    async with SuperCarto() as carto:
        m = await carto.maplet(lat=35.6833, lon=139.7620, radius_m=400, budget=1500)
        print(m.yaml)
        print(f"{m.tokens} tokens, from {m.fetched_from}")

asyncio.run(main())
```

```
map:
  center: "35.6833, 139.762"
  radius: 400m
nodes:
  n8: {type: transit, name: 芝浦ふ頭, tags: [station]}
edges:
  n1->n2: {dist: 120m, dir: east, path: road}
omitted:
  - {layer: feature, count: 1754}
```

The budget holds. The server measures its own output and cuts until it fits, so
`m.tokens` will not exceed `m.budget`.

### Routing

```python
r = await carto.route(37.7749, -122.4194, 37.7849, -122.4194, mode="walk")

r.distance_m, r.duration_s
r.steps  # ["1. head onto Mission St (120m)", ...]
r.source # "osrm", or "straight-line" for the labelled approximation
```

### Weather

No API key needed.

```python
w = await carto.weather(35.6833, 139.7620, hours=12)

w.summary          # "heavy rain"
w.precipitation    # "rain" | "snow" | "sleet" | "hail" | "drizzle"
w.feels_like_c     # what a person actually feels
w.advisory         # prose, in the vocabulary of the decision
```

### Traffic

Needs `TOMTOM_API_KEY` or `HERE_API_KEY` in the environment.

```python
t = await carto.traffic(37.7749, -122.4194, 37.7849, -122.4194)

if t.free_flow_only:
    # No credential. The duration ignores congestion entirely. Do not quote it
    # as an arrival time.
    ...

t.worst_level  # the segment that actually makes someone late
```

`traffic()` raises `ToolError` when no credential is configured. That is on
purpose: a free-flow number returned as if it were live is the failure this
library exists to avoid.

### Checking what is available

```python
tools = await carto.tools()
```

Worth doing before a loop. `get_traffic` is **absent** unless a flow credential
is present, and `get_weather` is **present** by default because its source needs
no key. A maplet lists exactly the tools this deployment can answer.

---

## In an agent framework

Any MCP client works; this package is for when you want the typed results.

```python
# LangChain-style MCP config
{
    "mcpServers": {
        "supercarto": {"command": "npx", "args": ["supercarto", "mcp"]}
    }
}
```

---

## Configuration

Read from the environment by the server, so nothing is needed on the Python side.

```
SUPERCARTO_PMTILES      PMTiles archive; the production data source
OVERPASS_ENDPOINT       your own Overpass instance
TOMTOM_API_KEY          enables live traffic
HERE_API_KEY            enables live traffic
```

Point at a specific binary with `SUPERCARTO_SERVER_CMD`, or pass `command=[...]`
to the constructor. A relative or absolute path both work:

```python
carto = SuperCarto(command=["node", "/opt/sc/dist/cli/main.js", "mcp"])
```

---

## Errors

| Exception | Meaning |
|---|---|
| `SuperCartoConnectionError` | The server could not start or did not respond. Your problem. |
| `ToolError` | The tool ran and reported a failure. Usually a real answer, like "traffic is not configured". |

They are deliberately distinct. Conflating them would make a retry loop hammer
a server that is behaving correctly.

---

## Zero dependencies

This package has no runtime dependencies, on purpose.

The `mcp` SDK pulls in httpx, pydantic, and their transitive trees. An agent
framework that already depends on any of those should not get a second copy at a
different version. Three JSON-RPC methods and one line-delimited framing are
small enough to implement directly, which is what `client.py` does.

The trade: `pip install supercarto` does not bring Node with it. Calling anything
raises a `SuperCartoConnectionError` that says so, with the fix, in one sentence.

---

## Links

- **npm:** https://www.npmjs.com/package/supercarto
- **Repository:** https://github.com/Unselfisheologism/supercarto
- **Benchmark:** https://github.com/Unselfisheologism/supercarto/blob/master/docs/benchmark.md

Apache-2.0

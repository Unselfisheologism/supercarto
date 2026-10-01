# supercarto (Python)

LLM-native spatial middleware for Python. Give an AI agent a map of any
location on earth as a token-budgeted topological graph it can reason over.

```bash
pip install supercarto
```

This package is a **client**. The map compilation, token budgeting, topology
work, and indoor graph live in the Node library, and this speaks MCP to it over
stdio. That is deliberate: those algorithms are the product, and a second
implementation in a second language would be a second thing to keep correct.

**Node 20 or newer is required to call anything.** `pip install` alone will
succeed; the error when you call will tell you exactly what to install.

```bash
npm install -g supercarto     # or: npx supercarto mcp
```

---

## Use

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
- **Repository:** https://github.com/supercarto/supercarto
- **Benchmark:** https://github.com/supercarto/supercarto/blob/main/docs/benchmark.md

Apache-2.0
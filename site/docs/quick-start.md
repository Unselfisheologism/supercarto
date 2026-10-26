---
title: Quick start
description: Install supercarto, return your first maplet, and wire it into an agent — Node, Python, Claude Desktop, or the hosted endpoint.
sidebar:
  label: Quick start
  order: 1
---

supercarto needs Node.js 20+ (server) and nothing else: zero runtime npm
dependencies, no database, no API key. A coordinate and a token budget are
the whole interface.

**npm**

```package-install
npm install supercarto
```

**pip**

```package-install
pip install supercarto
```

The Python client speaks JSON-RPC to the Node server over stdio rather
than importing an SDK, so it carries zero runtime dependencies of its
own.

**npx (no install)**

```package-install
npx supercarto mcp
```

**Claude Desktop**

Download the [latest release
bundle](https://github.com/Unselfisheologism/supercarto/releases/latest)
and open the `supercarto-X.Y.Z.mcpb` file with Claude Desktop — one
click, and the tools install with optional configuration
(weather key, GTFS feed path). The bundle is 384 KB.

## Your first maplet

```ts lineNumbers
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

`result.yaml` is a standard-YAML topological graph: named nodes, edges with
distances in metres and compass directions, an `omitted:` record of
everything cut, and the tools the agent can call next. The same answer, from
the CLI:

```bash
supercarto fetch --lat 35.6833 --lon 139.762 --radiusM 400 --budget 1500 --metrics
```

## Turn it into an MCP server

The one process answers MCP over stdio:

```bash
npx supercarto mcp
```

Standard `mcpServers` configuration for any MCP client:

```json
{
  "mcpServers": {
    "supercarto": { "command": "npx", "args": ["supercarto", "mcp"] }
  }
}
```

## Like it as a bundle instead?

One-click Claude Desktop install, install-time keys, and the honest
"tools_generated" manifest are covered in [MCP and Claude Desktop](/docs/interfaces/mcp).

Eight tools advertise out of the box (`get_maplet`, `localize`, `route`,
`search_places`, `expand_feature`, `get_terrain`, `get_weather`,
`get_daylight`). Three more appear only when their configuration exists —
see [the tools](/docs/tools).

## Deployment surfaces

**[CLI](/docs/interfaces/cli)**

fetch, weather, traffic, transit, route, compile, encode, decode, bench, mcp, serve.

**[HTTP API](/docs/interfaces/http)**

The same tools as GET endpoints, YAML or JSON. Boots locally with `supercarto serve`.

**[Python client](/docs/interfaces/python)**

asyncio client over stdio; zero runtime dependencies.

**[Cloudflare Worker](/docs/guides/deployment)**

Hosted compile path with rate limiting and ODbL attribution — and a stated, honest subset.

---
title: CLI
description: Every supercarto command, from fetch to decode, with the flags each one takes.
sidebar:
  label: CLI
  order: 0
---

The CLI runs the same library as the MCP server. One binary, every surface:

| Command | What it does |
| --- | --- |
| `supercarto fetch --lat --lon --radiusM --budget` | compile a maplet; `--layers` filters; `--metrics` reports tokens |
| `supercarto weather --lat --lon --hours` | forecast |
| `supercarto traffic --from --to` | traffic or the labelled free-flow answer |
| `supercarto transit --feed --lat --lon --radiusM` | departure boards from a GTFS feed |
| `supercarto route --from --to --mode` | feasibility answer |
| `supercarto compile <file.geojson> --budget` | compile a local GeoJSON into a maplet |
| `supercarto encode <file.geojson> --out` | SCR codec to a compact file |
| `supercarto decode <file.scr>` | back from SCR |
| `supercarto bench <file.geojson>` | token-cost check |
| `supercarto mcp` | MCP server over stdio |
| `supercarto serve --port` | HTTP API |

**maplet**

```bash
supercarto fetch --lat 35.6833 --lon 139.762 --radiusM 400 --budget 1500 --metrics
```

**transit**

```bash
supercarto transit --feed city-gtfs.zip --lat 36.913 --lon -116.77 --radiusM 3000
```

**traffic**

```bash
supercarto traffic --from 37.7749,-122.4194 --to 37.7849,-122.4194
```

**weather**

```bash
supercarto weather --lat 35.6833 --lon 139.762 --hours 12
```

:::note[Failure behavior]
`fetch` layers accept `road` and `poi` alongside raw OSM tags; anything
else is rejected rather than silently returning nothing. A request that
would yield named places with no streets fails with a clear error —
pass `--layers poi` for a POI-only map. Warnings travel inside the map
output, not just stderr, so an agent that reads only the map sees them.
:::

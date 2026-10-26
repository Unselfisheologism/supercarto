---
title: Data sources
description: Where every layer gets its data — env-controlled, one factory, honest fallbacks.
sidebar:
  label: Data sources
  order: 0
---

Everything is read from the environment by one factory, so the CLI and the
MCP server cannot disagree about where data came from — they did once, and
nothing reported it.

| Source | Status | Configure |
| --- | --- | --- |
| Overpass | default | `OVERPASS_ENDPOINT` (your own instance for volume) |
| PMTiles / Protomaps | opt-in, then primary | `SUPERCARTO_PMTILES=https://your-bucket/planet.pmtiles` |
| OSRM | opt-in for turn-by-turn | point the env at an engine you host and have verified |
| Open-Meteo | default | key optional: `SUPERCARTO_OWM_KEY` |
| TomTom / HERE | key required | `TOMTOM_API_KEY` / `HERE_API_KEY` |
| Terrarium tiles | default | `TERRARIUM_ENDPOINT` |
| GTFS feed | opt-in | `SUPERCARTO_GTFS` (dir or zip) |
| GTFS-Realtime | with a feed | `SUPERCARTO_GTFS_RT` (TripUpdates URL) |

Toggle switches:

```
SUPERCARTO_NO_TERRAIN   disable elevation
SUPERCARTO_NO_WEATHER   disable weather
```

- `SUPERCARTO_PMTILES` — PMTiles archive URL; primary source when set
- `OVERPASS_ENDPOINT` — your own Overpass instance
- `TERRARIUM_ENDPOINT` — elevation tile template
- `TOMTOM_API_KEY` / `HERE_API_KEY` — enables `get_traffic`
- `SUPERCARTO_GTFS` — path to a GTFS feed (dir or .zip); enables the transit tools
- `SUPERCARTO_GTFS_RT` — TripUpdates URL; adds live delay lines

:::tip[PMTiles is the answer at production volume]
Range requests against object storage, milliseconds, no rate limit — and
the reader is included: no `pmtiles` dependency, no `mapbox-gl`, zero
transitive packages. A built-in MVT decoder walks the archive in-process.
:::

## Whole-metro feeds, default heap

Since 0.6.1 the GTFS load is columnar — `stop_times` parse straight into
per-trip arrays, no row objects — so a feed the size of Translink SEQ
(35 MB zip) fits Node's default heap and the answer is byte-identical to
the pre-0.6.1 build. Verified live: schedule, departure boards, and 750+
realtime predictions join in one answer, no `NODE_OPTIONS` needed.

## GTFS at scale, and the honesty of absence

A feed is only as fresh as the operator's last import, and a schedule that
exists but is stale is worse than absent: the tool must not be advertised at
all unless the operator has wired one. With realtime configured, a stop
without a prediction reads as unknown — never on time — and the note says
so in words:

```yaml
note: "… Real-time: 757 trip predictions, feed 32s old at query time.
A stop without a live entry has no prediction: unknown, not on time."
```

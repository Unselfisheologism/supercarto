---
name: supercarto
description: "Read the supercarto docs instead of answering from memory. Documentation for supercarto — token-budgeted map context for AI agents: one call returns a walkable topological graph of any coordinate, with weather, terrain, daylight, indoor floors and GTFS transit built in. Use when a task involves supercarto: how it works, how to set it up or configure it, or its API."
---

# supercarto

Documentation for supercarto — token-budgeted map context for AI agents: one call returns a walkable topological graph of any coordinate, with weather, terrain, daylight, indoor floors and GTFS transit built in.

This skill points you at the supercarto docs, at https://supercarto.pages.dev/docs. When a task involves supercarto, read the relevant page before relying on what you remember: the docs are the source of truth, and they change.

## Reading the docs

- Any page as Markdown: add `.md` to its URL (the home page is https://supercarto.pages.dev/docs/index.md). Every page link below already points at the Markdown.
- [llms.txt](https://supercarto.pages.dev/docs/llms.txt): every page with a one-line summary.
- [llms-full.txt](https://supercarto.pages.dev/docs/llms-full.txt): every page in one file, for when you need all of it.
- [JSON API](https://supercarto.pages.dev/docs/api/docs/pages.json): the page index, with each page as JSON and Markdown.
- [Changelog](https://supercarto.pages.dev/docs/changelog.md): release notes, newest first.

## Pages

- [Introduction](https://supercarto.pages.dev/docs/index.md): supercarto gives an AI agent a map of any location on Earth as a token-budgeted topological graph — one call, N tokens, measured on output.
- [Quick start](https://supercarto.pages.dev/docs/quick-start.md): Install supercarto, return your first maplet, and wire it into an agent — Node, Python, Claude Desktop, or the hosted endpoint.
- [FAQ](https://supercarto.pages.dev/docs/faq.md): Short answers to the questions every evaluation starts with.

### Concepts

- [The budget is a real budget](https://supercarto.pages.dev/docs/concepts/budget.md): How output gets ranked, cut, kept connected, and re-measured until the reported number is the delivered number.
- [Honesty rules](https://supercarto.pages.dev/docs/concepts/honesty.md): The refusal, absence, and degradation semantics that run through every tool — silence is never punctuality.
- [Accuracy](https://supercarto.pages.dev/docs/concepts/accuracy.md): Distances verified against haversine ground truth at mid and high latitude — the Mercator scale correction done per axis.

### Tools

- [The tools](https://supercarto.pages.dev/docs/tools.md): The eleven tools a supercarto deployment advertises, and exactly when each one exists.
- [get_maplet](https://supercarto.pages.dev/docs/tools/get-maplet.md): The core call — a walkable, token-budgeted topological graph of any coordinate.
- [localize](https://supercarto.pages.dev/docs/tools/localize.md): Move an open map session for the cost of the delta, not a new map.
- [route](https://supercarto.pages.dev/docs/tools/route.md): Feasibility first — straight-line distance, direction, and walking verification.
- [search_places and expand_feature](https://supercarto.pages.dev/docs/tools/search-places.md): Query a maplet by name or type, then expand one feature's exact geometry on demand.
- [get_terrain and get_daylight](https://supercarto.pages.dev/docs/tools/get-terrain.md): Ground elevation and slope, sun position, sunrise and sunset — arithmetic and tiles, no keys.
- [get_weather](https://supercarto.pages.dev/docs/tools/get-weather.md): Keyless current conditions and forecast, with a degraded path that refuses to invent readings.
- [get_air](https://supercarto.pages.dev/docs/tools/get-air.md): Keyless air quality with the honest-path guarantees - gases named only when elevated, unknown never rendered as zero.
- [get_traffic](https://supercarto.pages.dev/docs/tools/get-traffic.md): Live congestion with a provider key; labelled free-flow without one.
- [get_transit and get_transit_route](https://supercarto.pages.dev/docs/tools/get-transit.md): Schedules, departure boards, live delays, and a certified ride plan — honest in all three service states.

### Interfaces

- [CLI](https://supercarto.pages.dev/docs/interfaces/cli.md): Every supercarto command, from fetch to decode, with the flags each one takes.
- [HTTP API](https://supercarto.pages.dev/docs/interfaces/http.md): The maplet, screen, transit and route endpoints, with parameters and examples.
- [MCP and Claude Desktop](https://supercarto.pages.dev/docs/interfaces/mcp.md): supercarto exposes MCP over stdio; one-click install ships as an MCPB bundle.
- [Python client](https://supercarto.pages.dev/docs/interfaces/python.md): An asyncio client with zero runtime dependencies, speaking JSON-RPC to the Node server over stdio.

### Guides

- [Data sources](https://supercarto.pages.dev/docs/guides/data-sources.md): Where every layer gets its data — env-controlled, one factory, honest fallbacks.
- [Deployment](https://supercarto.pages.dev/docs/guides/deployment.md): Local HTTP, the hosted Cloudflare Worker and its honest subsets, plus documentation site deployment.

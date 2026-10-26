---
title: The tools
description: The eleven tools a supercarto deployment advertises, and exactly when each one exists.
sidebar:
  label: Tools
---

A supercarto deployment advertises exactly what it can answer. Eight tools
exist with no configuration at all; three appear only when the operator's
environment backs them. Nothing ever advertises a tool whose answer would
read like a guess.

| Tool | Needs | Answers |
| --- | --- | --- |
| `get_maplet` | nothing | what is near this coordinate |
| `localize` | nothing | what changed after the agent or the person moved |
| `route` | nothing | straight-line distance, direction, walking feasibility |
| `search_places` | nothing | find places by name or type |
| `expand_feature` | nothing | exact geometry for one feature |
| `get_terrain` | nothing | ground elevation and slope |
| `get_weather` | nothing | current conditions and forecast |
| `get_daylight` | nothing | sun position, sunrise, sunset |
| `get_traffic` | TomTom or HERE key | congestion and realistic arrival time |
| `get_transit` | GTFS feed | stops, lines, service times, departure boards |
| `get_transit_route` | GTFS feed | certified one-line ride plan |

The rule behind the table: a tool with no flow provider behind it reports
one honest free-flow number and labels it; a schedule tool with no schedule
behind it would teach a model to trust "no feed" as an answer that reads
like "no service" — so it is not a tool at all until an operator imports a
feed.

**[get_maplet](/docs/tools/get-maplet)**

The whole product: a walkable graph in one call.

**[localize](/docs/tools/localize)**

Move the session for the cost of the delta.

**[route](/docs/tools/route)**

Feasibility, not turn-by-turn.

**[search_places / expand_feature](/docs/tools/search-places)**

Query on the map, then expand geometry one feature at a time.

**[get_terrain / get_daylight](/docs/tools/get-terrain)**

Ground truth and sun position; no key, no archive.

**[get_weather](/docs/tools/get-weather)**

Keyless forecast with a degraded path that refuses to invent readings.

**[get_traffic](/docs/tools/get-traffic)**

Live with a key; labelled free-flow without one.

**[get_transit / get_transit_route](/docs/tools/get-transit)**

Schedules, boards, live delays, and the certified ride plan.

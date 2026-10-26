# Maps for AI agents: the 2026 landscape

> Every mapping platform now ships a tool server for agents. Most agents
> still answer "where should I meet them" with invented coordinates. A
> survey of what the major map and location tools ship today, why that is
> not enough, and a checklist to apply to any tool you wire into an agent.

*October 2026 — field survey. Companion to
[Can you be somewhere by 9?](/blog/get-transit-gtfs-schedules-for-agents).*

## What changed this year

The Model Context Protocol (MCP) turned "call a map API from an agent" into
a solved plumbing problem: point an agent at a server, let it discover tools
at runtime. Tracking catalogs now list **over 100 geospatial MCP servers**:
47 commercial, 41 published by the data vendors themselves. Google, Mapbox,
TomTom, Esri, CARTO, Felt, Cesium, and Baidu all ship official servers. The
plumbing is done. What has not caught up is what comes back down the pipe.

At the same time a newer, smaller group of tools started marketing on a
different axis: not more data, but **less of it** — compact answers sized
for a context window instead of raw GeoJSON dumps. That second wave is where
the interesting engineering is, and it is where this survey focuses.

## Four failure modes that still break agents

An agent with a map fails in particular, repeatable ways. Any "maps for
agents" tool should be judged against all four.

1. **Hallucinated coordinates.** A model asked to reason over raw lat/lon
   lists will, with nonzero probability, invent them. This is not a
   prompt-engineering problem; it is what happens when the format is
   something a model was barely trained to reason in.
2. **Silent truncation.** A fetch of "everything near here" returns hundreds
   of kilobytes, the agent framework cuts it to fit, and the map the model
   reads is a random prefix that looks complete. The model cannot tell *not
   there* from *not shown*. It confidently reports the pharmacy that got
   truncated away does not exist.
3. **Fictional routing.** Routing APIs sometimes return confident nonsense —
   impossible distances, routes through water. In our own benchmark work,
   the public demo router answered `Ok` with a walk that covered a
   straight-line half-kilometre in 40 seconds. Nothing in the response said
   "check me", so nothing downstream did.
4. **Invented hours.** A place with no recorded hours is not a closed place,
   but outputs that render "unknown" as "closed" (or as open) push an agent
   to send a person on a wasted trip — the exact failure an honest refusal
   is supposed to prevent.

## Who ships what

The platforms came for integration; the new wave came for context budgets.
Fair summary as of October 2026:

| Tool | Shape of an answer | Notes |
| --- | --- | --- |
| **Mapbox MCP** | raw JSON / GeoJSON payloads | Official, hosted endpoint, full API coverage. Metered API billing. Answer size is your problem. |
| **Google Maps Grounding Lite** | AI place summaries + payloads | Official, hosted. Place summaries are model-generated en route — convenient, and a new thing to trust. |
| **TomTom Agent Toolkit** | 53 tools + shared state layer | Smart design: full geometry lives in state, the model reads one-line summaries. Front-end oriented. |
| **PlaceRoot** | ranked compact answers from Overture | Keyless, 48 tools, real graph routing. The strongest "answers, not dumps" implementation outside the platforms. |
| **Footstep** | token-lean JSON | Hosted MCP, 15 tools, geometry opt-in. Freemium. |
| **GeoContext** | one-call context bundle | POI + neighbourhood profile + timezone per request. Claims an 80% tool-call overhead cut. |
| **xMap / RSMaps / Foursquare** | commercial datasets via tools | Large licensed POI/mobility corpora, agent-facing schemas. |
| **supercarto** | token-budgeted topological graph | Open source. The map is a walkable graph, cut to a budget re-measured on the emitted output, with every removal recorded. Public re-derivable benchmark. |

Two structural camps emerge. **Vendors host their data and keep the API
key** — convenient, metered, and the answer shape is decided by the vendor's
API, not by what a model reasons over well. **Open-data tooling runs
locally** — Overpass, Overture, self-hosted PMTiles — where the shape is a
choice the tool author makes. Most of the open tools still return flat
ranked lists. Flat lists answer "what is here". They do not answer "how do
the things here connect", which is what an agent needs when the next step is
moving a person.

## The checklist

Before wiring any map tool into an agent, ask for these five things. If a
tool cannot answer one of them, that is the data point.

1. **Is the token budget a budget?** Not "compact by design" — a number that
   is re-measured on the actual emitted output, guaranteed, with a fallback
   when it cannot be met.
2. **Does the map survive its own cuts?** After truncation, is the remaining
   area still traversable — can the agent route between what remains? A
   trimmed map that strands its landmarks is worse than a smaller complete
   one.
3. **Can the agent tell *not there* from *not shown*?** Truncation, missing
   data, and a closed/open-at-noon-checked-against-real-time distinction
   must be recorded in the output, not on the website.
4. **Is there a public score?** Not marketing claims — tasks, models, pass
   rules, and raw answer archives that a third party can re-derive without
   model calls. If the numbers cannot be checked, they are a mood.
5. **What happens when the source is down?** Zeroes and empty strings read
   as "no rain" and "nothing here". A degraded answer must announce itself
   as degraded.

## The gap that was next: transit

When this survey was first written, transit schedules were the clearest
missing capability: the routine agent task — "can you be somewhere by 9?" —
had no answer from any map tool for agents, and tracking catalogs showed no
agent-facing GTFS server. That gap has now started to close from both
directions. Dedicated transit-only MCP servers exist (MTA, Toronto, and
worldwide feed catalogs), and supercarto itself now ships `get_transit`:
stops, lines and first/last departures from any static GTFS feed, inside the
same token-budgeted maplet as the streets, terrain, weather and daylight of
one place — not as a separate server an agent must already know to consult.

## Where supercarto stands

supercarto takes the position that an agent should read something built for
reasoning, not rendered for humans: a topological graph with distances in
metres and compass directions, cut to a token budget that is re-measured on
the delivered output, with every drop recorded. In the public benchmark —
same questions, same models, only the context changes — the compiled graph
scores 38/47 against 15/44 for raw GeoJSON and 0/47 for no map. Every number
is re-derivable from committed answer archives without a model call. Indoor
multi-storey graphs, keyless weather, honest degraded paths, and GTFS
transit schedules ship in the core.

[Read the certificate](https://github.com/Unselfisheologism/supercarto-bench/blob/master/bench-results/certificate.md) ·
[Install supercarto](https://supercarto.pages.dev/docs) ·
[Companion survey and catalog links](https://github.com/sparkgeo/geo-mcp-servers)

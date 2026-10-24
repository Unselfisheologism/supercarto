# supercarto market research & product strategy

Last updated: 2026-10-23. Researched from live web sources; figures cite their publishers.

## 1. The landscape, as of October 2026

"Maps for AI agents" is no longer empty space. The sparkgeo catalog tracks
**106 geospatial MCP servers** (48 open, 47 commercial, 41 vendor-official),
and the everyday-location slice is saturated:

- Geocoding, place search, and routing appear in 20+ servers each.
- Every large platform has an official MCP server: **Mapbox** (with a hosted
  endpoint at mcp.mapbox.com), **Google Maps Grounding Lite** (hosted at
  mapstools.googleapis.com/mcp), **TomTom** (53-tool Agent Toolkit),
  **Esri**, **CARTO**, **Felt**, **Cesium**, **Baidu**, **MapQuest**.
- A newer wave markets on exactly supercarto's headline — compact,
  agent-sized answers:
  - **PlaceRoot** — keyless, 48 tools over Overture Maps, real graph routing,
    "482 KB GeoJSON dump → ≤2K tokens" framing, publishes its own
    token-efficiency benchmarks.
  - **Footstep** — hosted MCP, 15 tools, "token-lean responses, geometry
    opt-in", freemium via REST + MCP.
  - **GeoContext (bitemap.ai)** — a single `/context` call (POI results +
    neighbourhood profile + timezone), claims "80% less tool-calling
    overhead", free tier 5,000 req/mo, then $5.90–$120/mo.
  - **xMap** — 304M POIs indexed, agent-oriented pricing, MCP + REST + SQL.
  - **RSMaps** — upload your own geolocated dataset, MCP tools over it,
    $29/mo tier.

**Reading:** the *generic* agent-map market has two structurally different
halves, and supercarto sits in the defensible one:

1. **Commodity lookups** (geocode, search, route) — solved. Competing here
   means competing with Google and Mapbox on data quality. The sparkgeo
   analysis is blunt: "another OSM geocoder does not [add anything]."
2. **Context compilation for reasoning** — turning raw geodata into something
   a model can reason over at a guaranteed size, with honest semantics about
   what was dropped. This is still thin. The closest rival is PlaceRoot.
   Nobody else has thought as hard about the failure modes: silent
   truncation, hallucinated coordinates, and fictional routing.

## 2. Positioning against direct competitors

| | supercarto | PlaceRoot | Footstep | GeoContext | Mapbox/Google MCP |
|---|---|---|---|---|---|
| Output shape | topological **graph** (nodes/edges/distances/dirs) | ranked flat answers | flat JSON | flat bundle | flat JSON / GeoJSON |
| Hard token budget, re-measured | **yes** | per-answer target | "token-lean" | claims 80% cut | no |
| Connectivity guaranteed after cuts | **yes** | n/a (list shape) | no | no | no |
| Honesty semantics (omitted / absent / degraded / closed vs unknown) | **yes, formalized** | partial | partial | partial | no |
| Indoor multi-storey graphs | **yes** | no | no | no | no |
| Map fuses weather / traffic / daylight / terrain / hours | **yes** | no (deliberate) | weather | no | weather only (Google) |
| Traversable reasoning (agent can move A→B on the map itself) | **yes** | routing tools | routing tools | no | yes, raw |
| Public, re-derivable benchmark certificate | **yes** | claims benchmarks, private method | no | no | no |
| Price | free, self-hostable | free | freemium | freemium | metered APIs |

One-sentence version: **supercarto is the only map for agents that ships as
a graph the agent can traverse, cut to a budget it can verify, with
semantics designed so the model cannot lie to itself.** PlaceRoot answers
different questions (identify, rank, compare places). supercarto answers
"here is your world, walkable, in 900 tokens".

## 3. ICP (Ideal Customer Profile)

Ranked by (fast time-to-value, willingness to pay, switching cost for us):

**ICP-1 — Agent-framework / MCP-builder developer (free tier, seeds the
surface).** Anyone wiring an MCP client (Claude, Cursor, LangChain, OpenAI
Agents SDK, OpenCode) whose agent must reason about physical space. Must be
able to install, run, and get a correct map in under 5 minutes with no key.
Large population; organic distribution through MCP catalogs, skills
directories, and awesome-lists. Today this is npm 216 downloads/week and
pui — the funnel top, not the revenue.

**ICP-2 — Agentic product teams building "real-world" assistants (revenue).**
Travel, logistics, delivery, field service, property, campus, and venue
assistant teams — 2–20 people whose agents must answer "should we send a
person there, now?". The README's person-level hazards are their production
incidents: free-flow masquerading as live traffic, a cycling recommendation
during a storm, a route that crosses a wall. They pay for verified routing,
traffic credentials, and budget guarantees because token costs compound at
request volume.

**ICP-3 — Geodata vendors who want agents to read their data (expansion).**
xMap, Factori, parcel-data vendors, indoor-mapping providers. They sell data;
we compile it for agents. A vendor registers an adapter arm in
supercarto-bench and gets measured on our tasks — or embeds the compiler as
the delivery layer for their hosted MCP server.

## 4. TAM

Top-down anchors (cite as ranges; never as one number):

- Location intelligence market: **$23.3B–$28.4B in 2026**, ~11–15% CAGR
  (Research & Markets; Precedence; Grand View).
- Location analytics: **$12.8B–$13.9B in 2026** (MarketsandMarkets; Grand View).
- Geospatial analytics: **$108B in 2026** including platforms (Mordor).

supercarto's serviceable slice is much narrower: agent products that compile
physical-space context per request. It is small in 2026 and compounding, and
it maps to per-request compilation better than the analytics market does.

Bottom-up sanity check: 1,000 paying agent products × $200/mo × 12 =
**$2.4M ARR** — that is the honest near-term ceiling of the self-serve model,
not the top-down figure. The vendor-embed path (ICP-3) and the robot-harness
market (D1) are what move the number; they must be validated before they
count. Today's *measured* demand is the free tier: 216 npm downloads/week.

## 5. Moat candidates (honest rating)

1. **The benchmark + certificate (strongest, already live).**
   supercarto-bench is the only public, re-derivable score for
   map-in-context tasks. Current headline: 38/47 compiled graph vs 15/44
   raw GeoJSON vs 0/47 no map, re-derivable from committed answer archives
   with zero model calls. Rivals are invited to register adapters and get
   measured on our tasks — every attempt makes our score the reference
   point for the category. Google and Mapbox will never publish a public,
   adversarial score against themselves.
2. **Compiler semantics (strong).** Connectivity-guaranteed budget cuts,
   landmark-vs-intersection ranking, and the honesty vocabulary
   (omitted / absent / degraded / closed vs unknown) are published, tested,
   and hard to bolt onto a truncate-and-hope server after the fact.
3. **The architecture as a spec (durable).** The wire format is compiled to
   a reasoning format the model never reads (SCR ⇄ budgeted YAML). That
   claim defines the category; whoever holds the reference compiler and
   the certificate holds the definition.
4. **Distribution position (defensive, needs upkeep).** npm + PyPI + the
   skills.sh listing + OpenCode skill installation make supercarto the tool
   agents find when they search for a map. Rivals must match four surfaces
   to remove us. Cheap to hold, cheap to lose — depends on upkeep.

## 6. Wedge (what we lead with)

**"Give your agent a map it can act on, inside a token budget you can
verify."** Supporting messages, in order: the benchmark score, indoor
floors, the keyless/no-billing design, and the honesty semantics.

## 7. Product directions (ranked)

### D1 — The robot-brain harness (new market; unvalidated bet)

A derivative of the current codebase: **a geospatial context daemon that
runs inside an autonomous robot's onboard computer**, feeding the robot's
own reasoning loop rather than a chat agent. Concretely: package the
compiler as an embedded service (local binary or wheel, `supercarto
harness run`) that renders a local-only map from on-device PMTiles + live
GPS + sensor context, emitted into the robot's prompt or planner input.

Why it is interesting:

- **Same core product, different customer.** Embodied-AI teams (delivery
  robots, drones, AGVs) need tiny honest spatial context because their
  compute is onboard and their token budget is a latency budget too.
- **A position nobody claims.** None of the 106 MCP servers installs *on
  the robot*. Cloud AI vendors can't reach it; map-data vendors sell data,
  not robot loops.
- **Accumulates our compiler moat.** The robot harness is the same compiler
  with a new delivery surface; every semantics fix helps both markets.

What it lacks: no published evidence that robot architectures are
prompt/context-shaped today. Before any productizing: build a single-file
prototype, then talk to two or three robotics teams.

**Status: research bet. Prototype first; do not productize until design
partners are spoken to.**

### D2 — Hosted compile endpoint (nearest revenue)

Self-serve entry for ICP-2: a hosted compile endpoint (budgeted map with
traffic / hours / weather fusion, authenticated). Free at 1k maps/month,
$49–$199/mo above that. The keyless npm install remains the wedge; this
tier serves teams who will not run infra. Needs: analytics, rate limiting,
a ToS page, and PMTiles-scale hosted infrastructure. Ship order: after the
infra exists.

> **Status 2026-10-23: the compile surface is live, unauthenticated and
> free.** Supercarto 0.5.2 deploys the compiler core (zero Node built-ins
> in the compile path) as a Cloudflare Worker:
> supercarto-compile.jeffrinjames99.workers.dev — real maplets over
> `/maplet?lat=&lon=&budget=`, plus `/scr`, `/daylight`, `/weather`,
> `/terrain`, honest `/` index and per-IP rate limit. Two findings shape
> the paid tier:
>
> 1. **Overpass refuses Cloudflare-Worker egress entirely** (HTTP 521 on
>    every instance, probed from the worker itself). The worker answers
>    maplets from a hosted PMTiles planet build instead — which turns out
>    to be the *production* data path, not a hack: faster (130 ms vs
>    26 s for an unbounded fetch), capped honestly, and the same code path
>    licence-bearing deployments would use.
> 2. Unauthenticated freemium alone gives adoption, not revenue; the
>    paid tier's remaining prerequisites are analytics, identity, a ToS
>    page, and a stock iTX/metering story — not more compiler work.


### D3 — GTFS (transit) — the next provable feature, and fills a live gap

The sparkgeo gap table listed **public transit (GTFS) as zero-coverage** in
the entire MCP market at research time. supercarto already has transport
nodes, a token budget, and an honesty vocabulary. GTFS ingestion would make
supercarto the only keyless agent map that can answer "can you be somewhere
by 9?" with real schedule awareness. PlaceRoot explicitly declined schedules;
Mapbox's MCP has none. **Top pick for the next feature.**

> **Status 2026-10-23: shipped in 0.5.0.** `get_transit` over any static
> GTFS feed, three honest service states, budget-honouring, TS suite green
> (412 tests) and parity-checked against the Python port.
>
> **Competitive correction, same day: the zero-coverage window closed
> mid-quarter.** A check on release day found 8+ transit-only GTFS MCP
> servers, most created March–July 2026 with 0–2 stars: jdamcd/gtfs-mcp
> (MTA + realtime), bokangsibolla/gtfs-mcp (worldwide feed catalog),
> bribroder/gtfs-mcp (CSA routing + realtime), cyanheads/transitland,
> ttc-mcp (Toronto), gtfs-one-mcp (WordPress-based agencies), a hosted
> transitmcp.com (NYC/DC/SF), and metronorth-mcp. The sparkgeo table is
> behind reality here. The honest restatement of the wedge: all of them are
> **transit-only servers** — an agent must already know it has a transit
> question, get coordinates from a geocoder elsewhere, and cannot see a
> departures board next to the streets, terrain, weather and daylight of
> the same place in one budgeted answer. supercarto ships GTFS as one tool
> inside the maplet, which none of them do, but the "nobody has transit"
> claim is dead and must not be reused in copy. If transit demand proves
> the wedge, the natural follow-up is GTFS-Realtime (delays are what
> riders actually ask about) and a `route` that mixes walking spans with
> transit spans.
>
> **Status 2026-10-24: GTFS-Realtime follow-up shipped in 0.5.4.** TripUpdates
> decode over a zero-dependency protobuf wire reader, predictions join onto
> the schedule in `get_transit` with spec-precedence rules (explicit stop
> update beats trip-level delay; absolute times convert through the feed
> timezone; a stop with no prediction reads as unknown, not on time, in the
> note). Field numbers were verified against the canonical proto and three
> live keyless agency feeds (Adelaide, Sofia, Translink SEQ) in both
> language ports. Accuracy note for this file: the 0.5.0 status line above
> said GTFS was "parity-checked against the Python port" — the Python port
> carries the compile core plus the new wire decoders, but static GTFS stays
> TypeScript-only (long-standing precedent), so that earlier claim
> overstated the parity surface.

### D4 — Coverage gaps as data partnerships (later)

From the same gap table: hazard layers (flood/wildfire for logistics
agents), demographics (block-level scores for site-selection agents), and
warehouse spatial SQL. These need commercial data partnerships — park them.

### D5 — Explicitly not doing

- Another geocoder. Commodity; we lose to the platforms on data quality.
- Competing on POI volume with xMap. They have 304M POIs; Catalog/OpenStreetMap
  is not the axis to fight on.
- A render/tiles/hosted-map-UI stack. It serves humans looking at maps, not
  agents reasoning over them — exactly the position we reject.

## 8. Immediate plan (next two weeks, needs no user input)

1. ✅ Site SEO foundation: robots.txt, sitemap.xml, canonical, JSON-LD
   (SoftwareApplication + FAQPage), favicon, benchmark section on the page.
2. ✅ Sharpen positioning in this doc; next: a public "Maps for AI agents:
   the 2027 landscape" post derived from sections 1–2 (fair to rivals,
   cites sources), shipped as a site page + linked in the README.
3. Catalog presence: verify npm + PyPI listings are current; submit to
   mcp.so / mcp-listing catalogs that accept submissions.
4. GTFS implementation (D3) as the next feature win — schema, ingest,
   `.hours:` semantics, tests against a real GTFS feed.
5. Write the one-page robot-harness (D1) research brief before talking to
   robotics developers.

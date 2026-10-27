# supercarto — strategy, market, and the big questions

*Owner's brief. Numbers marked ~ are estimates; sources noted inline. Last updated 2026-10-26.*

---

## 1. The pivotal moment

Three curves crossed in 2025–2026 and they define everything supercarto does:

1. **Agents went from demos to fleets.** Agentic AI spending is projected
   at **$19.3B in 2026 → $205.9B by 2033** (MarketsandMarkets), roughly 40%
   CAGR across every major research house (Mordor: $82B by 2032; Fortune BI:
   $139B by 2034). Whatever the exact multiplier, the 3-year trend is 5–10×.
2. **MCP became the tool interface everyone standardizes on.** Anthropic's
   Model Context Protocol was adopted by OpenAI, Google, Microsoft and AWS;
   the public ecosystem crossed **10,000+ distinct servers in 2026**, with
   growth shifting from hobby servers to vendor-published and enterprise-
   internal ones. An MCP server is now the *front door* for any data a
   company wants agents to touch.
3. **Tokens became line items.** As agent loops scale, context cost and
   context quality — not model quality — became the controllable variable
   owners complain about. "Give the model the right 2,000 tokens, not a
   40,000-token dump" is an economic lever, not a nice-to-have.

**The gap:** every serious agent stack eventually needs the physical
world — where is this, what's near it, can you walk there, when is
daylight, does the bus run. Today that need is served either by legacy
geocoding APIs (built for humans drawing UI pins: unverifiable, verbose,
token-hungry when read by eyes) or by model hallucination. Google Maps'
agent-irrelevant pricing ($2–$30 per 1k requests, per-API silos) proves
the incumbents are optimizing for the *browser-era* buyer.

supercarto's bet: **the map API's unit of sale changes with agents.**
The unit is no longer "a pin" or "a tile"; it is *a budgeted, honest,
topological chunk of world-model the agent can actually reason with* —
a maplet. Whoever owns that unit owns the geo layer of the agent stack.

---

## 2. Scope and potential (where supercarto can and cannot go)

**In scope — the "world-model as a tool" category.** Localize, nearness,
walkability/feasibility, transit schedules, terrain, weather, daylight,
indoor floors. Anything an agent should know *before* promising a human
it can get somewhere.

**Adjacent but plausible:** route certification for multi-hop tasks,
agent-ready place data (budgeted POI summaries), timeout-aware "can this
agent physically do this errand" feasibility scoring as a *decision gate*,
and eventually a general "grounding feed" — the same honest-absence
philosophy applied beyond geo (hours-of-operation truth, "is this shop
actually open").

**Out of scope — deliberately:** turn-by-turn consumer navigation, fleet
telemetry, real-time maps editing, human-facing map UIs, being an OSM
editor. supercarto is a *tool for artificial readers*, priced and shaped
for machine consumption. This focus is the brand. Anti-goals protect focus
(see §10).

**Potential ceiling:** the geo-tool category for agents is not yet priced
by anyone as its own market. If "agent-side geo grounding" becomes a
standard procurement line (like "vector DB" became in 2023–24), the
category can settle in the **low hundreds of $M by 2028** and the eventual
winner inherits a rerail into the much larger location-platform market
(~$3–5B today, dominated by Google; source-level: Google Maps Platform
revenue estimates). Ambitious framing: supercarto is to the Google Maps
API what Cursor is to the IDE — a re-architecture of the same substrate
for a new customer that the incumbent's pricing and assumptions ignore.

---

## 3. ICP (Ideal Customer Profile)

**Primary ICP — the "agent builder with a real-world promise."**

- Builds an agent or agent-mediated product whose answers carry
  **physical-world commitments**: "here's where to park", "this stop is
  4 min walk", "you can make the 18:42 bus".
- Feels the pain as *token cost + unreliability*: models hallucinate POIs
  more than |lat| > 0.001 rounding errors; context windows fill with
  useless geo JSON.
- Uses MCP (Claude, Cursor, Cline, Codex, custom) or the Python/Node SDK.
  Individual engineer through 20-person AI startup. Portfolio: AI-agent
  consultancies, logistics/delivery pilots, local-search assistants,
  travel agents, event planners, civic-tech, delivery DOTS.

**Secondary ICPs**

1. **Model labs / eval teams** — need *ground truth* spatial tasks for
   benchmarks and RL environments (same honesty semantics that made
   supercarto's own eval rigorous). Long sales cycle, high leverage,
   tiny team count.
2. **Enterprise "AI + field ops"** (utilities, retail, municipalities):
   agents dispatch humans to places; need self-hosting, data residency,
   audit trails for *absence claims*. Budget exists; procurement is slow.
3. **Data providers** (transit agencies, property data, venue feeds)
   wanting their catalogs agent-readable through a supercarto-conformant
   source — long-term channel play, not near revenue.

**Anti-ICP:** consumer app devs wanting pretty tiles (wrong shape);
general web search companies (/YYYY different job).

---

## 4. TAM / SAM / SOM (bottom-up, honest ranges)

Aggregates marked ~; treat as instrumented estimates, not finance-grade.

- **TAM (geo-grounding for AI):** if 0.5–1% of projected agentic AI
  platform spend in 2027 (~$25–30B) flows to *environment grounding*
  tools of all kinds (search, browser, maps, finance): **~$150–300M**
  geo-relevant slice by ~2028. Cross-check: location-API TAM ~$3B+
  growing; even 5% agent-share displacement ≈ $150M.
- **SAM (agent-deployed geo tools, MCP-first):** 10k+ MCP servers now;
  assume ~1% of the MCP fleet has geo needs ⇒ niche today, but MCP fleets
  grow with the 40% CAGR market ⇒ SAM by 2028 ~**$30–80M**.
- **SOM 18–24 months (with current team & product):**
  - 100 paying hosted customers averaging $1.5–3k/yr ⇒ $150–300k ARR
  - plus 2–4 enterprise/eval-team contracts at $20–50k ⇒ ~$100k
  - *goal: ~$0.3–0.4M ARR while compounding share of the registry
    ecosystems (npm/PyPI/official registry) — the leading indicator.*
- **Rule of thumb used here:** supercarto doesn't need to beat Google;
  it needs to be *the default when an agent engineer reaches for*
  "what's physically near/true here." Default-ness in a 10k-server
  ecosystem is the actual near-term asset being built.

---

## 5. Competitive landscape

| Layer | Players | supercarto's angle |
|---|---|---|
| Incumbent geo APIs | Google Maps, Radar, HERE, Mapbox, Geoapify | Built for humans/pins; per-API silos; no honesty semantics; no token budgets; $5–30/1k |
| Aggregators for agents | Browser/search MCPs (Exa, Tavily, Firecrawl-class) | Text out of a search box, not verified topology; POI truth not grounded |
| OSS geo stacks | Overpass, Nominatim, OSRM, Valhalla | Real data, wrong unit: verbose XML/JSON built for apps, absent agent budgets, no honesty layer, no context-engineering |
| Agent-native geo upstarts | (early; some YC/AngelList-stage) | Race is to define the primitive; supercarto's honesty+honest-pricing+budget discipline is the differentiator |

**Moat, ranked by durability:**

1. **Honesty semantics as IP-shaped product** — "not-shown ≠ not-there",
   omission records, refusal grammar. Any incumbent *can* copy; none have
   the organizational instinct — their brand is "never say nothing".
2. **Budget-discipline engineering** — columnar feeds, byte-parity,
   measured-on-output. Sustains the "*X tokens, measured*" claim that
   marketing copy cannot fake.
3. **Registry + distribution beachhead** — npm/PyPI/official MCP registry/
   Glama A-rating/HF dataset; directory presence compounds as discovery
   consolidates into registries.
4. **Trust adjacency** — if geometry/absence claims from supercarto become
   citable in agent audits (like a clock), switching costs emerge.

---

## 6. Business model & pricing structure

**Model: usage-based hosted offering + OSS self-host anchor + enterprise
overlayer.** The open source core (MCP, CLI, SDKs, HF sample dataset)
is the distribution engine; the hosted product monetizes convenience,
volume, SLAs, and premium sources.

**Principles**

- Price in *maplets*, not requests — matches the mental unit; one tool
  call can carry several maplets of meaning.
- Free tier generous enough that every eval that tries supercarto
  *completes without a sales call* — matches ICP skepticism.
- Honest ceilings: when a limit is hit, the API says so precisely and
  points to the upgrade path; no surprise 2xx with silently degraded data
  — *that candor is the product*.
- Self-host always legal for its code; price the hosted value, not fear.

**Proposed tier structure (net, v1 — revisit monthly with cohort data)**

| Tier | Price | Maplets/mo | Includes |
|---|---|---|---|
| Free | $0 | 5,000 | full geometry, all sources, community support, public attribution |
| Agent | $49/mo | 50,000 | + overage $0.90/1k, higher token budget ceiling, priority rate limits |
| Team | $299/mo | 500,000 | + 3 seats, custom sources, audit log, 99.9% SLA |
| Enterprise | $2k+/mo annual | committed | + SSO, private feed mirroring, data residency, RL-environment licensing, eval-team access |

Anchors to compare against (for the pitch deck): geocoding at Google
~$5/1k requests; Places Details $17–32+/1k. supercarto at $0.90/1k
maplets delivers *more* semantic value per call ("near + topology +
truth"), ~5× cheaper than Google's entry geo call and personally
explainable at line-item level.

**Monetization ladder (order of launch)**
1. Free hosted tier + keys (fastest to first organic demand).
2. Agent tier with Stripe + documented upgrade flow.
3. Enterprise conversations seeded by eval-team use.
4. Later: per-seat *RL environment license* for labs — the sleeper
   category: pay-for-environment companies pay $10k-class for domains
   with verified ground truth; supercarto's honesty layer makes it
   uniquely defensible there.

---

## 7. Product-market fit definition (measurable gates)

PMF here is *sequenced*, not binary. Three gates, each with numbers:

**Gate 0 — usefulness without scale (passed if true today).** An agent
engineer can install, run, and get a verified maplet without contacting
us; docs + llms.txt support no-human-in-loop evals. *Pass criterion:
server count via npm/registry installs > ~200/mo sustained.*

**Gate 1 — repeat pull (12–24 weeks).** ≥30% weekly-return rate among
installers; ≥10 independent teams running supercarto *inside a deployed
agent*; organic mentions in 3+ "MCP picks" hashtags/threads/awesome-lists
without outbound prompting. *This is the PMF bar for a dev-tool that
sells to builders: the build-integration *pipeline* is the product.*

**Gate 2 — paid pull (~6–9 months in).** ≥10% of hosted-free users convert
to a paid tier within 60 days of launch; LTV:CAC ≥ 3 with distribution
being free/organic; support queue dominated by *feature requests*, not
reliability complaints. Early sign of real PMF: someone builds their
*product* around supercarto's output format (maplets), even reselling it —
a customer acting as a channel is the strongest PMF signal available.

**Against which all marketing claims must stay honest:** raw weekly
numbers can be inflated by installs-in-search; the metric that should
move and has no vanity risk is *maplets provisioned per retained user*.

---

## 8. Future directions

**Near term (now–+1 quarter)** — ship code for: hosted keys + Agent tier;
"maplet citations" in docs (citable, stable IDs for a returned sheet —
the agent-audit hook); one flagship integration post (e.g., Cursor /
Cline recipes) per big client channel.

**Mid term (+2–4 quarters)** — indoor floors GA; flight/train/timetable
grounding; agent-native "can-I-actually-do-this" feasibility gate as a
first-class MCP tool; NL-based data summarizer for non-geospatial
sources reusing honesty grammar; ISO-like *absence-schema reference
implementation* published as a spec others can adopt (ecosystem wedge:
become the API of honest absence).

**Long term (AGI-era role).** See §9. Product shape there is not an app;
it is *the ground-truth feed for physical-world promises made by
machines* — licensed like a rating agency, not a SaaS.

---

## 9. The role in the AGI race

Statement of thesis, plainly:

> Agents can already reason; they cannot be trusted with the physical
> world. The bottleneck is *verifiable grounding* — space, schedules,
> absence. supercarto's niche in the AGI race is to be the component that
> turns "the model said so" into "the model cited a measured world".

Concrete implications:

1. **Eval infrastructure, not just tools.** As labs race to agentic
   benchmarks, they need tasks with *checkable* physical-world answers.
   supercarto's dataset + honesty layer is a natural RL-environment /
   benchmark substrate (one team's eval is another team's marketplace).
2. **Safety-ish positioning without safety theater.** Honest absence —
   refusing to hallucinate wheelchair access, flood terrain, transit
   downtime — is *existential* risk-reduction for agents acting in the
   physical world; that gives supercarto a defensible narrative with
   enterprise and, eventually, policy-minded buyers.
3. **Neutrality as strategy.** supercarto should remain the *boring,
   correct* layer — run on open feeds, zero-lock-in, self-hostable, and
   cheap — precisely because both labs and incumbents will be looking
   for a neutral, auditable geoid layer they cannot own. Being the
   Switzerland of agent-geo is worth more than being a feature war's
   winner that one lab buys and others fear.
4. **What happens after AGI (if it arrives).** Agents change but the
   *world* stays opaque; someone still has to serialize it honestly.
   supercarto's asset transfers: the feed, the honesty IP, the identity
   as the party that says what is NOT there. In an automated economy,
   trust infrastructure outlasts tool interfaces.

---

## 10. Risks and anti-goals

- **Data-source fragility** (GTFS/removal of free sources, OSM overload)
  → mitigation: multi-source abstraction, mirror agreements, cached
  datasets; the honesty rules were written for exactly this.
- **Being feature-copied by Google-free incumbents** → mitigation: keep
  the honesty + budget *semantics* ahead of the *data*; semantics are
  copyable in weeks but organizationally alien to incumbents.
- **Free-tier exploitation** → mitigation: maplet metering by *value*
  (bytes, sources) not raw counts; abuse honest ceilings.
- **Mission drift** (adding tabs/dashboards/consumer features) → the
  anti-goal list in §2 is the written constitution; every new surface
  must answer "does this make an agent's answer more honest or cheaper?"

---

## 11. Immediate next moves (ranked by expected value)

1. **Hosted free tier + Agent tier launch** (monetize today's organic
   interest; unblocks Gate 2 of PMF).
2. **Maplet citation IDs + stable URLs** → anchors the audit-trust wedge.
3. **Publish "the honest absence" as a spec** (the ecosystem wedge:
   get other MCPs to adopt the grammar; cheap to publish, compounding).
4. **Eval-team outreach** (5–8 labs / bench teams; slide: the honesty
   layer makes spatial tasks gradeable).
5. **Directory consolidation** (Glama live ÷ more registries; official
   registry + Smithery + PulseMCP badges; each one is permanent).
6. **Content flywheel**: one deep post per quarter on a single agent's
   real-world answer with *numbered citations from supercarto output* —
   the genre the docs already model.

---

## 8-f. Gaps an independent agent audit surfaced (2026-10-27)

A working agent evaluated supercarto against a full geospatial needs
list. Half its ❌s were stale (localize/search_places, POI hours, GTFS
timetables, indoor floors all shipped). The genuinely-missing items are
now explicit roadmap lines, in priority order:

1. **POI attributes beyond OSM** — ratings, contact, "open right now"
   (Foursquare pairing; honest-state only, never guess).
2. **AQI + civic alerts** — flood/monsoon levels as its own source with
   the honesty grammar (flood: assertion, absence, or unknown).
3. **Live road closures** — beyond keyed traffic's worst-segment.
4. **India fare models** — auto fare tables; needed for transport promise.
5. **Boundaries/compliance layer** — ward/pincode answer for what's
   available where ( clears a long-standing fixing need for DPDP-type queries).
6. **Imagery hook** — deliberate exclusion for now; revisit only as a
   pointer to source URLs, never bytes in a maplet.

---

*Decision log:* no VC-funded ambition in v1; compounding distribution
assets
(npm/PyPI/registry listings, HF dataset, docs) before paid traffic; every
claim in this document must satisfy the honesty rules applied to
supercarto's own tools — numbers sourced or marked ~.

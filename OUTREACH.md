# Outreach kit

You send the messages; this file gives you the proof, the draft, and the
list-building method. Rule of the campaign: send a running example, never a
deck.

## Step 1 — the proof they will run (60 seconds)

Paste this into any terminal. No clone, no key, no build:

```bash
# A compiled, budgeted neighborhood of Tokyo Station, straight to stdout
npx supercarto fetch --lat 35.6833 --lon 139.762 --radiusM 400 --budget 1024 --metrics

# The same thing as an MCP server for their agent
npx supercarto mcp
```

What they should see: a one-screen YAML maplet with named places, walkable
connectivity, heat, weather, an omission record — under 1024 tokens, no
accounts, no keys.

Then the offer: "run your agent against it for the afternoon. If the
answers are worse than what your pipeline does today, close the tab."

## Step 2 — the draft message

Short version, for X / GitHub Discussions / Discord DMs:

> Hi <name> — I built something for <their framework>'s users who need
> spatial answers (nearby places, walkability, terrain, weather) without
> burning 100k tokens on raw geojson or leaning on a hosted map API.
>
> One command to see it: `npx supercarto fetch --lat 35.6833 --lon 139.762
> --radiusM 400 --budget 1024 --metrics` — a compiled neighborhood in
> under 1024 tokens, with honest omissions (it labels what it did *not*
> show, so agents stop inventing places).
>
> It's an MCP server (`npx supercarto mcp`), the core is free and
> self-hostable (npm `supercarto`, pip `supercarto`, zero runtime deps),
> and there's a task-level benchmark with adapter arms so any rival map
> tool can run the same test: <bench link>.
>
> Verified recall on omission / nearest / connectivity: 9/9 against raw
> GeoJSON's ~4/9 with the same model.
>
> Would <their framework> want an integration? It's one JSON entry in the
> MCP config. Happy to send a working snippet for your README.

Swap the middle paragraph if you know their stack: Python users get
`pip install supercarto` + the MCP command.

## Step 3 — who to send it to

Ten targets, in this order. Do not mass-send; each message names their
project in the first line.

1. **MCP server collections** — the maintainers of the popular "awesome
   MCP servers" lists and registries. One listing is worth ten cold DMs.
2. **Agent framework authors** — the small, fast-moving Python and TS
   agent frameworks with visible MCP support. They need tools, and a
   zero-dependency one is zero risk to them.
3. **Local-first / maps-for-DEVS communities** (openstreetmap-adjacent
   dev forums, self-hosting communities). Self-hosting is their default.
4. **Founders with agents in production** — reach via their changelogs:
   anyone who shipped "find near me", "plan my trip", "warehouse picker"
   features in 2026. Their pain is measured in tokens and hallucinated
   addresses.
5. **Map-stack vendors** — offer the adapter arm, not the pitch: "run
   your own representation through the same tasks." Competitors accept
   benchmarks as invitations; they reject decks.

For each candidate, fill one line before sending:
`<project> | <what their users currently do for maps> | <which of the 9
tools they'd feature>` — if you cannot fill it, do not send yet.

## Step 4 — the follow-up (3 days later, one line)

> One more data point: the benchmark README has raw answer archives you
> can re-score yourself with zero model calls. If <tool X> beats
> supercarto on its own tasks, I'll publish that too. That's the deal.

## What NOT to send

- No feature lists without the number.
- No "AI-powered" wording. The product's edge is what it refuses to invent.
- No pricing in the first contact. The core is free; the conversation
  starts there.

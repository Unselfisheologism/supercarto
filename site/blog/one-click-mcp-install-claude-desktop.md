# Install an MCP server in Claude Desktop with one click

> The standard way to add an MCP server to Claude Desktop is a JSON file:
> find `claude_desktop_config.json`, hand-write a `mcpServers` block with the
> right command and arguments, paste env keys in the right shape, restart.
> The [MCPB bundle](https://github.com/modelcontextprotocol/mcpb) format
> fixes this: one double-click, no config file editing.

*October 26, 2026 — on the release of supercarto 0.6.2. Companion to
[GTFS schedules for agents](/blog/get-transit-gtfs-schedules-for-agents).*

The standard way to add an MCP server to Claude Desktop is a JSON file: find
`claude_desktop_config.json`, hand-write a `mcpServers` block with the right
command and arguments, paste env keys in the right shape, restart. It works,
and it filters out almost everyone who would want the tool but not the
ritual.

The MCPB bundle format fixes this: a `.mcpb` file is a zip archive with a
`manifest.json` describing the server, its entry point, and optional
install-time configuration. It is to MCP servers what `.vsix` is to editor
extensions. Open the file with Claude Desktop and it unpacks the server,
shows any configuration the author declared (API keys, file paths), and
starts it when the session needs it.

supercarto ships one with every release. From the
[latest release page](https://github.com/Unselfisheologism/supercarto/releases/latest),
take `supercarto-X.Y.Z.mcpb` — 384 KB — and open it with Claude Desktop. Two
reasons the bundle is small: the server has zero npm dependencies (no
`node_modules` inside the archive), and the map source is OpenStreetMap over
HTTP, so no data ships in the bundle either. Node 18 or newer is the only
requirement on the machine; Claude Desktop bundles Node on the platforms it
runs on.

## What the install screen can configure

All optional:

- an **Open-Meteo API key** — the free tier works without it, the key lifts
  the rate limit
- a **GTFS feed path** — a directory of `.txt` tables or a feed `.zip`. This
  is what turns on `get_transit` and `get_transit_route`: schedules,
  departure boards, and a certified single-line ride plan between two
  coordinates
- a **GTFS-Realtime TripUpdates URL** — the operator's realtime endpoint for
  the same feed; boards then show live per-trip delays ("bus 433, +27s")
  and, just as important, honest absence: a stop with no prediction says
  unknown, never "on time"

Getting the feed path is the operator's part — feeds are per-city and
per-operator, and the transit database is loaded locally, so no coordinate
of yours leaks into a third-party schedule service. If you want a feed to
try, most transit agencies publish theirs openly; search for "<your
city> GTFS".

## Why the manifest says what it says

The manifest lists the eight always-on tools and marks the catalog as
`tools_generated`, because `get_traffic` and the two transit tools appear
only when their configuration exists. The alternative — advertising a
schedule tool that answers "no feed configured" — reads like "no service"
to a model, and that distinction is the whole design center of this
project.

## If you'd rather not click

Everything in the bundle is also plain source: `npx supercarto mcp` runs the
same server over stdio, the config-block form still works exactly as
documented in the [README](https://github.com/Unselfisheologism/supercarto),
and `scripts/mcpb.py` (38 lines, Python stdlib only) rebuilds the bundle
from any checkout.

[Download the bundle](https://github.com/Unselfisheologism/supercarto/releases/latest) ·
[GitHub](https://github.com/Unselfisheologism/supercarto) ·
[Other installs](https://supercarto.pages.dev/#install)

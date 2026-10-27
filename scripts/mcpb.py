#!/usr/bin/env python3
"""Pack supercarto as an MCPB (.mcpb) bundle for Claude Desktop.

One .mcpb is a zip: a manifest.json describing the server plus the files it
needs. This packer keeps the artifact honest with the release it rides on:
the manifest version is read from package.json, so the bundle, npm, PyPI and
the official MCP registry all carry the same number.

Only Python's standard library is used - the zero-runtime-dependency rule
extends to the packaging step, and the mcpb CLI's npm install would drag a
tree of transitive dev-time packages onto every contributor's machine.

Contents are the built dist/, the license, the README, and package.json (the
bundle's install directory is self-contained; node and an OpenStreetMap
Overpass endpoint are the only runtime requirements).
"""

import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Always advertised by a bare install: routes come from OSM, elevation from
# the terrarium archive, weather from Open-Meteo. get_traffic needs a
# routing-provider key and the two transit tools need a GTFS feed, so the
# manifest marks the catalog as generated: whatever answers introspection is
# exactly what this installation offers.
BASELINE_TOOLS = [
    ("get_maplet", "what is near this coordinate",),
    ("localize", "move within an open map session; returns only what changed"),
    ("route", "straight-line distance, direction, and walking feasibility between two points"),
    ("search_places", "find places by name or type"),
    ("expand_feature", "exact geometry for a feature in this maplet"),
    ("get_terrain", "ground elevation and slope around a coordinate"),
    ("get_weather", "current conditions and forecast, for deciding whether to go out"),
    ("get_air", "air quality now and over the next hours, for deciding whether the outing is a cost"),
    ("get_daylight", "sun position, sunrise, sunset, and whether a light is needed"),
]

PRIVACY_POLICIES = [
    "https://wiki.osmfoundation.org/wiki/Privacy_Policy",
    "https://open-meteo.com/en/terms",
]

LONG_DESCRIPTION = """\
supercarto gives an AI agent a map of any location on Earth as a token-budgeted \
topological graph: streets as edges, crossings as junctions, indoor floors and \
levels as separate layers, with weather, terrain, daylight and transit riding \
along. Everything the agent reads is measured in tokens, so one call fits a \
budget and `localize` moves the session for the cost of the delta, not a new map.

Install this bundle and Claude gets the tools with no key of its own: the map \
source is OpenStreetMap and the forecast comes from Open-Meteo. Optional \
configuration:

- an Open-Meteo API key for higher weather rate limits
- a GTFS feed (directory of `.txt` tables or a `.zip`) - schedules the
  transit tools and the departure boards, verified against a whole-metro feed
  (Translink SEQ, 35 MB)
- a GTFS-Realtime TripUpdates URL for the same operator, which decorates the
  boards with live per-trip delays ("bus 433 at 21:08, +27s") and is honest
  about absence: a stop with no prediction shows no live line, never "on time"

Runs from source as a plain Node process with zero npm dependencies. The \
repository (461-test suite, TypeScript/Python wire parity) is linked below.
"""


def build_manifest() -> dict:
    pkg = json.loads((ROOT / "package.json").read_text())
    version = pkg["version"]
    return {
        "manifest_version": "0.3",
        "name": "supercarto",
        "display_name": "supercarto - maps for AI agents",
        "version": version,
        "description": "Token-budgeted map context for AI agents: OSM graph, indoor floors, terrain, weather, air quality, transit.",
        "author": {"name": "Jeffrin James"},
        "repository": {"type": "git", "url": "https://github.com/Unselfisheologism/supercarto"},
        "homepage": "https://supercarto.pages.dev",
        "documentation": "https://github.com/Unselfisheologism/supercarto#readme",
        "support": "https://github.com/Unselfisheologism/supercarto/issues",
        "server": {
            "type": "node",
            "entry_point": "dist/cli/main.js",
            "mcp_config": {
                "command": "node",
                "args": ["${__dirname}/dist/cli/main.js", "mcp"],
                "env": {
                    "SUPERCARTO_OWM_KEY": "${user_config.open_meteo_key}",
                    "SUPERCARTO_GTFS": "${user_config.gtfs_feed}",
                    "SUPERCARTO_GTFS_RT": "${user_config.gtfs_realtime_url}",
                },
            },
        },
        "tools": [
            {"name": name, "description": desc} for name, desc in BASELINE_TOOLS
        ],
        "tools_generated": True,
        "keywords": ["maps", "geospatial", "openstreetmap", "routing", "transit", "gtfs", "weather", "air quality", "terrain", "mcp"],
        "license": "Apache-2.0",
        "privacy_policies": PRIVACY_POLICIES,
        "compatibility": {
            "platforms": ["darwin", "win32", "linux"],
            "runtimes": {"node": ">=18"},
        },
        "user_config": {
            "open_meteo_key": {
                "type": "string",
                "title": "Open-Meteo API key",
                "description": "Optional. Higher weather rate limits; the free tier works without it.",
                "sensitive": True,
                "required": False,
            },
            "gtfs_feed": {
                "type": "string",
                "title": "Local GTFS feed path",
                "description": "Optional. Path to a GTFS feed on this machine - a directory of .txt tables or a feed .zip. Configures the transit schedule tools and departure boards.",
                "required": False,
            },
            "gtfs_realtime_url": {
                "type": "string",
                "title": "GTFS-Realtime TripUpdates URL",
                "description": "Optional. The feed operator's TripUpdates endpoint; adds live per-trip delays to the transit boards. Requires the feed path above.",
                "required": False,
            },
        },
    }


def main() -> None:
    pkg = json.loads((ROOT / "package.json").read_text())
    version = pkg["version"]
    out = ROOT / f"supercarto-{version}.mcpb"

    if subprocess.run(["node", "dist/cli/main.js", "--help"], cwd=ROOT,
                      capture_output=True).returncode != 0:
        sys.exit("dist is stale or missing: run `npm run build` first")

    with tempfile.TemporaryDirectory(prefix="supercarto-mcpb-") as tmp:
        stage = Path(tmp) / "bundle"
        shutil.copytree(ROOT / "dist", stage / "dist")
        for name in ("README.md", "LICENSE", "package.json"):
            shutil.copy2(ROOT / name, stage / name)
        (stage / "manifest.json").write_text(
            json.dumps(build_manifest(), indent=2, ensure_ascii=False) + "\n")

        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for path in sorted(stage.rglob("*")):
                if path.is_file():
                    z.write(path, path.relative_to(stage).as_posix())

    mb = out.stat().st_size / 1e6
    print(f"{out.name} packed: {mb:.1f} MB")


if __name__ == "__main__":
    main()

#!/usr/bin/env bash
# Rebuild the Blume documentation site and lay its static output under the
# hosted site at /docs. The supercarto node package keeps its zero-runtime
# dependency rule intact: this build tooling lives in site-docs/ and ships
# none of it into the package.
#
# Recipe notes from the first build:
# - npm installs of the blume tree hang on npm's serial fetches; pnpm with
#   --node-linker=hoisted finishes in minutes and — the part that matters —
#   hoisting keeps node_modules INSIDE the project, which keeps blume from
#   virtualizing its own .astro components through .blume/tmp/ and failing
#   with "No cached compile metadata found".
# - Google Fonts (fonts.gstatic.com) is unreachable from this host, so the
#   build's self-hosted fonts are pinned to bunny (fonts.bunny.net).
# - Do not delete .blume between builds; it caches Astro compile metadata.
#
# Requires: node >= 22.19, pnpm, and GITHUB_TOKEN (falls back to
# `gh auth token`) for the GitHub Releases changelog source.
set -euo pipefail
cd "$(dirname "$0")/../site-docs"

if [[ ! -d node_modules/blume ]]; then
  pnpm add blume --node-linker=hoisted --prefer-offline
fi

GITHUB_TOKEN="${GITHUB_TOKEN:-$(gh auth token 2>/dev/null || true)}"
npx blume build

SITE_DIR="$(dirname "$0")/../site"
rm -rf "$SITE_DIR/docs"
mkdir -p "$SITE_DIR/docs"
cp -r dist/. "$SITE_DIR/docs/"
echo "docs built into site/docs/ ($(find "$SITE_DIR/docs" -name '*.html' | wc -l) pages)"

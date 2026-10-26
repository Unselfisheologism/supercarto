#!/usr/bin/env bash
# Rebuild the Blume documentation site and lay its static output under the
# hosted site at /docs. The supercarto package keeps its zero-runtime-dep
# rule intact: this build tooling lives in site-docs/ and ships none of it
# into the package.
#
# Requires: node >= 22.19, npm network access, and GITHUB_TOKEN (falls back
# to `gh auth token`) for the GitHub Releases changelog source.
set -euo pipefail
cd "$(dirname "$0")/../site-docs"

if [[ ! -d node_modules ]]; then
  npm install --no-audit --no-fund
fi

GITHUB_TOKEN="${GITHUB_TOKEN:-$(gh auth token 2>/dev/null || true)}"
npx blume build

SITE_DIR="$(dirname "$0")/../site"
rm -rf "$SITE_DIR/docs"
mkdir -p "$SITE_DIR/docs"
cp -r dist/. "$SITE_DIR/docs/"
echo "docs built into site/docs/ ($(find "$SITE_DIR/docs" -name '*.html' | wc -l) pages)"

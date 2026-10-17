#!/usr/bin/env node
// Live-path parity harness, TypeScript reference side.
//
// Drives the real `SuperCarto.maplet` / weather / routing stack in `src/`
// against recorded service responses (no network), and prints a canonical
// JSON report. `scripts/parity/live-py.py` prints the same report from the
// Python port; `bash scripts/parity/check-live.sh` diffs the two.
//
// The requests themselves are also reported (Overpass QL, weather URL, OSRM
// URL) so query-building string parity is part of the gate, not just the
// response handling.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SuperCarto } from '../../src/live.ts';
import { OsrmRouter } from '../../src/source/routing.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures', 'live');

const fixture = (name) => fs.readFileSync(path.join(fixturesDir, name), 'utf8');

const overpassBody = fixture('overpass.json');
const weatherBody = fixture('weather.json');
const routeBody = fixture('route.json');

// The recorded queries are URL-marked; requests to anything else fail like a
// real misconfiguration would.
const recorded = {
  'overpass-api.de': overpassBody,
  'api.open-meteo.com': weatherBody,
  'router.project-osrm.org': routeBody,
};

const requests = {};

function makeFetch(logKey, name) {
  return async (url, init = {}) => {
    const hit = Object.keys(recorded).find((host) => url.includes(host));
    if (!hit) throw new Error(`unexpected request in fixture: ${url}`);
    if (logKey === 'overpass' && init.body) {
      const params = new URLSearchParams(init.body);
      requests.overpassQuery = params.get('data');
    } else {
      requests[logKey] = url;
    }
    return new Response(recorded[hit], { status: 200 });
  };
}

const LAT = 37.75991;
const LON = -122.41425;
const RADIUS = 90;
const NOW = '2026-10-01T12:00:00Z';
const UTC_OFFSET = -420;
const BUDGET = 900;

const carto = new SuperCarto({
  overpass: { fetchImpl: makeFetch('overpass') },
  openMeteo: { fetchImpl: makeFetch('weather') },
  defaultBudget: BUDGET,
});

const m = await carto.maplet({
  lat: LAT,
  lon: LON,
  radiusM: RADIUS,
  budget: BUDGET,
  compile: { now: new Date(NOW), utcOffsetMinutes: UTC_OFFSET },
});

const weather = await carto.weatherAt(LAT, LON, 12);

const router = new OsrmRouter({ fetchImpl: makeFetch('route') });
const route = await router.route({
  from: { lat: LAT, lon: LON },
  to: { lat: 37.76069, lon: -122.41286 },
  mode: 'walk',
});

const report = {
  maplet: {
    yaml: m.yaml,
    tokens: m.metrics.tokens,
    nodes: m.metrics.nodes,
    edges: m.metrics.edges,
    droppedNodes: m.metrics.droppedNodes,
    warnings: m.warnings,
    source: m.fetchedFrom,
    sourceTruncated: m.sourceTruncated,
  },
  weather,
  route,
  requests: {
    overpassQuery: requests.overpassQuery ?? null,
    weather: requests.weather ?? null,
    route: requests.route ?? null,
  },
};

function canonical(value) {
  if (value === undefined) return undefined; // caller omits the key
  if (value === null) return null;
  if (typeof value === 'number') {
    if (Number.isNaN(value) || !Number.isFinite(value)) return undefined;
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical).filter((v) => v !== undefined);
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const v = canonical(value[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return value;
}

process.stdout.write(JSON.stringify(canonical(report)));
process.stdout.write('\n');

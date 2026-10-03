/**
 * Capture one map fixture per benchmark area.
 *
 * The benchmark cannot run live. Measured on 2026-10-03: Overpass served 4 of 8
 * areas, took 54s to 233s per maplet, and returned zero named features for two
 * areas that certainly have them. A 32-task x 3-arm x 8-model run against that is
 * mostly a measurement of the public instance's mood, and every failure lands in
 * the report as a model failure.
 *
 * So each area is captured once, with retries, and every model is then run
 * against identical bytes. That is what makes the comparison between models mean
 * anything: they are answering the same question about the same data.
 *
 *   npx tsx scripts/capture-bench-areas.ts
 *
 * Output: fixtures/bench/<area>.geojson
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'fixtures/bench';

/** The benchmark's areas, kept in step with TASK_AREAS. */
const AREAS = [
  { id: 'sf-cbd', lat: 37.7936, lon: -122.3958, radiusM: 400 },
  { id: 'oslo', lat: 59.9111, lon: 10.7529, radiusM: 400 },
  { id: 'singapore', lat: 1.2838, lon: 103.8591, radiusM: 500 },
  { id: 'tokyo-shimbashi', lat: 35.6833, lon: 139.762, radiusM: 400 },
  { id: 'sydney', lat: -33.8688, lon: 151.2093, radiusM: 400 },
  { id: 'reykjavik', lat: 64.1466, lon: -21.9426, radiusM: 500 },
  { id: 'rural-montana', lat: 46.4, lon: -110.7, radiusM: 2000 },
  { id: 'kuala-lumpur', lat: 3.139, lon: 101.6869, radiusM: 400 },
] as const;

/** Mirrors DEFAULT_LAYERS in src/source/overpass.ts, plus the node layers. */
const WAYS = [
  'highway~"motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|pedestrian|service"',
  'building',
  'railway',
  'waterway',
  'leisure',
  'natural',
];
const NODES = ['amenity', 'shop', 'tourism', 'office'];

function bboxOf(lat: number, lon: number, radiusM: number): [number, number, number, number] {
  const dLat = radiusM / 110_574;
  const dLon = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}
void bboxOf;

/**
 * The query for one area.
 *
 * An `around` query rather than a `bbox` one, and that is not a stylistic
 * choice. Overpass validates a bbox-query by requiring the `n` attribute to be
 * greater than or equal to `s`, and it applies that comparison to the absolute
 * values, so every southern-hemisphere bbox is rejected outright:
 *
 *   Error: line 2: static error: The value of attribute "n" of the element
 *   "bbox-query" must always be greater or equal than the value of attribute "s".
 *
 * Confirmed against Melbourne and Buenos Aires as well, so it is not specific to
 * Sydney. With a negative latitude, `n = -33.865` has a smaller magnitude than
 * `s = -33.872`, and the check fires. Sydney therefore could not be captured at
 * all until this changed - which matters, because the southern hemisphere is
 * chosen precisely to catch a sign error in the y axis, and dropping the area
 * that tests for it would quietly remove the benchmark's hardest case.
 *
 * `around` takes a radius and a point, so no ordered pair of latitudes is ever
 * constructed. It is used for every area rather than only the southern ones, so
 * there is one query shape to reason about and the captured areas stay
 * comparable with each other.
 */
function query(area: { lat: number; lon: number; radiusM: number }): string {
  const r = Math.round(area.radiusM);
  const clauses = [
    ...WAYS.map((f) => `way(around:${r},${area.lat},${area.lon})[${f}];`),
    ...NODES.map((f) => `node(around:${r},${area.lat},${area.lon})[${f}];`),
  ].join('\n    ');
  return `[out:json][timeout:180];(\n    ${clauses}\n);out geom qt 20000;`;
}

interface Element {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

async function capture(area: (typeof AREAS)[number], attempts = 6): Promise<Element[] | null> {
  const body = new URLSearchParams({ data: query(area) }).toString();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, attempt * 5000));
    let text: string;
    try {
      const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'supercarto-bench-fixtures/0.4 (area capture)',
        },
        body,
        signal: AbortSignal.timeout(180_000),
      });
      text = await res.text();
      if (!res.ok) {
        console.log(`  ${area.id}: HTTP ${res.status}, retrying`);
        continue;
      }
    } catch (e) {
      console.log(`  ${area.id}: ${e instanceof Error ? e.message : String(e)}, retrying`);
      continue;
    }
    let elements: Element[];
    try {
      elements = (JSON.parse(text) as { elements?: Element[] }).elements ?? [];
    } catch {
      console.log(`  ${area.id}: not JSON, retrying`);
      continue;
    }
    if (elements.length === 0) {
      console.log(`  ${area.id}: 0 elements, retrying`);
      continue;
    }
    // Named features matter: the nearest-poi task is scored against names, so a
    // fixture without them would score every model as a failure for the harness's
    // reason. Requiring them here turns a silent scoring hole into a capture retry.
    const named = elements.filter((e) => e.tags?.name).length;
    if (named === 0 && attempt < attempts) {
      console.log(`  ${area.id}: ${elements.length} elements but 0 named, retrying`);
      continue;
    }
    console.log(`  ${area.id}: ${elements.length} elements, ${named} named`);
    return elements;
  }
  return null;
}

/** Overpass elements to the GeoJSON the ingest path understands. */
function toGeoJson(elements: Element[]): unknown {
  const features = elements.map((e) => {
    const geometry =
      e.type === 'way' && e.geometry
        ? { type: 'LineString', coordinates: e.geometry.map((g) => [g.lon, g.lat]) }
        : e.lat !== undefined && e.lon !== undefined
          ? { type: 'Point', coordinates: [e.lon, e.lat] }
          : null;
    return {
      type: 'Feature',
      id: e.id,
      properties: e.tags ?? {},
      geometry,
    };
  });
  return { type: 'FeatureCollection', features };
}

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

let ok = 0;
for (const area of AREAS) {
  const path = join(OUT, `${area.id}.geojson`);
  if (existsSync(path) && !process.argv.includes('--force')) {
    const existing = JSON.parse(readFileSync(path, 'utf8')) as { features: unknown[] };
    console.log(`${area.id}: cached, ${existing.features.length} features`);
    ok++;
    continue;
  }
  console.log(`${area.id}: capturing`);
  const elements = await capture(area);
  if (!elements) {
    console.log(`${area.id}: GAVE UP`);
    continue;
  }
  const fc = toGeoJson(elements);
  writeFileSync(path, JSON.stringify(fc));
  console.log(`${area.id}: wrote ${(fc as { features: unknown[] }).features.length} features`);
  ok++;
}
console.log(`\n${ok}/${AREAS.length} areas available in ${OUT}`);
if (ok < AREAS.length) process.exitCode = 1;
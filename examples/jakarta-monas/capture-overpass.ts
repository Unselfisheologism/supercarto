/**
 * One bounded Overpass capture of the area around Monas (Gambir, Jakarta).
 *
 * Run once, by hand, against the public overpass-api.de instance; the saved
 * files are what everything downstream compiles from, offline. The internal
 * retry budget of the source is capped at one extra attempt and a rate-limit
 * response stops the run: a hammering script against the shared instance is
 * what made it refuse us before (see test/fixtures/overpass.ts).
 *
 *   npx tsx examples/jakarta-monas/capture-overpass.ts
 *
 * Writes, next to this file:
 *   raw-overpass.json      the raw Overpass response, never edited
 *   capture-meta.json      machine-readable date, bbox, warnings, attribution
 *   jakarta-monas.geojson  the features the compiler ingests
 *   CAPTURE.md             date, bbox, queries sent, attribution
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OverpassSource, OVERPASS_ENDPOINT } from '../../src/source/overpass.js';
import { bboxAround } from '../../src/source/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Monas, Central Jakarta — the National Monument (OSM way 1625548). */
const CENTER = { lat: -6.1754, lon: 106.8272 };
const RADIUS_M = 300;
const CAP_MAX_ATTEMPTS = 2; // initial call + at most one retry

const bbox = bboxAround(CENTER.lat, CENTER.lon, RADIUS_M);

/**
 * A `fetch` that records what was asked and what came back, untouched.
 *
 * The adapter consumes the body through its own parser, so the wrapper keeps
 * the raw text here. Throttle responses are recorded and count as a refusal;
 * OverpassSource backs off once, and a second refusal lifts the error above.
 */
const log: Array<{ query: string; status: number; receivedAt: string; error?: string }> = [];
let rawBody = '';         // most recent response body, exactly as served
let cleanQuery = '';      // query of that response, when served with 200
const recordingFetch = (async (
  url: string | URL | globalThis.Request,
  init?: globalThis.RequestInit,
) => {
  let query = '';
  if (typeof init?.body === 'string') {
    // The adapter POSTs form-encoded `data=<query>`.
    query = new URLSearchParams(init.body).get('data') ?? '';
  }
  const receivedAt = new Date().toISOString();
  try {
    const res = await globalThis.fetch(url, init);
    const text = await res.text();
    log.push({ query, status: res.status, receivedAt });
    if (res.status === 200 && /^\s*\{/.test(text)) {
      rawBody = text;
      cleanQuery = query;
    }
    return new Response(text, { status: res.status, headers: res.headers });
  } catch (err) {
    log.push({
      query, status: 0, receivedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}) as unknown as typeof fetch;

const source = new OverpassSource({
  fetchImpl: recordingFetch,
  // Attempts over the default 4: one refusal is allowed an automatic retry,
  // further attempts never happen here.
  maxAttempts: CAP_MAX_ATTEMPTS,
});

let result;
try {
  result = await source.fetch({
    bbox,
    layers: [], // default layer set, in the adapter's priority order
    maxFeatures: 4000, // stays under the instance's 5,000-place degradation cliff
  });
} catch (err) {
  writeFileSync(
    join(HERE, 'raw-overpass.json'),
    JSON.stringify({ stopped: String(err), requests: log }, null, 2),
  );
  console.error(`capture stopped: ${String(err)}\nNo further retry on rate limiting. Run later, or point OVERPASS_ENDPOINT at a self-hosted mirror.`);
  process.exit(1);
}

if (cleanQuery === '') {
  console.error('no clean 200 response to record; refusing to save partial output');
  process.exit(1);
}
writeFileSync(join(HERE, 'raw-overpass.json'), rawBody);
writeFileSync(join(HERE, 'jakarta-monas.geojson'), JSON.stringify(
  { type: 'FeatureCollection', features: result.features }, null, 1,
));

const attr = '© OpenStreetMap contributors, ODbL — https://www.openstreetmap.org/copyright';

writeFileSync(
  join(HERE, 'capture-meta.json'),
  JSON.stringify({
    timestamp: log.find((r) => r.query === cleanQuery)?.receivedAt,
    endpoint: OVERPASS_ENDPOINT,
    center: { lat: CENTER.lat, lon: CENTER.lon, label: 'Monas, Central Jakarta' },
    radiusM: RADIUS_M,
    bbox: { west: +bbox.west.toFixed(6), south: +bbox.south.toFixed(6), east: +bbox.east.toFixed(6), north: +bbox.north.toFixed(6) },
    attempts: log.length,
    truncated: result.truncated,
    attribution: attr,
    warnings: result.warnings,
  }, null, 2),
);
writeFileSync(
  join(HERE, 'CAPTURE.md'),
  `# Capture

Date: ${captureDate}
Endpoint: ${OVERPASS_ENDPOINT}
Centre: Monas, Central Jakarta (lat ${CENTER.lat}, lon ${CENTER.lon})
Radius estimate: ${RADIUS_M} m
Bounding box: west=${bbox.west.toFixed(6)}, south=${bbox.south.toFixed(6)}, east=${bbox.east.toFixed(6)}, north=${bbox.north.toFixed(6)}
Retry budget: ${CAP_MAX_ATTEMPTS - 1} extra attempt(s); stops on rate limiting

## Queries sent

${log.map((r, i) => `### attempt ${i + 1} — status ${r.status}, at ${r.receivedAt}\n\n\`\`\`\n${r.query}\n\`\`\``).join('\n\n')}

## Provenance

\`raw-overpass.json\` is the raw body of attempt ${log.findIndex((r) => r.query === cleanQuery) + 1}, served with HTTP 200.
It is the exact response that \`jakarta-monas.geojson\` compiled from.
${result.truncated ? 'The result was truncated at the feature cap; the box is not fully covered.' : 'The result was not truncated.'}
Warnings: ${result.warnings.length ? JSON.stringify(result.warnings, null, 2) : 'none'}

Attribution: ${attr}

This is real Jakarta data. Do not replace these files with synthetic output;
synthesize for tests only (see examples/synthetic-dense.geojson).
`,
);

console.log(`captured ${result.features.length} features (${result.truncated ? 'truncated' : 'complete'}) in ${log.length} request(s)`);

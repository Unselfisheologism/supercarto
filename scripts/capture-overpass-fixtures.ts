export {};

// Record real Overpass responses, verbatim, for use as offline fixtures.
//
// Compresses the body so a large response does not bloat the repo. Two capture
// modes are supported and both were needed:
//
//   fixture node 37.775,-122.4194,37.776,-122.418   - tiny box, known good
//   fixture big  37.7749,-122.4194,500               - past the size cliff
//
// The point is to capture upstream *misbehaviour*, not just good data: a fixture
// that only ever contains clean responses cannot catch the bugs that matter.

/**
 * Capture Overpass fixtures. Re-run when the upstream behaviour we defend
 * against needs refreshing:
 *
 *   npx tsx scripts/capture-overpass-fixtures.ts
 *
 * The instance is shared and rate-limited, so this backs off and retries rather
 * than assuming a clean first response. Capturing corrupt responses is the point -
 * do not discard them.
 */

import { gzipSync } from 'node:zlib';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const OUT = 'fixtures/overpass';

async function capture(name: string, query: string): Promise<void> {
  // The shared instance fails often enough that a capture script without
  // retries is useless. Each attempt waits longer than the last.
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, attempt * 8000));
    let res: Response;
    try {
      res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'supercarto/0.2.0 (fixture capture)',
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      console.log(`${name}: attempt ${attempt} threw, retrying`);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      console.log(`${name}: HTTP ${res.status} on attempt ${attempt}`);
      continue;
    }
    try {
      JSON.parse(text);
    } catch {
      console.log(`${name}: response is not JSON, retrying`);
      continue;
    }
    if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
    const gz = gzipSync(Buffer.from(text, 'utf8'), { level: 9 });
    writeFileSync(`${OUT}/${name}.json.gz`, gz);
    const els = (JSON.parse(text) as { elements?: unknown[] }).elements?.length ?? 0;
    console.log(`${name}: ${els} elements, ${text.length}B -> ${gz.length}B`);
    return;
  }
  console.log(`${name}: gave up after 5 attempts`);
}

const bbox = (w: number, s: number, e: number, n: number) => `(bbox:${s},${w},${n},${e})`;

// A small box, which the instance serves correctly. Includes ways, so it can
// stand in for "a smaller retry that works" - a points-only fixture could not
// prove streets are recovered.
await capture(
  'sf-small',
  `[out:json][timeout:25];(\n` +
    `    node${bbox(-122.423, 37.773, -122.416, 37.777)}[amenity];\n` +
    `    way${bbox(-122.423, 37.773, -122.416, 37.777)}[highway=primary];\n` +
    `    way${bbox(-122.423, 37.773, -122.416, 37.777)}[highway=residential];\n` +
    `    way${bbox(-122.423, 37.773, -122.416, 37.777)}[highway=tertiary];\n` +
    `);out geom qt 2000;`,
);

// A large box. This is the case that matters: the instance either refuses it
// (504) or serves corrupt way geometry, and both are captured below when they
// happen. Retried, because the outcome is not deterministic.
for (let i = 1; i <= 4; i++) {
  const name = `sf-large-${i}`;
  await capture(
    name,
    `[out:json][timeout:25];(\n` +
      `    way${bbox(-122.433, 37.769, -122.406, 37.79)}[highway=primary];\n` +
      `    way${bbox(-122.433, 37.769, -122.406, 37.79)}[highway=residential];\n` +
      `    node${bbox(-122.433, 37.769, -122.406, 37.79)}[amenity];\n` +
      `);out geom qt 5000;`,
  );
  await new Promise((r) => setTimeout(r, 6000));
}

// London, which returned transposed latitudes (51.5 served as 5.5).
await capture(
  'london-corrupt',
  `[out:json][timeout:25];(\n` +
    `    node${bbox(-0.14, 51.5, -0.11, 51.52)}[amenity];\n` +
    `    way${bbox(-0.14, 51.5, -0.11, 51.52)}[highway=primary];\n` +
    `);out geom qt 5000;`,
);

// A genuinely empty area is NOT captured from the network.
//
// The instance answers a query over open ocean or polar ice with
// `{"elements": []}`, and that body is fully reproducible, so there is nothing
// to record. The empty-result behaviour - retry it, then believe it rather than
// calling it a failure - is covered in test/live.test.ts with a synthesized
// empty response. Spending shared-server quota to capture a fixture whose
// content is known exactly would be the wrong trade.
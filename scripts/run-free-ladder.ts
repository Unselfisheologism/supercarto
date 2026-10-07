/**
 * Run the free-model ladder against captured fixtures.
 *
 * Offline except for OSRM, which supplies route and turn-by-turn ground truth.
 * Every model sees byte-identical prompts, because the map data comes from a
 * file rather than from a live fetch that changes between runs.
 *
 *   npx tsx scripts/run-free-ladder.ts --budget 200
 *   npx tsx scripts/run-free-ladder.ts --model opencode/fledge-alpha-free
 *   npx tsx scripts/run-free-ladder.ts --report report.json
 *
 * Resumable: every exchange is archived under --out, and a rerun continues.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runLadder } from '../src/bench/ladder.js';
import { FREEMODELS } from '../src/bench/driver/opencode.js';
import { OpencodeDriver } from '../src/bench/driver/opencode.js';
import type { GeoJsonFeatureCollection } from '../src/index.js';

const FIXTURE_DIR = 'fixtures/bench';

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

/** Every captured area, keyed the way the runner's `fixtures` option expects. */
function loadFixtures(): Record<string, GeoJsonFeatureCollection> {
  if (!existsSync(FIXTURE_DIR)) {
    throw new Error(
      `no fixtures in ${FIXTURE_DIR}. Run: npx tsx scripts/capture-bench-areas.ts`,
    );
  }
  const out: Record<string, GeoJsonFeatureCollection> = {};
  for (const f of readdirSync(FIXTURE_DIR)) {
    if (!f.endsWith('.geojson')) continue;
    const id = f.replace(/\.geojson$/, '');
    out[id] = JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8'));
  }
  const empty = Object.entries(out).filter(([, v]) => v.features.length === 0);
  for (const [id] of empty) delete out[id];
  console.log(`fixtures: ${Object.keys(out).length} area(s) loaded`);
  for (const [id, v] of Object.entries(out)) {
    const named = v.features.filter(
      (x) => typeof (x.properties as Record<string, unknown> | null)?.name === 'string',
    ).length;
    console.log(`  ${id.padEnd(16)} ${String(v.features.length).padStart(6)} features, ${named} named`);
  }
  return out;
}

const fixtures = loadFixtures();
if (Object.keys(fixtures).length === 0) {
  console.error('no usable fixtures; nothing to run');
  process.exit(1);
}

const only = arg('--only');
const model = arg('--model');
const outDir = arg('--out', '.bench')!;
const budget = Number(arg('--budget', '60'));
const seeds = Number(arg('--seeds', '1'));

const models = model ? [model] : [...FREEMODELS];
console.log(`\nmodels: ${models.length}`);
console.log(`budget: ${budget} calls this invocation`);
console.log(`seeds: ${seeds}\n`);

const results = await runLadder({
  models,
  outDir,
  seeds,
  stopOnRateLimit: true,
  fixtures,
  makeClient: (m: string) => new OpencodeDriver({ model: m }),
  onProgress: (m: string) => console.log(m),
});

// A machine-readable summary, so the numbers can be diffed and audited rather
// than read off a terminal.
const report = {
  generatedAt: new Date().toISOString(),
  protocol: {
    temperature: 0,
    seeds,
    note:
      'Free-tier models reached through `opencode run --standalone`. Token counts ' +
      'are chars/4 estimates: the free tier reports no usage block, so the ' +
      'provider tokenizer the docs call for is not available on this path.',
    toolPolicy:
      'A run that invoked any tool is voided, not scored. Tool use cannot be ' +
      'prevented on this CLI, so a cheating model produces a failed run rather ' +
      'than a prevented one.',
  },
  fixtures: Object.fromEntries(
    Object.entries(fixtures).map(([k, v]) => [k, v.features.length]),
  ),
  models: results.map((r) => ({
    model: r.model,
    rows: r.rows.length,
    failures: r.failures.length,
    rateLimited: !!r.rateLimited,
    summary: r.summary,
  })),
};
const reportPath = arg('--report');
if (reportPath) {
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${reportPath}`);
}

console.log('\n=== summary ===');
for (const r of results) {
  console.log(`\n${r.model}  (${r.rows.length} rows, ${r.failures.length} failed${r.rateLimited ? ', RATE LIMITED' : ''})`);
  for (const s of r.summary) {
    console.log(
      `  ${s.representation.padEnd(11)} acc=${s.accuracy ?? 'n/a'}  completion=${s.completion ?? 'n/a'}  spread=${s.accuracySpread}`,
    );
  }
}
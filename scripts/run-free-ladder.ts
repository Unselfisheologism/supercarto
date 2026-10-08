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
import { completedCalls } from '../src/bench/cli-run.js';
import { FREEMODELS } from '../src/bench/driver/opencode.js';
import { OpencodeDriver } from '../src/bench/driver/opencode.js';
import { buildTasks, TASK_AREAS } from '../src/bench/tasks.js';
import { runMetadata } from '../src/bench/metadata.js';
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
// Default 1, i.e. serial. A free tier that starts refusing requests turns each
// refusal into a failed row, and a failed row is recorded as a model failure, so
// raising this is a decision about pressure rather than a free speedup.
const concurrency = Number(arg('--concurrency', '1'));

const models = model ? [model] : [...FREEMODELS];
const allTasks = buildTasks(TASK_AREAS).map((t) => t.id);
const totalCalls = allTasks.length * 3 * seeds * models.length;

console.log(`\nmodels: ${models.length}`);
console.log(`seeds: ${seeds}`);
console.log(`concurrency: ${concurrency}`);
console.log(`budget: ${budget} calls this invocation, of ${totalCalls} total`);
console.log(`already archived: ${completedCalls(outDir, models)}`);
console.log(`out: ${outDir}\n`);

if (budget <= 0) {
  console.error('--budget must be a positive number of model calls');
  process.exit(1);
}

/**
 * The call ceiling, enforced by shortening the task list.
 *
 * `--budget` used to be read, printed, and then ignored: `runLadder` took the
 * whole task list every time. A printed ceiling that does not bound anything is
 * worse than no ceiling, because the operator believes the run is bounded when it
 * is not, and a free tier that starts refusing requests turns every refusal into
 * a row scored as a model failure.
 *
 * Truncating the task list ends the invocation while there is still quota, which
 * is the same approach `cli-run.ts` takes. Resume continues from the archive.
 */
const perModel = Math.max(1, Math.floor(budget / models.length));
const selected = only
  ? allTasks.filter((t) => t.startsWith(`${only}/`) || t === only)
  : allTasks;
const capped = selected.slice(0, perModel);

if (capped.length < selected.length) {
  console.log(
    `running ${capped.length}/${selected.length} tasks per model to stay inside the budget`,
  );
  console.log('rerun later with the same --out to continue from where this stopped\n');
} else {
  console.log('');
}

const results = await runLadder({
  models,
  outDir,
  seeds,
  only: capped,
  stopOnRateLimit: true,
  fixtures,
  concurrency,
  makeClient: (m: string) => new OpencodeDriver({ model: m }),
  onProgress: (m: string) => console.log(m),
});

// A machine-readable summary, so the numbers can be diffed and audited rather
// than read off a terminal.
const report = {
  metadata: runMetadata({ models, fixtures }),
  protocol: {
    repeats: seeds,
    // Stated because a report asserting "temperature 0" for a path that cannot
    // set it is the kind of claim that survives until someone re-runs it.
    temperature: null,
    seed: null,
    note:
      'Free-tier models reached through `opencode run --standalone`. The CLI has ' +
      'no --temperature and no --seed flag, so neither reaches the model: ' +
      '`repeats` are repeats, not independent seeds, and a spread of 0 is not ' +
      'an error bar. Token counts are chars/4 estimates because the free tier ' +
      'reports no usage block.',
    toolPolicy:
      'A run that invoked any tool is voided, not scored. Tool use cannot be ' +
      'prevented on this CLI, so a cheating model produces a failed run rather ' +
      'than a prevented one.',
  },
  budget: { callsThisInvocation: budget, totalPlanned: totalCalls, concurrency },
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
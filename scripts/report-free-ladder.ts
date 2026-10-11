/**
 * Score every archived free-model run and print the tables.
 *
 *   npx tsx scripts/report-free-ladder.ts --out .bench --report report.json
 *
 * Reads the archives rather than calling any model, so the tables can be
 * regenerated after a scoring change without spending anything. Ground truth is
 * rebuilt from the fixtures and OSRM, the same way the run built it.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rescore } from '../src/bench/rescore.js';
import { failures, median, summarise } from '../src/bench/score.js';
import type { ScoredTask } from '../src/bench/score.js';
import { TASK_AREAS, SYNTHETIC_AREA } from '../src/bench/tasks.js';
import type { GeoJsonFeatureCollection } from '../src/index.js';

const FIXTURE_DIR = 'fixtures/bench';

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

function loadFixtures(): Record<string, GeoJsonFeatureCollection> {
  const out: Record<string, GeoJsonFeatureCollection> = {};
  if (!existsSync(FIXTURE_DIR)) return out;
  for (const f of readdirSync(FIXTURE_DIR)) {
    if (!f.endsWith('.geojson')) continue;
    out[f.replace(/\.geojson$/, '')] = JSON.parse(
      readFileSync(join(FIXTURE_DIR, f), 'utf8'),
    );
  }
  return out;
}

const dir = arg('--out', '.bench')!;
if (!existsSync(dir)) {
  console.error(`no archives in ${dir}`);
  process.exit(1);
}

const archives = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && f !== 'results.jsonl');
if (archives.length === 0) {
  console.error(`no model archives in ${dir}`);
  process.exit(1);
}

const fixtures = loadFixtures();
const allRows: ScoredTask[] = [];
const perModel = new Map<string, ScoredTask[]>();

for (const file of archives) {
  const model = file.replace(/\.jsonl$/, '');
  const { rows } = await rescore({
    archive: join(dir, file),
    fixtures,
    // The synthetic area is not in TASK_AREAS, and rescore builds its task list
    // from the areas it is given - so without this it drops every synthetic row on
    // the floor and reports a table of dashes that looks like "nothing archived".
    // Third instance of the same defect: areas not threaded through the harness.
    areas: [...TASK_AREAS, SYNTHETIC_AREA],
  });
  perModel.set(model, rows);
  allRows.push(...rows);
}

const REPS = ['supercarto', 'geojson', 'none'] as const;
const pct = (n: number | null) => (n === null ? '   n/a' : `${(n * 100).toFixed(0).padStart(4)}%`);

console.log('='.repeat(92));
console.log('SUPERCARTO BENCHMARK - free models via `opencode run`');
console.log('='.repeat(92));

// --- completion and accuracy, per model per arm -------------------------------
console.log('\nCOMPLETION (rows that produced a scoreable answer)');
console.log('  model'.padEnd(42) + REPS.map((r) => r.padStart(12)).join(''));
for (const model of [...perModel.keys()].sort()) {
  const rows = perModel.get(model)!;
  const cells = REPS.map((rep) => {
    const sub = rows.filter((r) => r.representation === rep);
    if (!sub.length) return '         -';
    const s = summarise(sub, rep, model);
    return pct(s.completion).padStart(12);
  });
  console.log('  ' + model.padEnd(42) + cells.join(''));
}

console.log('\nACCURACY (over answered rows only; failures excluded, not counted wrong)');
console.log('  model'.padEnd(42) + REPS.map((r) => r.padStart(12)).join(''));
for (const model of [...perModel.keys()].sort()) {
  const rows = perModel.get(model)!;
  const cells = REPS.map((rep) => {
    const sub = rows.filter((r) => r.representation === rep);
    if (!sub.length) return '         -';
    const s = summarise(sub, rep, model);
    return pct(s.accuracy).padStart(12);
  });
  console.log('  ' + model.padEnd(42) + cells.join(''));
}

// --- failures, by cause --------------------------------------------------------
console.log('\nFAILURES BY CAUSE');
const causes = new Map<string, number>();
for (const r of allRows) {
  if (r.error === undefined) continue;
  const key = /exceeded \d+ms/.test(r.error)
    ? 'timeout'
    : /used tools/.test(r.error)
      ? 'used tools (voided)'
      : /no text output/.test(r.error)
        ? 'no text output'
        : r.error.slice(0, 50);
  causes.set(key, (causes.get(key) ?? 0) + 1);
}
if (causes.size === 0) console.log('  none');
for (const [k, n] of [...causes].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}x  ${k}`);
}

// --- per-task-kind accuracy ----------------------------------------------------
console.log('\nACCURACY BY TASK KIND (supercarto arm, all models pooled)');
const scRows = allRows.filter((r) => r.representation === 'supercarto');
// Task kind is the middle segment; the id also carries `#rep@budget`, which is
// configuration rather than kind and would otherwise appear in this column.
const kindOf = (taskId: string): string => (taskId.split('#')[0] ?? '').split('/')[1] ?? '?';
const kinds = [...new Set(scRows.map((r) => kindOf(r.taskId)))].sort();
console.log('  kind'.padEnd(20) + 'answered'.padStart(10) + 'correct'.padStart(10) + 'rate'.padStart(8));
for (const kind of kinds) {
  const sub = scRows.filter((r) => kindOf(r.taskId) === kind);
  const answered = sub.filter((r) => r.correct !== null);
  const ok = answered.filter((r) => r.correct === true).length;
  console.log(
    `  ${kind.padEnd(18)}${String(answered.length).padStart(10)}${String(ok).padStart(10)}` +
      `${(answered.length ? pct(ok / answered.length) : '    -').padStart(8)}`,
  );
}

// --- the none-arm sanity check -------------------------------------------------
//
// This arm is the floor the whole comparison rests on, so it is worth reading
// closely rather than as a pass/fail. A model with no map can still score: it may
// have memorised the city. On sf-cbd the `none` arm produced a correct turn-by-turn
// answer naming Market, Spear, Mission and Drumm - real downtown streets it was
// never shown. That is not leakage between arms, but it does mean the floor is
// higher for a well-known city than the geometry warrants, and a supercarto win
// measured against it is a smaller win than it looks.
console.log('\nFLOOR CHECK (the `none` arm should score near zero)');
const noneRows = allRows.filter((r) => r.representation === 'none');
const noneAnswered = noneRows.filter((r) => r.correct !== null);
const noneOk = noneAnswered.filter((r) => r.correct === true).length;
const floorHigh = noneAnswered.length > 0 && noneOk > noneAnswered.length * 0.25;
console.log(
  `  none arm: ${noneOk}/${noneAnswered.length} correct` +
    (floorHigh ? '  <-- HIGH. Likely memorised city knowledge rather than leakage' : '  (as expected)'),
);

// The comparison that matters, and the one a headline number hides: does the arm
// given the map beat the arm given nothing, task by task?
//
// A raised floor does not merely shrink the gap, it can invert it. Measured on
// sf-cbd: the `none` arm answered the turn-by-turn question with 863m via Market
// Street -> Spear Street -> Mission Street against OSRM's 868m via the same
// sequence, while the supercarto arm - correctly reporting that the maplet has no
// routable street-name layer - refused and scored zero. The arm with no map beat
// the arm with the map, on the task the library exists to support.
const byTask = new Map<string, { none: number; supercarto: number; n: number }>();
for (const r of allRows) {
  if (r.correct === null) continue;
  const key = r.taskId.split('#')[0]!;
  const e = byTask.get(key) ?? { none: 0, supercarto: 0, n: 0 };
  if (r.representation === 'none' && r.correct) e.none++;
  if (r.representation === 'supercarto' && r.correct) e.supercarto++;
  e.n++;
  byTask.set(key, e);
}
const inverted = [...byTask.entries()].filter(([, e]) => e.none > e.supercarto);
if (inverted.length > 0) {
  console.log(`\n  INVERTED (the floor is ABOVE the treatment) in ${inverted.length} task(s):`);
  for (const [task, e] of inverted) {
    console.log(
      `    ${task.padEnd(26)} none ${e.none}/${e.n}  >  supercarto ${e.supercarto}/${e.n}`,
    );
  }
  console.log(
    '      supercarto-minus-none is NEGATIVE here. This is not a small effect and\n' +
      '      not a leak: the model is recalling a city centre it has memorised, and\n' +
      '      the maplet is honest about what it omits while the scorer rewards a\n' +
      '      confident answer. Do not quote a supercarto advantage for these areas.',
  );
}

if (floorHigh && inverted.length === 0) {
  console.log(
    '      raises the floor: the areas here are well-known cities and a model can\n' +
      '      answer from memory. Treat the supercarto-minus-none gap as a lower bound\n' +
      '      on the real advantage, not the advantage itself.',
  );
}

// --- machine-readable ----------------------------------------------------------
const summary = [...perModel.keys()].sort().flatMap((model) =>
  REPS.map((rep) => {
    const sub = perModel.get(model)!.filter((r) => r.representation === rep);
    if (!sub.length) return null;
    return { model, ...summarise(sub, rep, model), failures: failures(sub).length };
  }).filter(Boolean),
);

const report = {
  generatedAt: new Date().toISOString(),
  models: [...perModel.keys()].sort(),
  archives: archives.length,
  rows: allRows.length,
  /**
   * Per-row verdicts, not just the count.
   *
   * A count cannot answer the only question a scoring change poses: which rows
   * moved, and why. Two reports with identical summaries can differ on every row
   * and still print the same table, which is how "no summary row changed" gets
   * mistaken for "nothing was affected".
   */
  detail: allRows.map((r) => ({
    taskId: r.taskId,
    model: r.model,
    representation: r.representation,
    seed: r.seed,
    correct: r.correct,
    scoredBy: r.scoredBy,
    rationale: r.rationale ?? null,
    error: r.error ?? null,
  })),
  fixtures: Object.fromEntries(Object.entries(fixtures).map(([k, v]) => [k, v.features.length])),
  summary,
  failures: [...causes].map(([cause, n]) => ({ cause, n })),
};

const reportPath = arg('--report');
if (reportPath) {
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${reportPath}`);
}
console.log(
  `\nrows: ${allRows.length} across ${archives.length} model archive(s). ` +
    `Median prompt tokens (supercarto): ${median(scRows.map((r) => r.inputTokens))}.`,
);
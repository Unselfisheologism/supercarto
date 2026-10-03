/**
 * Budget-aware benchmark runner.
 *
 * Arena's free tier is metered and does not publish its limit, so the run is
 * planned against a call budget rather than assumed to fit. Each invocation
 * spends what it can, archives everything, and stops cleanly at the ceiling.
 *
 * Because every response is archived as it lands, the next invocation resumes
 * rather than restarting. Running the whole ladder is therefore a matter of
 * invoking this repeatedly once the limit resets.
 *
 *   npx supercarto bench --budget 30
 *   npx supercarto bench --budget 30          # picks up where it left off
 *   npx supercarto bench --budget 30 --model claude-haiku-4-5-20251001
 *   npx supercarto bench --budget 0 --dry     # report the plan, call nothing
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildTasks, TASK_AREAS } from './tasks.js';
import { LADDER, runLadder } from './ladder.js';
import { FREEMODELS, OpencodeDriver } from './driver/opencode.js';
import { archiveName, ResponseArchive } from './archive.js';

export interface BenchPlan {
  outDir: string;
  models: string[];
  tasks: string[];
  totalCalls: number;
  budget: number;
  seeds: number;
  dry: boolean;
}

export function planBench(
  argv: string[],
  opts: { driver?: 'arena' | 'opencode' } = {},
): BenchPlan {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const outDir = get('--out') ?? join(process.cwd(), '.bench');
  const model = get('--model');
  const only = get('--only');
  const seeds = Number(get('--seeds') ?? '1');
  const budget = Number(get('--budget') ?? '30');
  const dry = argv.includes('--dry') || argv.includes('--dry-run');

  // The default ladder is arena's, which only makes sense for the arena driver.
  // The opencode models are a different set entirely.
  const models = model ? [model] : opts.driver === 'opencode' ? [...FREEMODELS] : [...LADDER];
  const tasks = buildTasks(TASK_AREAS)
    .filter((t) => !only || t.id.startsWith(`${only}/`) || t.id === only)
    .map((t) => t.id);

  // Three representations per task, per seed. The budget sweep is not counted
  // here because a single-budget run is what a metered provider can afford.
  const totalCalls = tasks.length * 3 * seeds;

  mkdirSync(outDir, { recursive: true });
  return { outDir, models, tasks, totalCalls, budget, seeds, dry };
}

/** Calls already archived, so a resumed run reports real remaining work. */
export function completedCalls(outDir: string, models: string[]): number {
  return models.reduce(
    (n, m) => n + ResponseArchive.keys(join(outDir, archiveName(m))).size,
    0,
  );
}

export async function runBench(
  argv: string[],
  opts: { driver?: 'arena' | 'opencode' } = {},
): Promise<number> {
  const plan = planBench(argv, opts);

  console.log(`plan: ${plan.models.length} model(s) x ${plan.tasks.length} tasks x 3 arms x ${plan.seeds} seed(s)`);
  console.log(`total ${plan.totalCalls} calls, this invocation capped at ${plan.budget}`);
  console.log(`already archived: ${completedCalls(plan.outDir, plan.models)}`);
  console.log(`out: ${plan.outDir}`);

  if (plan.tasks.length === 0) {
    console.error('no tasks matched the filter; nothing to run');
    return 1;
  }

  if (plan.dry) {
    console.log('\ndry run. task ids:');
    for (const t of plan.tasks) console.log(`  ${t}`);
    for (const m of plan.models) {
      const p = join(plan.outDir, archiveName(m));
      const have = existsSync(p) ? ResponseArchive.keys(p).size : 0;
      console.log(`  ${m}: ${have}/${plan.totalCalls} done`);
    }
    return 0;
  }

  // The budget is enforced by capping the task list, not by racing the model.
  // A ceiling on concurrency would not stop us being cut off mid-run, whereas a
  // shorter task list ends the invocation while there is still quota left.
  const perModel = Math.max(1, Math.floor(plan.budget / plan.models.length));
  const selected = plan.tasks.slice(0, perModel);

  if (selected.length < plan.tasks.length) {
    console.log(
      `\nrunning ${selected.length}/${plan.tasks.length} tasks per model to stay inside the budget`,
    );
    console.log('rerun later with the same --out to continue from where this stopped');
  }

  const results = await runLadder({
    models: plan.models,
    outDir: plan.outDir,
    only: selected,
    seeds: plan.seeds,
    stopOnRateLimit: true,
    // A driver, not a client. runLadder does the archiving, so returning an
    // ArchivingClient here would write every exchange twice - once through the
    // inner client and once through the outer one - because each holds its own
    // dedupe set and neither knows about the other.
    ...(opts.driver === 'opencode'
      ? { makeClient: (model: string) => new OpencodeDriver({ model }) }
      : {}),
    onProgress: (m) => console.log(`  ${m}`),
  });

  let rateLimited = false;
  for (const r of results) {
    const failed = r.failures.length;
    console.log(
      `\n${r.model}: ${r.rows.length} rows, ${failed} failed` +
        (r.rateLimited ? '  [RATE LIMITED]' : ''),
    );
    if (r.rateLimited) rateLimited = true;
    const path = join(plan.outDir, 'results.jsonl');
    appendFileSync(
      path,
      `${JSON.stringify({
        model: r.model,
        at: new Date().toISOString(),
        rows: r.rows.length,
        failed,
        rateLimited: !!r.rateLimited,
        summary: r.summary,
      })}\n`,
    );
  }

  const total = completedCalls(plan.outDir, plan.models);
  console.log(`\narchived ${total} exchanges in ${plan.outDir}`);
  if (rateLimited) {
    console.log('stopped by arena rate limit. rerun later with the same --out to continue.');
  }
  return 0;
}
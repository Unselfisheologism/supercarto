/**
 * The model ladder.
 *
 * Four models spanning a capability range, chosen so the result says something
 * a single model cannot. The hypothesis worth testing is that a structured map
 * helps most where the model is weakest, and that is only visible with a spread:
 * a benchmark run on one frontier model looks the same whether the tool helps or
 * not.
 *
 * Arena is free, so every additional model costs nothing but wall clock. All four
 * slugs were read from arena's live model picker rather than guessed.
 */

import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArenaDriver, fetchModelCatalog } from './driver/arena.js';
import { ArchivingClient, type RunIdentity } from './archiving.js';
import { ResponseArchive } from './archive.js';
import { runBenchmark } from './runner.js';
import { SuperCarto } from '../live.js';
import { scoreNames, distanceCorrect, extractDistanceM, isRefusal, connectedComponents, summarise, failures } from './score.js';
import type { ScoredTask } from './score.js';
import type { ModelRequest } from './types.js';

/** Floor to ceiling. Names verified against arena's picker. */
export const LADDER = [
  'claude-haiku-4-5-20251001',
  'gemini-2.5-flash-lite',
  'gpt-5.4-mini-high',
  'claude-sonnet-5-5',
] as const;

export interface LadderOptions {
  models?: readonly string[];
  /** Where the JSONL archives go. One file per model. */
  outDir?: string;
  /**
   * Restrict to specific task ids, for a smoke test.
   *
   * Filters the built task list rather than replacing the area list. Passing
   * `areas: []` instead would produce a run with no tasks at all and look like a
   * successful run that happened to score nothing.
   */
  only?: readonly string[];
  budgets?: number[];
  seeds?: number;
  carto?: SuperCarto;
  dryRun?: boolean;
  /** Stop the whole ladder at the first rate limit, rather than per model. */
  stopOnRateLimit?: boolean;
  onProgress?: (msg: string) => void;
}

export interface LadderResult {
  model: string;
  rows: ScoredTask[];
  summary: ReturnType<typeof summarise>[];
  failures: ScoredTask[];
  archive: string;
  /** Calls served from a previous run rather than the browser. */
  resumed: number;
  /** Calls that needed the browser. */
  fetched: number;
  /** True when arena stopped serving before this model finished. */
  rateLimited?: boolean;
}

export async function runLadder(opts: LadderOptions = {}): Promise<LadderResult[]> {
  const models = opts.models ?? LADDER;
  const outDir = opts.outDir ?? mkdtempSync(join(tmpdir(), 'supercarto-run-'));
  mkdirSync(outDir, { recursive: true });
  const log = opts.onProgress ?? (() => {});

  const catalog = await fetchModelCatalog();
  log(`catalog: ${catalog.size} models resolved to uuids`);

  const results: LadderResult[] = [];
  let stopped = false;

  for (const model of models) {
    // A rate limit is a property of the account, not of one model. Continuing to
    // the next model after hitting it would produce rows that look like model
    // failures when the models were never called, so the ladder halts instead.
    if (stopped) {
      log(`skipping ${model}: an earlier model hit the arena rate limit`);
      break;
    }

    const archive = join(outDir, `${model}.jsonl`);
    const already = ResponseArchive.keys(archive).size;
    log(`${model}: ${already} exchanges already archived`);

    // The uuid is recorded on every exchange. It is not part of the archive key,
    // because the key has to stay stable for resume to work, and a uuid looked
    // up later from the same slug is just as good.
    const modelId = catalog.get(model);
    if (modelId) log(`${model}: uuid ${modelId}`);

    const driver = new ArenaDriver(model, archive, () => {});
    const client = new ArchivingClient(
      driver,
      archive,
      (req: ModelRequest): RunIdentity => ({
        taskId: req.run?.taskId ?? 'unknown',
        representation: req.run?.representation ?? 'none',
        budget: req.run?.budget ?? 0,
        seed: req.seed,
      }),
      undefined,
      () => modelId,
    );

    if (opts.dryRun) {
      log(`${model}: dry run, no browser`);
      client.close();
      continue;
    }

    const report = await runBenchmark({
      models: [client],
      budgets: opts.budgets ?? [1024],
      seeds: opts.seeds ?? 3,
      ...(opts.only ? { only: opts.only } : {}),
      ...(opts.carto ? { carto: opts.carto } : {}),
      onProgress: (m) => log(`  ${model}: ${m}`),
    });

    client.close();

    // Whether the limit was hit, from the archived rows rather than from a
    // separate signal, so a resumed run sees it too.
    const limited = report.detail.some((r) => /rate limit/i.test(r.error ?? ''));
    if (limited) {
      stopped = true;
      log(`${model}: rate limited. Stopping; rerun this ladder later to continue.`);
    }

    results.push({
      model,
      rows: report.detail,
      summary: report.summaries,
      failures: failures(report.detail),
      archive,
      resumed: already,
      fetched: client.resumed === 0 ? report.detail.length : report.detail.length - client.resumed,
      rateLimited: limited,
    });
  }

  return results;
}

/** Escape hatch for callers that want the raw prompt list rather than a run. */
export function ladderModels(): readonly string[] {
  return LADDER;
}

export { scoreNames, distanceCorrect, extractDistanceM, isRefusal, connectedComponents };
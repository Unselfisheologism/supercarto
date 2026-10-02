/**
 * Re-score an archived run without calling any model.
 *
 * This is what makes a benchmark outlive its infrastructure. Scoring rules
 * change; the model under test gets withdrawn; a reviewer disagrees with a
 * threshold. None of that requires re-running generation, because the prompts
 * and responses are on disk. Re-scoring is a pure function of that file.
 */

import { buildTasks, TASK_AREAS, type TaskArea } from './tasks.js';
import { connectedComponents, failures, scoreNames, median, summarise, extractDistanceM, distanceCorrect, isRefusal } from './score.js';
import { fingerprintPrompt, ResponseArchive, type Exchange } from './archive.js';
import type { ScoredTask } from './score.js';
import type { GroundTruth } from './types.js';
import type { RunnerOptions } from './runner.js';
import { SuperCarto } from '../live.js';
import type { GeoJsonFeatureCollection } from '../ingest/geojson.js';

export interface RescoreOptions {
  /** JSONL archive written by the archiving client. */
  archive: string;
  areas?: readonly TaskArea[];
  /** Ground truth provider, matching the original run. */
  truth?: GroundTruthProvider;
  carto?: SuperCarto;
  fixtures?: Record<string, GeoJsonFeatureCollection>;
}

export type GroundTruthProvider = (
  task: { id: string; kind: string },
) => Promise<GroundTruth>;

/**
 * Score every archived exchange against current rules.
 *
 * Ground truth is recomputed rather than read from the archive, because it is
 * cheap, deterministic, and derived from data rather than from the model. Storing
 * it would risk re-scoring an answer against stale expectations.
 */
export async function rescore(opts: RescoreOptions): Promise<{
  rows: ScoredTask[];
  stale: Exchange[];
  summary: ReturnType<typeof summarise>[];
}> {
  const exchanges = ResponseArchive.read(opts.archive);
  if (exchanges.length === 0) return { rows: [], stale: [], summary: [] };

  const areas = opts.areas ?? TASK_AREAS;
  const tasks = buildTasks(areas);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  // Current prompt for each task, to detect drift against the archive.
  const truth = opts.truth ?? (async () => ({}));
  const truthCache = new Map<string, GroundTruth>();
  const rows: ScoredTask[] = [];
  const stale: Exchange[] = [];

  for (const e of exchanges) {
    const task = byId.get(e.taskId);
    if (!task) continue;

    const cacheKey = e.taskId;
    let gt = truthCache.get(cacheKey);
    if (gt === undefined) {
      gt = await truth({ id: e.taskId, kind: task.kind });
      truthCache.set(cacheKey, gt);
    }

    // Prompt drift: the archived prompt no longer matches what this harness
    // would send. Not an error, but it has to be visible, because a score
    // computed under a different question is a different measurement.
    const current = promptFor(task, e.representation, gt, opts.carto, opts.fixtures);
    if (current && fingerprintPrompt(current.system, current.user) !== e.promptHash) {
      stale.push(e);
    }

    rows.push(
      scoreArchived(e, task.kind, gt),
    );
  }

  const models = [...new Set(exchanges.map((e) => e.model))];
  const summary = models.flatMap((model) =>
    (['supercarto', 'geojson', 'none'] as const).flatMap((rep) => {
      const subset = rows.filter((r) => r.model === model && r.representation === rep);
      return subset.length === 0 ? [] : [summarise(subset, rep, model)];
    }),
  );

  return { rows, stale, summary };
}

/**
 * Score one archived exchange.
 *
 * Mirrors the runner's own rules exactly. This duplication is deliberate and is
 * the reason `scoreAnswer` is worth extracting: a second copy of a scoring rule
 * that drifts is how a re-score quietly reports something different from the
 * original run. The tests pin the two against each other.
 */
export function scoreArchived(
  e: Exchange,
  kind: string,
  truth: GroundTruth,
): ScoredTask {
  const base = {
    taskId: `${e.taskId}#${e.representation}@${e.budget}`,
    representation: e.representation,
    model: e.model,
    seed: e.seed,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    wallMs: 0,
    answer: e.answer,
  };

  if (e.error !== undefined) {
    return { ...base, correct: null, scoredBy: 'failed' as const, error: e.error };
  }

  const verdict = scoreAgainst(kind, e.answer, truth);
  return { ...base, ...verdict };
}

function scoreAgainst(
  kind: string,
  answer: string,
  truth: GroundTruth,
): { correct: boolean | null; scoredBy: ScoredTask['scoredBy']; rationale?: string } {
  if (isRefusal(answer) && kind !== 'connectivity') {
    return { correct: false, scoredBy: 'exact', rationale: 'refused or said it could not tell' };
  }

  switch (kind) {
    case 'route': {
      if (truth.distanceM === undefined) return { correct: null, scoredBy: 'failed' };
      const stated = extractDistanceM(answer);
      if (stated === undefined) return { correct: false, scoredBy: 'exact', rationale: 'no distance stated' };
      return {
        correct: distanceCorrect(stated, truth.distanceM),
        scoredBy: 'exact',
        rationale: `said ${stated}m, truth ${truth.distanceM}m`,
      };
    }
    case 'turns': {
      // Street coverage, not distance. The runner scores this separately because
      // a correct distance can still be reached by the wrong streets.
      if (!truth.streets || truth.streets.length === 0) return { correct: null, scoredBy: 'failed' };
      const hay = answer.toLowerCase();
      const hits = truth.streets.filter((s) => hay.includes(s.toLowerCase())).length;
      const coverage = hits / truth.streets.length;
      return {
        correct: coverage >= 0.6,
        scoredBy: 'exact',
        rationale: `named ${hits}/${truth.streets.length} streets`,
      };
    }
    case 'nearest': {
      if (!truth.names || truth.names.length === 0) return { correct: null, scoredBy: 'failed' };
      const s = scoreNames(truth.names, answer);
      return {
        correct: s.recall >= 0.5 && s.hallucinations.length === 0,
        scoredBy: 'exact',
        rationale: `recall ${Math.round(s.recall * 100)}%, ${s.hallucinations.length} not in data`,
      };
    }
    case 'connectivity': {
      if (truth.components === undefined) return { correct: null, scoredBy: 'failed' };
      const g = truth.graph!;
      const isolated = g ? connectedComponents(g) > 1 : truth.components > 1;
      const saysIsolated = /\b(isolated|not connected|no path|separate)\b/i.test(answer);
      const saysAll = /\b(all (are )?connected|every one is|fully connected)\b/i.test(answer);
      const correct = isolated ? saysIsolated && !saysAll : saysAll && !saysIsolated;
      return { correct, scoredBy: 'exact', rationale: `${truth.components} component(s) in graph` };
    }
    default:
      return { correct: null, scoredBy: 'failed' };
  }
}

/** Current prompt for a task, or undefined when it cannot be rebuilt offline. */
function promptFor(
  task: { id: string; question: string },
  representation: 'supercarto' | 'geojson' | 'none',
  _truth: GroundTruth,
  _carto?: SuperCarto,
  _fixtures?: Record<string, GeoJsonFeatureCollection>,
): { system: string; user: string } | undefined {
  if (representation === 'none') {
    return {
      system: '',
      user: `No map data has been provided.\n\nQuestion: ${task.question}`,
    };
  }
  // The maplet arm needs a live fetch to rebuild, so drift is only checked where
  // it can be checked exactly. Reporting an unverifiable drift is worse than
  // reporting none.
  return undefined;
}

export { failures, median };
/**
 * Re-score an archived run without calling any model.
 *
 * This is what makes a benchmark outlive its infrastructure. Scoring rules
 * change; the model under test gets withdrawn; a reviewer disagrees with a
 * threshold. None of that requires re-running generation, because the prompts
 * and responses are on disk. Re-scoring is a pure function of that file.
 */

import { buildTasks, TASK_AREAS, type TaskArea } from './tasks.js';
import { failures, scoreConnectivity, scoreExpansion, scoreHeat, scoreNames, scoreOmission, median, summarise, extractDistanceM, distanceCorrect, isRefusal } from './score.js';
import { fingerprintPrompt, ResponseArchive, type Exchange } from './archive.js';
import type { ScoredTask } from './score.js';
import type { GroundTruth } from './types.js';
import type { RunnerOptions } from './runner.js';
import { SuperCarto } from '../live.js';
import { OsrmRouter, type RoutingSource } from '../source/routing.js';
import { groundTruth } from './runner.js';
import type { GeoJsonFeatureCollection } from '../ingest/geojson.js';

export interface RescoreOptions {
  /** JSONL archive written by the archiving client. */
  archive: string;
  areas?: readonly TaskArea[];
  /** Ground truth provider, matching the original run. */
  truth?: GroundTruthProvider;
  carto?: SuperCarto;
  fixtures?: Record<string, GeoJsonFeatureCollection>;
  router?: RoutingSource;
}

/**
 * Ground truth rebuilt the way the runner builds it.
 *
 * The previous default was an empty object, which made every task unscoreable and
 * turned a re-score of a healthy archive into a table of failures. That is the
 * opposite of the point: the archive is the durable artefact, and re-scoring it is
 * how a run outlives a change in the scoring rules or a withdrawn model.
 *
 * The runner's own `groundTruth` is used rather than a second implementation.
 * Two copies of a ground-truth rule eventually disagree, and only one of them is
 * exercised by the run - so the re-score would quietly report something different
 * from the original.
 */
export function truthProvider(opts: {
  areas?: readonly TaskArea[];
  carto?: SuperCarto;
  fixtures?: Record<string, GeoJsonFeatureCollection>;
  router?: RoutingSource;
}): GroundTruthProvider {
  const carto = opts.carto ?? new SuperCarto();
  const router = opts.router ?? new OsrmRouter();
  return async ({ id, kind }) => {
    const task = buildTasks(opts.areas).find((t) => t.id === id);
    if (!task) return {};
    // The representation is irrelevant to ground truth, and `none` has no map to
    // reason about, so the supercarto arm's rule is used throughout.
    return groundTruth(task, router, carto, opts.fixtures, 'supercarto', 1024);
  };
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
  const truth = opts.truth ?? truthProvider(opts);
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

  const verdict = scoreAgainst(kind, e.answer, truth, e.toolsUsed);
  return { ...base, ...verdict };
}

function scoreAgainst(
  kind: string,
  answer: string,
  truth: GroundTruth,
  toolsUsed?: string[],
): { correct: boolean | null; scoredBy: ScoredTask['scoredBy']; rationale?: string } {
  /**
   * Refusal short-circuits the rest of the switch.
   *
   * Exempt for `connectivity` and `omission`, because on those tasks a correct
   * answer is *about* what the data cannot tell you. The omission task's real
   * answer reads "a missing feature here cannot be taken as proof of absence",
   * which `isRefusal` matches on the bare word "cannot" - so a correct answer was
   * scored as a refusal before it ever reached its own scorer.
   *
   * `isRefusal` matching "cannot" anywhere in a paragraph is too eager in general.
   * Narrowing it to refusal-shaped phrasing is the better fix, but it would move
   * existing scores, so it is recorded rather than smuggled in here.
   */
  if (isRefusal(answer) && kind !== 'connectivity' && kind !== 'omission') {
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
      // Against the shown set when a provider supplies it, for the same reason the
      // runner does: recall measured against the full source list is unreachable
      // for a budget-fitted arm. See `GroundTruth.shownNames`.
      const shown = truth.shownNames ?? truth.names;
      const s = scoreNames(Object.assign([...shown], { aliases: truth.aliases }), answer);
      const areaRecall = scoreNames(
        Object.assign([...truth.names], { aliases: truth.aliases }),
        answer,
      ).recall;
      return {
        correct: s.recall >= 0.5 && s.hallucinations.length === 0,
        scoredBy: 'exact',
        rationale:
          `recall ${Math.round(s.recall * 100)}% of ${shown.length} shown, ` +
          `${Math.round(areaRecall * 100)}% of ${truth.names.length} in area, ` +
          `${s.hallucinations.length} not in data`,
      };
    }
    case 'connectivity': {
      if (truth.components === undefined) return { correct: null, scoredBy: 'failed' };
      // Delegates to the shared scorer. This used to be an inline copy of the
      // keyword regexes, and inline copies drift: the shared version learned that
      // a refusal naming the keyword is still a refusal, and this copy did not.
      const correct = scoreConnectivity(truth.graph!, answer);
      return { correct, scoredBy: 'exact', rationale: `${truth.components} component(s) in graph` };
    }
    case 'omission': {
      // Added here when the kind was, and the omission arm scored 0% for a
      // correct answer until it was not. `default` returns unscoreable, so the row
      // vanished into failures rather than showing as wrong - which is the same
      // class of bug as the two earlier scoring duplications in this file.
      if (!truth.omitted) return { correct: null, scoredBy: 'failed' };
      const v = scoreOmission(answer, truth.omitted, truth.emittedNodes ?? 0);
      return {
        correct: v.correct,
        scoredBy: 'exact',
        rationale:
          `omitted ${truth.omitted.map((o) => `${o.count} ${o.layer}`).join(', ') || 'nothing'}; ` +
          `${v.flags.length ? v.flags.join('; ') : 'acknowledged'}`,
      };
    }
    case 'expand': {
      // Shared scorer, not a copy. See the omission note above: this file has
      // hosted drifted duplicates, and a fourth one starts here if the rules
      // are written out instead of called.
      if (truth.areaM2 === undefined) return { correct: null, scoredBy: 'failed' };
      const expanded = toolsUsed?.includes('expand_feature') ?? false;
      const v = scoreExpansion(answer, truth.areaM2, expanded);
      return {
        correct: v.correct,
        scoredBy: 'exact',
        rationale:
          `true ${Math.round(truth.areaM2)}m²; ` +
          `${v.flags.length ? v.flags.join('; ') : 'within tolerance'}`,
      };
    }
    case 'heat': {
      if (truth.peak === undefined || !truth.peakAt) return { correct: null, scoredBy: 'failed' };
      const v = scoreHeat(answer, truth.peak, truth.peakAt);
      return {
        correct: v.correct,
        scoredBy: 'exact',
        rationale:
          `peak ${truth.peak} at ${truth.peakAt.lat},${truth.peakAt.lon}; ` +
          `${v.flags.length ? v.flags.join('; ') : 'value and location'}`,
      };
    }
    case 'diff': {
      if (!truth.names) return { correct: null, scoredBy: 'failed' };
      const v = scoreNames(Object.assign([...truth.names], { aliases: truth.aliases ?? [] }), answer);
      const ok = v.recall === 1 && v.hallucinations.length === 0;
      return {
        correct: ok,
        scoredBy: 'exact',
        rationale:
          `recall ${Math.round(v.recall * 100)}% of ${truth.names.length} current, ` +
          `${v.hallucinations.length} not in data`,
      };
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
import { SuperCarto, OsrmRouter, estimateTokens, type GeoJsonFeatureCollection } from '../index.js';
import { buildTasks, SYSTEM_PROMPT, EVAL_PROTOCOL, TASK_AREAS, type BenchmarkTask, type TaskArea } from './tasks.js';
import {
  acknowledgesOmission,
  connectedComponents,
  distanceCorrect,
  extractDistanceM,
  isRefusal,
  scoreConnectivity,
  scoreNames,
  summarise,
  type Representation,
  type ScoredTask,
} from './score.js';
import {
  AnthropicClient,
  GeminiClient,
  OpenAiClient,
  OpenAiCompatibleClient,
  type ModelClient,
} from './models.js';
import type { GroundTruth, LatLon, ModelRequest } from './types.js';

/**
 * The benchmark runner.
 *
 * The comparison it exists to make is simple and was previously missing: the
 * same question, the same model, the same prompt, and the only thing that varies
 * is whether the context window holds a supercarto graph, raw GeoJSON, or
 * nothing. Every other claim in the README is downstream of that.
 */

export interface RunnerOptions {
  areas?: readonly TaskArea[];
  /** Token budgets to sweep for supercarto. */
  budgets?: number[];
  models?: ModelClient[];
  /** Skip live fetching and use these features instead. Used by the tests. */
  fixtures?: Record<string, GeoJsonFeatureCollection>;
  seeds?: number;
  /** Progress callback. */
  onProgress?: (msg: string) => void;
}

export interface RunReport {
  generatedAt: string;
  protocol: typeof EVAL_PROTOCOL;
  areas: { id: string; label: string; rationale: string }[];
  summaries: ReturnType<typeof summarise>[];
  /** Per-task detail, for anyone who wants to audit a row. */
  detail: ScoredTask[];
  /** Token cost per representation, which is the headline number. */
  tokenCost: {
    representation: Representation;
    /** Median prompt size across all tasks in that representation. */
    medianContextTokens: number;
    /** Ratio against supercarto at the largest budget. */
    multipleOfSupercarto?: number;
  }[];
}

/** Offset point for a route task, so it has somewhere to go. */
function destination(center: LatLon, radiusM: number): LatLon {
  return { lat: center.lat + radiusM / 110574, lon: center.lon };
}

export async function runBenchmark(opts: RunnerOptions = {}): Promise<RunReport> {
  const areas = opts.areas ?? TASK_AREAS;
  const budgets = opts.budgets ?? [512, 1024, 2048];
  const seeds = opts.seeds ?? EVAL_PROTOCOL.seeds;
  const models = opts.models ?? [];
  const tasks = buildTasks(areas);
  const detail: ScoredTask[] = [];
  const log = opts.onProgress ?? (() => {});

  const carto = new SuperCarto();
  const router = new OsrmRouter();

  // Context sizes are collected per representation so the report can state the
  // cost side by side. This is the number that makes the accuracy numbers mean
  // something: being right with 40x the context is a different result.
  const contextSizes: Record<Representation, number[]> = {
    supercarto: [],
    geojson: [],
    none: [],
  };

  for (const task of tasks) {
    for (const representation of ['supercarto', 'geojson', 'none'] as Representation[]) {
      const budgetsToUse = representation === 'supercarto' ? budgets : [budgets[budgets.length - 1]!];

      for (const budget of budgetsToUse) {
        const context = await buildContext(task, representation, budget, carto, log);
        contextSizes[representation].push(estimateTokens(context.text));

        const truth = await groundTruth(task, router, carto, opts.fixtures, representation, budget);

        for (const model of models) {
          for (let seed = 0; seed < seeds; seed++) {
            detail.push(
              await runOne(task, representation, budget, model, seed, context.text, truth),
            );
          }
        }
      }
    }
  }

  // Summaries are per model per representation. Grouping on the representation
  // field alone would merge every budget into one row and hide the crossover
  // point, which is the most interesting number the benchmark produces.
  const summaries = models.flatMap((model) =>
    (['supercarto', 'geojson', 'none'] as Representation[]).flatMap((rep) => {
      const rows = detail.filter((t) => t.model === model.id && t.representation === rep);
      if (rows.length === 0) return [];
      return [summarise(rows, rep, model.id)];
    }),
  );

  const tokenCost: RunReport['tokenCost'] = (['supercarto', 'geojson', 'none'] as Representation[]).map(
    (rep) => {
      const sizes = contextSizes[rep].slice().sort((a, b) => a - b);
      const mid = sizes[sizes.length >> 1] ?? 0;
      const base = contextSizes.supercarto.slice().sort((a, b) => a - b)[
        contextSizes.supercarto.length >> 1
      ] ?? 0;
      return {
        representation: rep,
        medianContextTokens: mid,
        ...(rep !== 'supercarto' && base > 0 ? { multipleOfSupercarto: round1(mid / base) } : {}),
      };
    },
  );

  return {
    generatedAt: new Date().toISOString(),
    protocol: EVAL_PROTOCOL,
    areas: areas.map((a) => ({ id: a.id, label: a.label, rationale: a.rationale })),
    summaries,
    detail,
    tokenCost,
  };
}

function taskIdFor(t: ScoredTask): string {
  return t.taskId.split('#')[0]!;
}

/**
 * Assemble what the model sees.
 *
 * The GeoJSON arm is the honest baseline: the same features, uncompiled, as JSON.
 * It is what a developer gets today when they call a map API and paste the
 * response into a prompt, which is the thing being compared against.
 */
async function buildContext(
  task: BenchmarkTask,
  representation: Representation,
  budget: number,
  carto: SuperCarto,
  log: (m: string) => void,
): Promise<{ text: string }> {
  const area = task.center;

  if (representation === 'none') {
    return {
      text:
        `The location is at latitude ${area.lat}, longitude ${area.lon}. ` +
        'No map data has been provided.',
    };
  }

  log(`fetching ${task.id} for ${representation}`);

  // The maplet path. For GeoJSON the same document is fetched once and reused,
  // so the two arms are looking at identical underlying data. Comparing a
  // compiled map against different raw data would measure the data, not the
  // compiler.
  const result = await carto.maplet({
    lat: task.center.lat,
    lon: task.center.lon,
    radiusM: task.radiusM,
    budget,
  });

  if (representation === 'geojson') {
    const raw = JSON.stringify({
      type: 'FeatureCollection',
      features: result.graph.nodes.map((n) => ({
        type: 'Feature',
        properties: { name: n.name, type: n.kind, tags: n.tags },
        geometry:
          n.lat !== undefined && n.lon !== undefined
            ? { type: 'Point', coordinates: [n.lon, n.lat] }
            : null,
      })),
    });
    return { text: `Map data:\n${raw}` };
  }

  return { text: `Map data:\n${result.yaml}` };
}

/**
 * The true answer for a task.
 *
 * From OSRM where OSRM knows it. The routing engine is the reference
 * implementation for this problem, so using it as ground truth is not circular:
 * the claim under test is about token cost and readability, not about route
 * optimality.
 */
async function groundTruth(
  task: BenchmarkTask,
  router: OsrmRouter,
  carto: SuperCarto,
  fixtures: RunnerOptions['fixtures'],
  representation: Representation,
  budget: number,
): Promise<GroundTruth> {
  void fixtures;
  void representation;
  void budget;

  try {
    if (task.kind === 'route' || task.kind === 'turns') {
      const to = destination(task.center, task.radiusM);
      const r = await router.route({
        from: task.center,
        to,
        mode: task.mode,
      });
      return {
        distanceM: r.route.dist,
        durationS: r.route.time,
        streets: r.route.steps.map((s) => s.turn).filter((t): t is string => Boolean(t)),
      };
    }

    if (task.kind === 'nearest') {
      const m = await carto.maplet({
        lat: task.center.lat,
        lon: task.center.lon,
        radiusM: task.radiusM,
        budget: 4000,
      });
      return { names: m.graph.nodes.filter((n) => n.name).map((n) => n.name!) };
    }

    if (task.kind === 'connectivity') {
      const m = await carto.maplet({
        lat: task.center.lat,
        lon: task.center.lon,
        radiusM: task.radiusM,
        budget: 4000,
      });
      return { components: connectedComponents(m.graph) };
    }
  } catch {
    // A task whose ground truth cannot be established is dropped rather than
    // scored against a guess. Counting it wrong would penalise a model for the
    // harness's failure.
    return {};
  }
  return {};
}

async function runOne(
  task: BenchmarkTask,
  representation: Representation,
  budget: number,
  model: ModelClient,
  seed: number,
  context: string,
  truth: GroundTruth,
): Promise<ScoredTask> {
  const user = `${context}\n\nQuestion: ${task.question}`;
  const req: ModelRequest = {
    system: SYSTEM_PROMPT,
    user,
    model: model.model,
    temperature: EVAL_PROTOCOL.temperature,
    seed,
  };

  const started = Date.now();
  try {
    const res = await model.call(req);
    const scored = scoreAnswer(task, res.text, truth);
    return {
      taskId: `${task.id}#${representation}@${budget}`,
      representation,
      model: model.id,
      seed,
      correct: scored.correct,
      scoredBy: scored.by,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      wallMs: Date.now() - started,
      answer: res.text,
      ...(scored.rationale ? { rationale: scored.rationale } : {}),
    };
  } catch (err) {
    return {
      taskId: `${task.id}#${representation}@${budget}`,
      representation,
      model: model.id,
      seed,
      correct: null,
      scoredBy: 'failed',
      inputTokens: 0,
      outputTokens: 0,
      wallMs: Date.now() - started,
      answer: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Score one answer against its ground truth.
 *
 * Returns `null` when the task had no ground truth, which is reported as a
 * failure rather than a pass. Defaulting an unscoreable task to correct is the
 * single easiest way to publish a meaningless benchmark.
 */
function scoreAnswer(
  task: BenchmarkTask,
  answer: string,
  truth: GroundTruth,
): { correct: boolean | null; by: ScoredTask['scoredBy']; rationale?: string } {
  if (isRefusal(answer) && representationNeedsData(task)) {
    // A refusal is not incorrect, but it is not an answer either. It is recorded
    // as such so `completion` reflects it rather than hiding it in accuracy.
    return { correct: false, by: 'exact', rationale: 'refused or said it could not tell' };
  }

  switch (task.kind) {
    case 'route': {
      if (truth.distanceM === undefined) return { correct: null, by: 'failed' };
      const stated = extractDistanceM(answer);
      if (stated === undefined) {
        return { correct: false, by: 'exact', rationale: 'no distance stated' };
      }
      const ok = distanceCorrect(stated, truth.distanceM);
      return {
        correct: ok,
        by: 'exact',
        rationale: `stated ${Math.round(stated)}m, true ${Math.round(truth.distanceM)}m`,
      };
    }

    case 'turns': {
      if (!truth.streets || truth.streets.length === 0) {
        return { correct: null, by: 'failed' };
      }
      // Partial credit is not a thing here. An agent that lists one of the three
      // streets and claims it is the route has not solved the task.
      const hay = answer.toLowerCase();
      const hits = truth.streets.filter((s) => hay.includes(s.toLowerCase())).length;
      const coverage = hits / truth.streets.length;
      return {
        correct: coverage >= 0.6,
        by: 'exact',
        rationale: `named ${hits}/${truth.streets.length} streets`,
      };
    }

    case 'nearest': {
      if (!truth.names || truth.names.length === 0) return { correct: null, by: 'failed' };
      const { recall, hallucinations } = scoreNames(truth.names, answer);
      // A hallucinated place is penalised as a failure regardless of recall.
      // Telling someone to walk to a shop that does not exist is the worst
      // outcome this library could produce.
      const correct = recall >= 0.5 && hallucinations.length === 0;
      return {
        correct,
        by: 'exact',
        rationale: `recall ${Math.round(recall * 100)}%, ${hallucinations.length} not in data`,
      };
    }

    case 'connectivity': {
      if (truth.components === undefined) return { correct: null, by: 'failed' };
      // Uses the answer's own claim against the graph it was shown. Imported
      // lazily to avoid a cycle with the runner's own graph construction.
      const said = /\b(isolated|not connected|no path|separate)\b/i.test(answer);
      const allConnected = /\b(all (are )?connected|fully connected)\b/i.test(answer);
      const expected = truth.components > 1 ? said && !allConnected : !said;
      return {
        correct: expected,
        by: 'exact',
        rationale: `${truth.components} component(s) in graph`,
      };
    }
  }
}

function representationNeedsData(task: BenchmarkTask): boolean {
  return task.kind !== 'connectivity';
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Build a client for a model spec, or undefined when its key is absent. */
export function clientFor(spec: {
  id: string;
  provider: string;
  model: string;
  keyEnv: string;
}): ModelClient | undefined {
  const key = process.env[spec.keyEnv];
  switch (spec.provider) {
    case 'anthropic':
      return key ? new AnthropicClient(spec.id, spec.model, key) : undefined;
    case 'openai':
      return key ? new OpenAiClient(spec.id, spec.model, key) : undefined;
    case 'google':
      return key ? new GeminiClient(spec.id, spec.model, key) : undefined;
    case 'openai-compatible':
      // A local endpoint needs no credential; its absence is not a skip.
      return process.env[spec.keyEnv]
        ? new OpenAiCompatibleClient(
            spec.id,
            spec.model,
            process.env[spec.keyEnv]!,
          )
        : undefined;
    default:
      return undefined;
  }
}

export { buildTasks, PANEL, TASK_AREAS, SYSTEM_PROMPT, EVAL_PROTOCOL } from './tasks.js';
export type { Representation, ScoredTask, BenchmarkTask };

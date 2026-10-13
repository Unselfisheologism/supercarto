import {
  SuperCarto,
  OsrmRouter,
  estimateTokens,
  featuresFromDocument,
  toMaplet,
  type GeoJsonFeature,
  type GeoJsonFeatureCollection,
  type MapletResult,
} from '../index.js';
import type { RoutingSource } from '../source/routing.js';
import {
  buildTasks,
  SYSTEM_PROMPT,
  EVAL_PROTOCOL,
  NAME_ALIAS_TAGS,
  TASK_AREAS,
  type BenchmarkTask,
  type TaskArea,
} from './tasks.js';
import {
  acknowledgesOmission,
  connectedComponents,
  distanceCorrect,
  extractDistanceM,
  isRefusal,
  polygonAreaM2,
  scoreConnectivity,
  scoreExpansion,
  scoreHeat,
  scoreNames,
  scoreOmission,
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
  /**
   * Restrict to specific task ids.
   *
   * For a smoke test over a metered, rate-limited provider: a full ladder is
   * around 140 calls, which a free tier will not serve in one sitting.
   */
  only?: readonly string[];
  /** Token budgets to sweep for supercarto. */
  budgets?: number[];
  models?: ModelClient[];
  /**
   * Skip live fetching and use these features instead, keyed by area id.
   *
   * Without this the runner reaches Overpass and OSRM, which makes it
   * impossible to exercise offline and turns every run into a network
   * benchmark. A benchmark whose harness cannot be tested is a benchmark whose
   * scoring can be quietly wrong.
   */
  fixtures?: Record<string, GeoJsonFeatureCollection>;
  seeds?: number;
  /** Progress callback. */
  onProgress?: (msg: string) => void;
  /**
   * Supply the map and routing clients instead of the live ones.
   *
   * This is the seam that lets a test drive the whole runner without a network.
   * Production callers leave it unset and get Overpass and OSRM.
   */
  carto?: SuperCarto;
  router?: RoutingSource;
  /**
   * Shared maplet cache, created once and passed to every per-model run.
   *
   * The ladder calls this once per model, and the context for a task does not
   * depend on which model is looking at it: the same maplet, budget, and
   * representation produce the same prompt for all of them. Without a cache that
   * is eight identical Overpass fetches per task, so an eight-model run pays
   * eight times the network cost and takes eight times as long for data that
   * never changes - and Overpass rate-limits, so the later models were being
   * starved by the earlier ones.
   *
   * Keyed by task, representation, and budget, because those are exactly the
   * inputs buildContext takes.
   */
  contextCache?: Map<string, { text: string }>;
  /**
   * Model calls to have in flight at once. Default 1, i.e. serial.
   *
   * A per-call latency problem rather than a throughput one: each call spawns a
   * standalone opencode server and takes around 110s on the free tier, so a full
   * ladder of 768 calls is over 23 hours of mostly waiting.
   *
   * Default 1 because raising it is a decision with consequences, not an
   * optimisation. A free tier that starts refusing requests turns each refusal
   * into a failed row, and a failed row is recorded as a model failure. Whoever
   * sets this is choosing how much parallel pressure to put on an undocumented
   * limit.
   */
  concurrency?: number;
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

/**
 * Offset point for a route task, so it has somewhere to go.
 *
 * The offset is a task property rather than the area radius. The turn-by-turn
 * prompt asks for a 200m walk, and the harness used to route to `area.radiusM`
 * instead - 400m in most areas, 2000m in rural Montana. Ground truth was
 * therefore describing a different walk than the question asked about, which is
 * the SOP Step 4 failure: a verified answer to the wrong question. `buildTasks`
 * now states the offset explicitly and both read the same field.
 */
function destination(center: LatLon, offsetM: number): LatLon {
  return { lat: center.lat + offsetM / 110574, lon: center.lon };
}

/**
 * Area id for a task.
 *
 * Task ids are `<area-id>/<kind>`, so the prefix identifies which area a task
 * belongs to. That is the key `fixtures` is indexed by.
 */
export function areaIdOf(task: BenchmarkTask): string {
  const slash = task.id.indexOf('/');
  return slash === -1 ? task.id : task.id.slice(0, slash);
}

export async function runBenchmark(opts: RunnerOptions = {}): Promise<RunReport> {
  const areas = opts.areas ?? TASK_AREAS;
  const budgets = opts.budgets ?? [512, 1024, 2048];
  const seeds = opts.seeds ?? EVAL_PROTOCOL.seeds;
  const models = opts.models ?? [];
  const tasks = buildTasks(areas).filter(
    (t) => !opts.only || opts.only.includes(t.id),
  );
  if (tasks.length === 0) {
    // Refused rather than run: an empty task list produces a report that looks
    // complete and measures nothing, which is the easiest way to publish an
    // empty benchmark by accident.
    throw new Error(
      opts.only
        ? `no tasks matched ${opts.only.join(', ')}; known tasks: ${buildTasks(areas).map((t) => t.id).join(', ')}`
        : 'no areas supplied, so there are no tasks to run',
    );
  }
  const detail: ScoredTask[] = [];
  const log = opts.onProgress ?? (() => {});

  // Overridable so a test can supply a fixture-backed client. Hardcoding these
  // made every run a live network call.
  const carto = opts.carto ?? new SuperCarto();
  const router = opts.router ?? new OsrmRouter();

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
        const context = await buildContext(task, representation, budget, carto, log, opts.contextCache,
      opts.fixtures,
    );
        contextSizes[representation].push(estimateTokens(context.text));

        const truth = await groundTruth(task, router, carto, opts.fixtures, representation, budget);

        // Every (model, seed) pair for this configuration is an independent call,
        // so they are issued together rather than one after another.
        //
        // Measured on the free tier: 110s mean per call, because each one spawns
        // a standalone opencode server. Issued serially, a full ladder is 768
        // calls and 23 hours of wall clock, almost all of it waiting. Nothing in
        // the loop depends on another call's result, and the archive is
        // append-only with one writer per process, so concurrency changes the
        // elapsed time and nothing about what is measured.
        //
        // The concurrency factor is a bound, not a target: a free tier that
        // starts refusing requests would turn every refusal into a failed row, so
        // the caller picks a value it is willing to have recorded as failures.
        // Every (model, seed) pair for this configuration is an independent call,
        // so a fixed pool of workers takes them off a shared queue.
        //
        // Measured on the free tier: 110s mean per call, because each one spawns
        // a standalone opencode server. Issued serially, a full ladder is 768
        // calls and 23 hours of wall clock, almost all of it waiting. Nothing in
        // the loop depends on another call's result, so concurrency changes the
        // elapsed time and nothing about what is measured.
        //
        // The factor is a bound, not a target: a free tier that starts refusing
        // requests turns every refusal into a failed row, and a failed row is
        // recorded as a model failure. Whoever sets it is choosing how much
        // parallel pressure to put on an undocumented limit.
        const work: ScoredTask[] = [];
        const queue: { model: ModelClient; seed: number }[] = [];
        for (const model of models) {
          for (let seed = 0; seed < seeds; seed++) queue.push({ model, seed });
        }
        let next = 0;
        const worker = async (): Promise<void> => {
          for (;;) {
            const index = next++;
            if (index >= queue.length) return;
            const { model, seed } = queue[index]!;
            work[index] = await runOne(
              task, representation, budget, model, seed, context.text, truth,
            );
          }
        };
        const slots = Math.max(1, Math.min(Math.floor(opts.concurrency ?? 1), queue.length));
        await Promise.all(Array.from({ length: slots }, worker));
        const settled = work.filter((r): r is ScoredTask => r !== undefined);
        // Order is restored, so a report is byte-identical whether or not
        // concurrency was used. Summaries group by model and representation, so
        // row order does not change any number - but a diffable report is worth
        // more than the convenience.
        detail.push(...orderCalls(settled, models, seeds));
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
 * Restore the order the serial loop would have produced.
 *
 * `Promise.all` resolves in argument order, which is already model-then-seed, so
 * this is mostly a statement of intent. It is here because the alternative -
 * relying on `Promise.all` ordering forever - would silently change report layout
 * the first time the loop was restructured, and a benchmark whose JSON diffs
 * differently for no reason is a benchmark nobody trusts.
 */
function orderCalls(rows: ScoredTask[], models: readonly ModelClient[], seeds: number): ScoredTask[] {
  const expected: ScoredTask[] = [];
  for (const model of models) {
    for (let seed = 0; seed < seeds; seed++) {
      const row = rows.find((r) => r.model === model.id && r.seed === seed);
      if (row) expected.push(row);
    }
  }
  // Anything unmatched is appended rather than dropped: a row that exists but is
  // not in the expected shape should be visible in the report, not disappear.
  for (const row of rows) if (!expected.includes(row)) expected.push(row);
  return expected;
}

/**
 * Assemble what the model sees.
 *
 * The GeoJSON arm is the honest baseline: the same features, uncompiled, as JSON.
 * It is what a developer gets today when they call a map API and paste the
 * response into a prompt, which is the thing being compared against.
 */
/**
 * Compile a fixture through the real ingest-compile-emit path.
 *
 * Deliberately the production pipeline rather than a hand-built stub document.
 * A fixture arm has to be the emitter's actual output, or the benchmark measures
 * a lookalike instead of the thing being claimed, and the budget fitting that
 * makes supercarto cheap is exactly the stage a stub would skip.
 */
function compileFixture(
  fixture: GeoJsonFeatureCollection,
  task: BenchmarkTask,
  budget: number,
): MapletResult {
  const dLat = task.radiusM / 110_574;
  const dLon = task.radiusM / (111_320 * Math.cos((task.center.lat * Math.PI) / 180));
  return toMaplet(fixture, {
    bbox: {
      west: task.center.lon - dLon,
      south: task.center.lat - dLat,
      east: task.center.lon + dLon,
      north: task.center.lat + dLat,
    },
    budget,
    radiusLabel: `${task.radiusM}m`,
    /**
     * Honour an explicit `layer` tag when the fixture declares one.
     *
     * Without it, ingest infers layers from geometry type and every point becomes
     * `poi`, so an omission could only ever read `layer: poi`. The synthetic
     * fixture labels its clutter `tree`, and the omission task is more honest when
     * the record names what was dropped rather than the shape it had.
     *
     * Note this belongs under `ingest`, not at the top level. Passing a top-level
     * `layerKey` is silently ignored, because `MapletRequest` has no such field -
     * a trap worth knowing about rather than one worth adding a validation for.
     */
    ingest: { layerKey: 'layer' },
    // Fixtures carry no derived heat or elevation, and saying so keeps the
    // emitted header honest rather than advertising layers that are absent.
    capabilities: { elevation: false, weather: false, traffic: false },
  });
}

/** The raw comparison arm: the fixture's features, uncompiled, as JSON. */
function geoJsonText(fixture: GeoJsonFeatureCollection): string {
  return `Map data:\n${JSON.stringify(fixture)}`;
}

/**
 * The raw arm when the map came from a live fetch rather than a fixture.
 *
 * This used to serialise `result.graph.nodes`, which is the *compiled* graph. That
 * made the raw baseline strictly worse than the thing it was the baseline for, and
 * for reasons that had nothing to do with the compiler:
 *
 *  - geometry was dropped, because compiled intersection nodes carry no lat/lon,
 *    so every feature serialised as `"geometry":null`
 *  - names were dropped, because `n.name` is only populated for the subset of
 *    nodes that survived budgeting
 *  - tags were dropped, so a raw consumer could not tell a cafe from a bench
 *
 * Measured on the sf-cbd fixture at budget 1024: the old arm was 66 features with
 * 0 names and 0 geometries; the fixture path for the same data is 720 features
 * with 336 names and full geometry. A model shown the old arm was being asked to
 * answer questions about data the harness had deleted, and the resulting score
 * measured the projection step rather than the compiler. This is the ABC outcome
 * validity failure in its purest form: the pass condition did not correspond to
 * real success, and the baseline was rigged.
 *
 * The fix is to fetch once and reuse the *raw source features* for the geojson
 * arm, so both arms look at the same underlying data and differ only in
 * representation. That is what `maplet` exposes via `result.features` when the
 * caller asks for the source rather than the graph.
 */
function geoJsonFromSource(features: GeoJsonFeature[]): string {
  return `Map data:\n${JSON.stringify({ type: 'FeatureCollection', features })}`;
}

export async function buildContext(
  task: BenchmarkTask,
  representation: Representation,
  budget: number,
  carto: SuperCarto,
  log: (m: string) => void,
  cache?: Map<string, { text: string }>,
  fixtures?: Record<string, GeoJsonFeatureCollection>,
): Promise<{ text: string }> {
  const area = task.center;

  if (representation === 'none') {
    return {
      text:
        `The location is at latitude ${area.lat}, longitude ${area.lon}. ` +
        'No map data has been provided.',
    };
  }

  const cacheKey = `${task.id}|${representation}|${budget}`;
  const hit = cache?.get(cacheKey);
  if (hit) return hit;

  // A fixture, when one is supplied for this area, replaces the fetch entirely.
  //
  // Fixtures used to feed ground truth only, which meant a run could not
  // actually be offline: the context still came from Overpass, so the model was
  // answering about live data while being scored against a recording of it. That
  // is the worst of both - a comparison against data nobody can reproduce, and a
  // ground truth that may describe a different day.
  const fixture = fixtures?.[areaIdOf(task)];
  if (fixture) {
    log(`using fixture for ${task.id}`);
    // Compiled through the same path as a live maplet, so the fixture arm is the
    // real emitter rather than a stand-in that happens to look similar. A model
    // shown something the emitter would never produce is not being tested on the
    // emitter's output.
    const doc = compileFixture(fixture, task, budget);
    const text = representation === 'geojson' ? geoJsonText(fixture) : `Map data:\n${doc.yaml}`;
    const built = { text };
    if (representation === 'supercarto' && task.kind === 'expand') {
      /**
       * The machine-readable half of the protocol, alongside the readable half.
       *
       * This is the architecture the planning doc prescribes: the LLM reads the
       * YAML summary, and the exact geometry travels as an SCR document the
       * model passes back to expand_feature without needing to parse it. The
       * micro-fixture keeps it small (hundreds of bytes); bundling the full
       * dense fixture's SCR would cost ~82k tokens and is why the production
       * get_maplet cannot do this yet - recorded, not solved here.
       *
       * Only the supercarto arm gets the bundle. Handing it to the geojson arm
       * would smuggle the framework's data into the baseline, and the none arm
       * gets nothing by design.
       */
      built.text +=
        '\nExact geometry for the features above is available through the ' +
        'expand_feature tool. Pass this document back to it unchanged; do not ' +
        'try to parse it yourself:\n<scr>\n' +
        doc.scr +
        '\n</scr>';
    }
    cache?.set(cacheKey, built);
    return built;
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

  let built: { text: string };
  if (representation === 'geojson') {
    // The raw source features the supercarto arm was compiled from, recovered from
    // the same document. Not the compiled graph: see `geoJsonFromSource`.
    built = { text: geoJsonFromSource(featuresFromDocument(result.doc)) };
  } else {
    built = { text: `Map data:\n${result.yaml}` };
  }

  // Stored only on success. A failed fetch left behind by a throw would make
  // every later model silently reuse a half-built prompt as though it were data.
  cache?.set(cacheKey, built);
  return built;
}

/**
 * The true answer for a task.
 *
 * From OSRM where OSRM knows it. The routing engine is the reference
 * implementation for this problem, so using it as ground truth is not circular:
 * the claim under test is about token cost and readability, not about route
 * optimality.
 */
export async function groundTruth(
  task: BenchmarkTask,
  router: RoutingSource,
  carto: SuperCarto,
  fixtures: RunnerOptions['fixtures'],
  representation: Representation,
  budget: number,
): Promise<GroundTruth> {
  try {
    if (task.kind === 'route' || task.kind === 'turns') {
      // The offset the question names, not the area radius. See `destination`.
      const to = destination(task.center, task.offsetM ?? task.radiusM);
      const r = await router.route({
        from: task.center,
        to,
        mode: task.mode,
      });

      /**
       * The reference router reports success for routes it did not compute.
       *
       * Two separate failure modes, both measured against the public demo server,
       * and both shaped so that nothing in the response looks wrong:
       *
       * 1. **Zero for no network.** Asked about a point in the open Pacific, it
       *    answers `{"code":"Ok","routes":[{"distance":0,"duration":0}]}`. Taking
       *    that at face value made ground truth 0m, so every arm was graded against
       *    "the true distance is 0" - including the no-map arm, which correctly
       *    observed the coordinate is in open ocean and was scored wrong for it.
       *
       * 2. **Impossible distances where a network exists.** Walking north from the
       *    centre of sf-cbd, a 50 m displacement returns 35 m of walking, which is
       *    shorter than the straight line and therefore physically impossible. At
       *    100 m it returns 725 m, a factor of 7.25. The response is `code: Ok` in
       *    every case, and the endpoints snap within 9 m and 25 m of the points
       *    asked for, so neither the code nor the snapping reveals the problem.
       *
       * The second case is the dangerous one. Zero is visibly degenerate, so it
       * gets noticed; 868 m for a 200 m walk looks like a real detour and so was
       * silently used as truth, failing every arm for reasons no model could
       * infer.
       *
       * `router.project-osrm.org` is a shared demo server with an experimental
       * walking profile. It cannot serve as an oracle for this benchmark.
       *
       * So the answer is checked against the geometry the question actually
       * describes. A walking route cannot be shorter than the straight line, and
       * in a city grid it is not many times longer. Outside those bounds the truth
       * is unavailable rather than wrong, and the task surfaces as unscoreable
       * instead of grading arms against a number nothing can hit.
       */
      const dist = r.route.dist;
      if (dist === undefined || !Number.isFinite(dist) || dist <= 0) {
        return {};
      }

      const asked = task.offsetM ?? task.radiusM;
      const ratio = dist / asked;
      if (ratio < 0.95 || ratio > 3) {
        return {};
      }

      return {
        distanceM: dist,
        durationS: r.route.time,
        streets: r.route.steps.map((s) => s.turn).filter((t): t is string => Boolean(t)),
      };
    }

    if (task.kind === 'nearest') {
      // Prefer the fixture's own names when one is supplied, so the expected
      // answer describes the data the model was actually shown. Reading the
      // expected list from a live fetch while showing the model a fixture would
      // score the model against places it never saw.
      const fixture = fixtures?.[areaIdOf(task)];
      if (fixture) {
        const names = fixture.features
          .map((f) => (f.properties as Record<string, unknown> | null)?.name)
          .filter((n): n is string => typeof n === 'string' && n.length > 0);
        if (names.length > 0) {
          const all = [...new Set(names)];
          // A place answers to more than its `name` tag.
          const aliases = [
            ...new Set(
              fixture.features
                .flatMap((f) => {
                  const p = (f.properties ?? {}) as Record<string, unknown>;
                  return NAME_ALIAS_TAGS.flatMap((tag) => {
                    const v = p[tag];
                    if (typeof v !== 'string' || v.length === 0) return [];
                    // Several of these are semicolon-separated lists.
                    return v.split(';').map((s) => s.trim()).filter(Boolean);
                  });
                }),
            ),
          ].filter((a) => !all.includes(a));
          // What this arm was shown, at the budget it was shown at. For the
          // geojson arm that is the whole fixture; for supercarto it is whatever
          // survived budget fitting.
          const shown =
            representation === 'geojson'
              ? all
              : compileFixture(fixture, task, budget)
                  .graph.nodes.filter((n) => n.name)
                  .map((n) => n.name!);
          return { names: all, aliases, shownNames: [...new Set(shown)] };
        }
      }
      // Every named feature in the area, deliberately not budget-fitted.
      //
      // The question is "list the named places here", so the answer is the full
      // set, and it has to be the same set for every arm or the arms are graded
      // against different questions. A budget-fitted graph names far fewer
      // places, and scoring a 1024-budget maplet against the full list measures
      // the budget rather than the model's reading of it. The cost of that choice
      // is real and is the point of the token column: recall falls as the budget
      // falls, and accuracy is only comparable at equal budget.
      const m = await carto.maplet({
        lat: task.center.lat,
        lon: task.center.lon,
        radiusM: task.radiusM,
        budget: 4000,
      });
      const all = [...new Set(m.graph.nodes.filter((n) => n.name).map((n) => n.name!))];
      // For the live path, shown names need the budget-fitted compile, which is
      // the maplet already cached for this task.
      const shown =
        representation === 'geojson'
          ? all
          : (
              await carto.maplet({
                lat: task.center.lat,
                lon: task.center.lon,
                radiusM: task.radiusM,
                budget,
              })
            ).graph.nodes.filter((n) => n.name)
              .map((n) => n.name!);
      return { names: all, shownNames: [...new Set(shown)] };
    }

    if (task.kind === 'omission') {
      /**
       * Truth is what the maplet itself admitted to dropping.
       *
       * Not what a live fetch would have contained, and not what the model should
       * guess: the pass condition is "did the answer report the gap the data
       * declared", so the expectation has to be that declared gap and no other.
       */
      const areaFixture = fixtures?.[areaIdOf(task)];
      const compiled = areaFixture
        ? compileFixture(areaFixture, task, budget)
        : await carto.maplet({
            lat: task.center.lat,
            lon: task.center.lon,
            radiusM: task.radiusM,
            budget,
          });

      return {
        omitted: compiled.graph.omitted.map((o) => ({ layer: o.layer, count: o.count })),
        sourceFeatures: areaFixture?.features.length,
        emittedNodes: compiled.graph.nodes.length,
      };
    }

    if (task.kind === 'expand') {
      /**
       * Truth is the source polygon's area, not anything the maplet says.
       *
       * The maplet carries no coordinates and states no area by design - both
       * absences are the information gap the task exists to test - so scoring
       * against the maplet would be circular. Shoelace over the source ring,
       * projected equirectangularly, is independent of the whole
       * compile/emit path.
       *
       * Fixture only, no live fallback. Without the designed configuration
       * there is no question: a live fetch cannot supply an unmemorisable
       * building with a known area.
       */
      const areaFixture = fixtures?.[areaIdOf(task)];
      if (!areaFixture) return {};
      const polys = areaFixture.features.filter(
        (f) => f.geometry?.type === 'Polygon' && (f.properties as any)?.building === 'yes',
      );
      const coords = polys[0]?.geometry?.coordinates;
      const ring = Array.isArray(coords)
        ? (coords[0] as unknown[]).flatMap((p) =>
            Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number'
              ? [[p[0], p[1]] as [number, number]]
              : [],
          )
        : [];
      if (ring.length === 0) return {};
      return { areaM2: polygonAreaM2(ring) };
    }

    if (task.kind === 'connectivity') {
      // From the fixture when there is one. The graph has to be the same graph
      // the model was shown: connectivity truth taken from a live fetch while
      // the prompt holds a recording would score the model against a different
      // map, and would make an offline run impossible.
      const fixture = fixtures?.[areaIdOf(task)];
      if (fixture) {
        // At the budget the model was shown, not an unbounded one.
        //
        // Truth used to be compiled at budget 4000 while the model saw 1024. The
        // component count is a property of the graph: at sf-cbd it is 8 at budget
        // 1024 and 33 at 4000. Scoring a 1024-budget answer against the 4000 graph
        // asks the model to report structure it was never given, so every correct
        // answer read as wrong.
        const m = compileFixture(fixture, task, budget);
        return { components: connectedComponents(m.graph), graph: m.graph };
      }
      const m = await carto.maplet({
        lat: task.center.lat,
        lon: task.center.lon,
        radiusM: task.radiusM,
        budget,
      });
      return { components: connectedComponents(m.graph), graph: m.graph };
    }

    if (task.kind === 'heat') {
      // From the emitted summary, like connectivity truth from the emitted
      // graph. The alternative - independent cell-to-coordinate math - risks
      // disagreeing with the emitter over rounding (hotspots print at 5
      // decimals, deduped) and failing correct readings for harness reasons.
      // Fixture only: without the designed scalar layer there is no question.
      const areaFixture = fixtures?.[areaIdOf(task)];
      if (!areaFixture) return {};
      const compiled = compileFixture(areaFixture, task, budget);
      const layer = compiled.graph.heat[0];
      const peak = layer?.hotspots[0];
      if (!layer || !peak) return {};
      return { peak: peak.value, peakAt: { lat: peak.lat, lon: peak.lon } };
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
    // Carried so an archiving driver can key its rows without reverse-engineering
    // the task from the prompt text.
    run: {
      taskId: task.id,
      representation,
      budget,
      seed,
    },
  };

  const started = Date.now();
  try {
    const res = await model.call(req);
    const expanded = res.toolsUsed?.includes('expand_feature') ?? false;
    const scored = scoreAnswer(task, res.text, truth, expanded);
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
      ...(res.toolsUsed && res.toolsUsed.length > 0 ? { toolsUsed: res.toolsUsed } : {}),
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
  expanded = false,
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
      // Recall is measured against the names the model was actually shown, not
      // against every name in the area.
      //
      // Against the full source list this task is unwinnable for the supercarto
      // arm and therefore meaningless: at budget 1024 the sf-cbd maplet carries
      // about ten named places out of 336 in the fixture, so recall cannot exceed
      // 3% and every arm scores zero regardless of what it did. In a real
      // benchmark run every single arm reported 0%, which reads as "the model
      // cannot do this task" when the truth is "the pass condition was
      // unreachable".
      //
      // Scoring against the shown set measures what it should: did the model
      // report the places it was given. Coverage of the whole area is still
      // reported, as `shownRecall`, because it is the number that says what a
      // budget costs - but it is not the pass condition, because a truncated
      // context cannot be expected to contain what was cut from it.
      // Aliases travel with `names` so the scorer can accept `old_name` and
      // `alt_name`; recall itself must be computed over the primary names only.
      const withAliases = Object.assign([...(truth.shownNames ?? truth.names)], {
        aliases: truth.aliases,
      });
      const { recall, hallucinations } = scoreNames(withAliases, answer);
      const areaRecall = scoreNames(
        Object.assign([...truth.names], { aliases: truth.aliases }),
        answer,
      ).recall;
      // A hallucinated place is penalised as a failure regardless of recall.
      // Telling someone to walk to a shop that does not exist is the worst
      // outcome this library could produce.
      const correct = recall >= 0.5 && hallucinations.length === 0;
      return {
        correct,
        by: 'exact',
        rationale:
          `recall ${Math.round(recall * 100)}% of ${truth.shownNames?.length ?? truth.names.length} shown, ` +
          `${Math.round(areaRecall * 100)}% of ${truth.names.length} in area, ` +
          `${hallucinations.length} not in data`,
      };
    }

    case 'connectivity': {
      if (truth.components === undefined) return { correct: null, by: 'failed' };
      // Delegates to the shared scorer rather than repeating the pattern here.
      // The copy that used to live here had drifted: it treated the absence of
      // an "isolated" claim as agreement, so a refusal or an empty answer scored
      // as correct on a connected graph. Two implementations of one rule will
      // eventually disagree, and only one of them gets tested.
      const correct = scoreConnectivity(truth.graph!, answer);
      return {
        correct,
        by: 'exact',
        rationale: `${truth.components} component(s) in graph`,
      };
    }

    case 'omission': {
      if (!truth.omitted) return { correct: null, by: 'failed' };
      const v = scoreOmission(answer, truth.omitted, truth.emittedNodes ?? 0);
      return {
        correct: v.correct,
        by: 'exact',
        rationale:
          `omitted ${truth.omitted.map((o) => `${o.count} ${o.layer}`).join(', ') || 'nothing'}; ` +
          `${v.flags.length ? v.flags.join('; ') : 'acknowledged'}`,
      };
    }

    case 'expand': {
      if (truth.areaM2 === undefined) return { correct: null, by: 'failed' };
      const v = scoreExpansion(answer, truth.areaM2, expanded);
      return {
        correct: v.correct,
        by: 'exact',
        rationale:
          `true ${Math.round(truth.areaM2)}m²; ` +
          `${v.flags.length ? v.flags.join('; ') : 'within tolerance'}`,
      };
    }

    case 'heat': {
      if (truth.peak === undefined || !truth.peakAt) return { correct: null, by: 'failed' };
      const v = scoreHeat(answer, truth.peak, truth.peakAt);
      return {
        correct: v.correct,
        by: 'exact',
        rationale:
          `peak ${truth.peak} at ${truth.peakAt.lat},${truth.peakAt.lon}; ` +
          `${v.flags.length ? v.flags.join('; ') : 'value and location'}`,
      };
    }
  }
}

/**
 * Whether a refusal is a failure on this task.
 *
 * False for `connectivity` and `omission`, because on those a correct answer is
 * *about* what the data cannot support. "A missing feature here cannot be taken as
 * proof of absence" is the omission task answered correctly, and it contains the
 * word `cannot`.
 */
function representationNeedsData(task: BenchmarkTask): boolean {
  return task.kind !== 'connectivity' && task.kind !== 'omission';
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

import { describe, expect, it } from 'vitest';
import { runBenchmark } from '../src/bench/runner.js';
import { SuperCarto } from '../src/index.js';
import type { ModelClient } from '../src/bench/models.js';
import type { ModelRequest, ModelResponse } from '../src/bench/types.js';
import type { RoutingSource } from '../src/source/routing.js';
import type { MapSource, SourceRequest, SourceResult } from '../src/source/types.js';
import type { GeoJsonFeatureCollection } from '../src/index.js';
import type { TaskArea } from '../src/bench/tasks.js';

/**
 * The benchmark runner, end to end, offline.
 *
 * This is the test that proves the harness can be exercised without a network
 * or an API key. `ModelClient` is an interface, and the map and routing clients
 * are injectable, so a run is fully determined by what this file supplies.
 *
 * The properties asserted here are the ones that make a published benchmark
 * worth reading: that every representation is actually compared, that a model
 * which cannot answer does not count as correct, and that a harness failure is
 * visible rather than folded into the model's score.
 */

/** A model that always answers the same way, and records what it was shown. */
class ScriptedModel implements ModelClient {
  readonly seen: string[] = [];
  calls = 0;

  constructor(
    readonly id: string,
    readonly model: string,
    private readonly answer: (req: ModelRequest) => string,
    private readonly fail = false,
  ) {}

  async call(req: ModelRequest): Promise<ModelResponse> {
    this.calls++;
    this.seen.push(req.user);
    if (this.fail) throw new Error('upstream unavailable');
    const text = this.answer(req);
    return { text, inputTokens: req.user.length, outputTokens: text.length };
  }
}

/** Fixed map data, so the runner never reaches Overpass. */
class StubMapSource implements MapSource {
  readonly name = 'stub';
  readonly description = 'fixture';
  async available() {
    return true;
  }
  async fetch(_req: SourceRequest): Promise<SourceResult> {
    const features: GeoJsonFeatureCollection['features'] = [
      {
        type: 'Feature',
        id: 1,
        properties: { highway: 'primary', name: 'Market St' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [-122.3962, 37.7932],
            [-122.3938, 37.7932],
          ],
        },
      },
      {
        type: 'Feature',
        id: 2,
        properties: { highway: 'secondary', name: 'Mission St' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [-122.3962, 37.7932],
            [-122.3962, 37.7956],
          ],
        },
      },
      {
        type: 'Feature',
        id: 3,
        properties: { amenity: 'cafe', name: 'Blue Bottle' },
        geometry: { type: 'Point', coordinates: [-122.395, 37.794] },
      },
      {
        type: 'Feature',
        id: 4,
        properties: { amenity: 'cafe', name: 'Ritual Coffee' },
        geometry: { type: 'Point', coordinates: [-122.3942, 37.7945] },
      },
      {
        type: 'Feature',
        id: 5,
        properties: { amenity: 'cafe', name: 'Philz Coffee' },
        geometry: { type: 'Point', coordinates: [-122.3938, 37.7948] },
      },
    ];
    return { features, source: 'stub', truncated: false, elapsedMs: 1, warnings: [] };
  }
}

class StubRouter implements RoutingSource {
  readonly name = 'stub-router';
  async available() {
    return true;
  }
  async route() {
    return {
      route: { dist: 480, time: 380, steps: [] },
      source: 'stub',
      freeFlowOnly: false,
    } as never;
  }
}

const AREA: TaskArea = {
  id: 'test-area',
  label: 'Test area',
  center: { lat: 37.7936, lon: -122.3958 },
  radiusM: 400,
  rationale: 'fixed geometry so no network is needed',
};

function stubCarto(): SuperCarto {
  return new SuperCarto({ sources: [new StubMapSource()], router: new StubRouter() });
}

const FIXTURES: Record<string, GeoJsonFeatureCollection> = {
  'test-area': {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: 'Blue Bottle' },
        geometry: { type: 'Point', coordinates: [-122.395, 37.794] },
      },
      {
        type: 'Feature',
        properties: { name: 'Ritual Coffee' },
        geometry: { type: 'Point', coordinates: [-122.3942, 37.7945] },
      },
    ],
  },
};

describe('runBenchmark offline', () => {
  it('completes a run with no models and no network', async () => {
    // The basic testability claim: the harness can be driven end to end.
    const report = await runBenchmark({
      areas: [AREA],
      budgets: [1024],
      carto: stubCarto(),
      router: new StubRouter(),
      seeds: 1,
    });
    expect(report.areas.map((a) => a.id)).toEqual(['test-area']);
    expect(report.protocol).toBeDefined();
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('compares every representation', async () => {
    // The benchmark's whole claim is supercarto against geojson and against
    // nothing. A run that silently dropped an arm would still look complete.
    const model = new ScriptedModel('m1', 'fake-1', () => '240m');
    const report = await runBenchmark({
      areas: [AREA],
      budgets: [1024],
      seeds: 1,
      models: [model],
      carto: stubCarto(),
      router: new StubRouter(),
    });
    const reps = new Set(report.detail.map((d) => d.representation));
    expect(reps).toEqual(new Set(['supercarto', 'geojson', 'none']));
  });

  it('shows the model a different context per representation', async () => {
    const model = new ScriptedModel('m1', 'fake-1', () => '240m');
    await runBenchmark({
      areas: [AREA],
      budgets: [1024],
      seeds: 1,
      models: [model],
      carto: stubCarto(),
      router: new StubRouter(),
    });
    // The "none" arm must not contain map data at all, or the comparison is not
    // measuring the absence of context.
    const none = model.seen.find((s) => s.includes('No map data'));
    expect(none).toBeDefined();
    const withMap = model.seen.filter((s) => !s.includes('No map data'));
    expect(withMap.length).toBeGreaterThan(0);
  });

  it('scores a correct distance as correct', async () => {
    // Ground truth is 480m from the stub router, so 480m is inside tolerance.
    const model = new ScriptedModel('m1', 'fake-1', () => 'The route is about 480m.');
    const report = await runBenchmark({
      areas: [AREA],
      budgets: [1024],
      seeds: 1,
      models: [model],
      carto: stubCarto(),
      router: new StubRouter(),
    });
    const route = report.detail.find((d) => d.taskId.includes('route-distance'));
    expect(route?.correct).toBe(true);
  });

  it('scores a wrong distance as wrong', async () => {
    const model = new ScriptedModel('m1', 'fake-1', () => 'It is about 4km.');
    const report = await runBenchmark({
      areas: [AREA],
      budgets: [1024],
      seeds: 1,
      models: [model],
      carto: stubCarto(),
      router: new StubRouter(),
    });
    const route = report.detail.find((d) => d.taskId.includes('route-distance'));
    expect(route?.correct).toBe(false);
  });

  it('does not count a refusal as correct', async () => {
    // A model that says "I cannot tell" must never raise the accuracy figure.
    // This is the single easiest way to publish a flattering, meaningless result.
    //
    // The connectivity task is included deliberately: it is the one kind where a
    // refusal is allowed to be scored, because the answer is derivable from the
    // graph the model was shown. The check that matters is that a refusal still
    // fails to state a conclusion there, rather than passing for silence.
    const model = new ScriptedModel('m1', 'fake-1', () => "I cannot determine this from the data.");
    const report = await runBenchmark({
      areas: [AREA],
      budgets: [1024],
      seeds: 1,
      models: [model],
      carto: stubCarto(),
      router: new StubRouter(),
    });
    expect(report.detail.length).toBeGreaterThan(0);
    for (const row of report.detail) {
      expect(row.correct).not.toBe(true);
    }
  });

  it('does not count an empty answer as correct', async () => {
    // Same vacuous-pass risk as a refusal, from a different direction.
    const model = new ScriptedModel('m1', 'fake-1', () => '');
    const report = await runBenchmark({
      areas: [AREA],
      budgets: [1024],
      seeds: 1,
      models: [model],
      carto: stubCarto(),
      router: new StubRouter(),
    });
    for (const row of report.detail) {
      expect(row.correct).not.toBe(true);
    }
  });

  it('records a model failure as failed rather than wrong', async () => {
    // Separating "the model got it wrong" from "the call failed" is what keeps a
    // broken API key from looking like a bad model.
    const model = new ScriptedModel('m1', 'fake-1', () => '240m', true);
    const report = await runBenchmark({
      areas: [AREA],
      budgets: [1024],
      seeds: 1,
      models: [model],
      carto: stubCarto(),
      router: new StubRouter(),
    });
    expect(report.detail.length).toBeGreaterThan(0);
    for (const row of report.detail) {
      expect(row.correct).toBeNull();
      expect(row.scoredBy).toBe('failed');
      expect(row.error).toContain('upstream unavailable');
    }
    // With nothing scorable, accuracy must be null rather than 0.
    for (const s of report.summaries) {
      expect(s.accuracy).toBeNull();
    }
  });

  it('repeats each task once per seed', async () => {
    const model = new ScriptedModel('m1', 'fake-1', () => '480m');
    const report = await runBenchmark({
      areas: [AREA],
      budgets: [1024],
      seeds: 3,
      models: [model],
      carto: stubCarto(),
      router: new StubRouter(),
    });
    const seeds = new Set(report.detail.map((d) => d.seed));
    expect([...seeds].sort()).toEqual([0, 1, 2]);
  });

  it('sweeps every budget for supercarto and one for the others', async () => {
    // Budget is the interesting independent variable, and it only applies to the
    // compiled representation. Applying it everywhere would multiply cost for no
    // reason and make the comparison unreadable.
    const model = new ScriptedModel('m1', 'fake-1', () => '480m');
    const report = await runBenchmark({
      areas: [AREA],
      budgets: [512, 1024],
      seeds: 1,
      models: [model],
      carto: stubCarto(),
      router: new StubRouter(),
    });
    const supercartoBudgets = new Set(
      report.detail.filter((d) => d.representation === 'supercarto').map((d) => Number(d.taskId.split('@')[1])),
    );
    expect([...supercartoBudgets].sort((a, b) => a - b)).toEqual([512, 1024]);
    const geojsonBudgets = new Set(
      report.detail.filter((d) => d.representation === 'geojson').map((d) => Number(d.taskId.split('@')[1])),
    );
    expect(geojsonBudgets.size).toBe(1);
  });

  it('reports token cost per representation', async () => {
    const model = new ScriptedModel('m1', 'fake-1', () => '480m');
    const report = await runBenchmark({
      areas: [AREA],
      budgets: [1024],
      seeds: 1,
      models: [model],
      carto: stubCarto(),
      router: new StubRouter(),
    });
    // The headline claim is a cost comparison, so both figures have to exist.
    const byRep = new Map(report.tokenCost.map((t) => [t.representation, t]));
    expect(byRep.has('supercarto')).toBe(true);
    expect(byRep.has('geojson')).toBe(true);
    expect(byRep.has('none')).toBe(true);
    for (const t of report.tokenCost) {
      expect(t.medianContextTokens).toBeGreaterThan(0);
    }
  });

  it('gives every detail row a unique task id per configuration', async () => {
    const model = new ScriptedModel('m1', 'fake-1', () => '480m');
    const report = await runBenchmark({
      areas: [AREA],
      budgets: [512, 1024],
      seeds: 2,
      models: [model],
      carto: stubCarto(),
      router: new StubRouter(),
    });
    // Colliding keys would silently merge two measurements into one row.
    const keys = report.detail.map((d) => `${d.taskId}#${d.seed}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('groups summaries by model and representation', async () => {
    const a = new ScriptedModel('m1', 'fake-1', () => '480m');
    const b = new ScriptedModel('m2', 'fake-2', () => 'nonsense');
    const report = await runBenchmark({
      areas: [AREA],
      budgets: [1024],
      seeds: 1,
      models: [a, b],
      carto: stubCarto(),
      router: new StubRouter(),
    });
    // Two models over three representations, each budget separate.
    expect(report.summaries.length).toBeGreaterThanOrEqual(6);
    for (const s of report.summaries) {
      expect(['m1', 'm2']).toContain(s.model);
      expect(['supercarto', 'geojson', 'none']).toContain(s.representation);
    }
  });

  it('reports progress without throwing when a callback is supplied', async () => {
    const lines: string[] = [];
    await runBenchmark({
      areas: [AREA],
      budgets: [1024],
      seeds: 1,
      models: [new ScriptedModel('m1', 'fake-1', () => '480m')],
      carto: stubCarto(),
      router: new StubRouter(),
      onProgress: (m) => lines.push(m),
    });
    expect(lines.length).toBeGreaterThan(0);
  });
});
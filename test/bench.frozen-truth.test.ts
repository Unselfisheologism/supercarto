import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SuperCarto } from '../src/index.js';
import { groundTruth } from '../src/bench/runner.js';
import { buildTasks, SYNTHETIC_AREA } from '../src/bench/tasks.js';
import type { GeoJsonFeatureCollection } from '../src/ingest/geojson.js';

/**
 * Ground truth must be reproducible, or a re-score is not a check on the model.
 *
 * Two runs a month apart can legitimately disagree when truth is queried live: OSM
 * changes, Overpass has outages, and a router's answer is a function of whatever
 * network was reachable that day. An archive of answers that cannot be graded the
 * same way twice is not evidence of anything.
 *
 * Every kind that still measures something derives its truth from the fixture
 * through `compileFixture`, which is a pure function of fixture, area and budget.
 * The fixtures are committed and their sha256 is recorded in the archive metadata,
 * so re-scoring reproduces the original run's truth exactly. This test pins that,
 * because the alternative failure is silent: truth quietly drifting back to the
 * network looks like a passing test.
 */
describe('ground truth is frozen', () => {
  const fixture = JSON.parse(
    readFileSync('fixtures/bench/synthetic-pacific.geojson', 'utf8'),
  ) as GeoJsonFeatureCollection;

  /**
   * Every network path is wired to throw.
   *
   * If truth still comes back populated, it cannot have come from Overpass or from
   * the reference router. `groundTruth` catches and returns `{}` on failure, so the
   * assertions must check the truth is actually there - an empty result would
   * otherwise look like a pass.
   */
  const offlineCart = {
    async maplet(): Promise<never> {
      throw new Error('live fetch attempted');
    },
    async route(): Promise<never> {
      throw new Error('reference router consulted');
    },
  } as unknown as SuperCarto;

  const deadRouter = {
    name: 'dead',
    async available() {
      throw new Error('reference router consulted');
    },
    async route(): Promise<never> {
      throw new Error('reference router consulted');
    },
  } as never;

  const tasks = buildTasks([SYNTHETIC_AREA]);
  const fixtures = { 'synthetic-pacific': fixture };

  /**
   * One compile per task kind, shared across the assertions below.
   *
   * Compiling a 4,570-feature grid costs seconds, and the suite runs this file
   * alongside every other one. Recomputing the same truth per assertion made this
   * file the slowest in the suite and pushed individual tests into the timeout on a
   * loaded machine - a failure that reads as a logic bug and is not one.
   */
  const cache = new Map<string, Awaited<ReturnType<typeof groundTruth>>>();
  const truthOnce = async (kind: string) => {
    const task = tasks.find((t) => t.kind === kind)!;
    if (!cache.has(task.id)) {
      cache.set(task.id, await groundTruth(task, deadRouter, offlineCart, fixtures, 'supercarto', 1024));
    }
    return cache.get(task.id)!;
  };

  it('yields no truth without a fixture, proving the offline stubs bite', async () => {
    // The control for everything else.
    //
    // `groundTruth` catches failures and returns `{}`, so a test that only asserts
    // "truth came back non-empty" would also pass against a harness where the stubs
    // never fired and truth was silently empty. Dropping the fixture must force the
    // live path, which must throw, which must produce `{}`.
    const task = tasks.find((t) => t.kind === 'omission')!;
    const truth = await groundTruth(task, deadRouter, offlineCart, undefined, 'supercarto', 1024);

    expect(Object.keys(truth)).toHaveLength(0);
  });

  it('derives every kind of truth from the fixture, with no network', async () => {
    for (const task of tasks) {
      const truth = await truthOnce(task.kind);

      // Not empty. `groundTruth` swallows failures and returns `{}`, so this is the
      // assertion that makes the rest of the suite's pass meaningful.
      expect(Object.keys(truth).length, `${task.kind} truth was empty`).toBeGreaterThan(0);
    }
  });

  it('is identical across repeated calls, so a re-score is a re-score', async () => {
    const task = tasks.find((t) => t.kind === 'omission')!;

    const a = await groundTruth(task, deadRouter, offlineCart, fixtures, 'supercarto', 1024);
    const b = await groundTruth(task, deadRouter, offlineCart, fixtures, 'supercarto', 1024);

    expect(Object.keys(a).length).toBeGreaterThan(0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('builds omission truth from the fixture, not a live map', async () => {
    const truth = await truthOnce('omission');

    expect(truth.sourceFeatures).toBe(fixture.features.length);
    expect(truth.omitted?.length).toBeGreaterThan(0);
  });

  it('measures recall against the names the arm was shown', async () => {
    const truth = await truthOnce('nearest');

    // The supercarto arm is graded against what survived budget fitting, not
    // against every name in the area. Grading it against the full list measures
    // the budget rather than the model's reading of the map it was handed.
    expect(truth.shownNames!.length).toBeGreaterThan(0);
    expect(truth.shownNames!.length).toBeLessThan(truth.names!.length);
  });
});
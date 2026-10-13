import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SuperCarto } from '../src/index.js';
import { buildContext, groundTruth } from '../src/bench/runner.js';
import {
  buildTasks,
  SYNTHETIC_AREA,
  SYNTHETIC_DIFF_AREA,
  TASK_AREAS,
} from '../src/bench/tasks.js';
import { scoreArchived } from '../src/bench/rescore.js';
import type { GeoJsonFeatureCollection } from '../src/ingest/geojson.js';
import type { Exchange } from '../src/bench/archive.js';

/**
 * The diff track, phase 2: single-turn diff reading (benefit #5).
 *
 * The agent was shown map A; areas changed; the prompt carries A's summary
 * plus the rendered A-to-B diff, and the question asks about the current map.
 * The raw arm re-reads both snapshots in full - the cost the protocol exists
 * to avoid. Truth is B's names; scoring is exact, because with two names on
 * the table half recall would pass applying only the removal or only the
 * addition.
 */
const deadRouter = {
  name: 'dead',
  async available(): Promise<never> {
    throw new Error('reference router consulted');
  },
  async route(): Promise<never> {
    throw new Error('reference router consulted');
  },
} as never;

const offlineCart = {
  async maplet(): Promise<never> {
    throw new Error('live fetch attempted');
  },
  async route(): Promise<never> {
    throw new Error('reference router consulted');
  },
} as unknown as SuperCarto;

function load(n: string): GeoJsonFeatureCollection {
  return JSON.parse(readFileSync(`fixtures/bench/synthetic-diff-${n}.geojson`, 'utf8'));
}
const fixtures = { 'synthetic-diff-a': load('a'), 'synthetic-diff-b': load('b') };
const task = buildTasks([SYNTHETIC_DIFF_AREA])[0]!;

describe('the diff task exists, and only where it is measurable', () => {
  it('generates exactly one kind for the diff area', () => {
    expect(buildTasks([SYNTHETIC_DIFF_AREA]).map((t) => t.kind)).toEqual(['diff']);
    expect(task.id).toBe('synthetic-diff/diff');
    expect(task.groundTruth).toBe('diff-applied');
  });

  it('adds nothing to any other area', () => {
    expect(buildTasks([SYNTHETIC_AREA]).map((t) => t.kind).sort()).toEqual([
      'connectivity',
      'nearest',
      'omission',
    ]);
    const real = TASK_AREAS.find((a) => a.id === 'sf-cbd')!;
    expect(buildTasks([real]).map((t) => t.kind).sort()).toEqual([
      'connectivity',
      'nearest',
      'route',
      'turns',
    ]);
  });
});

describe('diff ground truth', () => {
  it('lists the current snapshot names, with no network', async () => {
    const truth = await groundTruth(task, deadRouter, offlineCart, fixtures, 'supercarto', 1024);
    expect(truth.names?.sort()).toEqual(['Cafe Elvo', 'Cafe Faro']);
    expect(truth.aliases?.sort()).toEqual(['Cafe Duna', 'Drift Lane']);
  });
});

describe('the diff prompt', () => {
  it('shows the previous map plus exactly the designed changes', async () => {
    const ctx = await buildContext(task, 'supercarto', 1024, offlineCart, () => {}, undefined, fixtures);
    expect(ctx.text).toMatch(/Cafe Duna/);
    expect(ctx.text).toContain('- 401 Cafe Duna (poi)');
    expect(ctx.text).toContain('+ 403 Cafe Faro (poi)');
    // No spurious updates: shared envelope, verified here as in the design.
    expect(ctx.text).not.toMatch(/~ /);
  });

  it('gives the geojson arm both snapshots in full', async () => {
    const ctx = await buildContext(task, 'geojson', 1024, offlineCart, () => {}, undefined, fixtures);
    expect(ctx.text).toMatch(/Previous snapshot/);
    expect(ctx.text).toMatch(/Current snapshot/);
    expect(ctx.text).toContain('Cafe Faro');
  });
});

describe('scoring diff', () => {
  const truth = { names: ['Cafe Elvo', 'Cafe Faro'], aliases: ['Cafe Duna', 'Drift Lane'] };

  function row(answer: string) {
    return scoreArchived(
      {
        key: 'k',
        taskId: 'synthetic-diff/diff',
        representation: 'supercarto',
        budget: 1024,
        seed: 0,
        model: 'm',
        system: '',
        user: '',
        promptHash: 'h',
        answer,
        inputTokens: 1,
        outputTokens: 1,
        at: '',
      } as Exchange,
      'diff',
      truth,
    );
  }

  it('passes the fused set', () => {
    // Elvo survives from the old map, Faro arrives via the diff. Either half
    // alone is the task half-done.
    expect(row('Cafe Elvo and Cafe Faro are cafes, and Drift Lane is a road.').correct).toBe(true);
    // Naming the removed place as removed is correct diff reading, not invention.
    expect(row('Cafe Elvo and Cafe Faro are current; Cafe Duna has been removed.').correct).toBe(true);
  });

  it('fails applying only the removal', () => {
    expect(row('Cafe Elvo.').correct).toBe(false);
  });

  it('fails applying only the addition', () => {
    expect(row('Cafe Elvo and Cafe Faro and a new place called Cafe X.').correct).toBe(false);
  });

  it('fails a refusal', () => {
    expect(row('I cannot determine this from the data.').correct).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SuperCarto } from '../src/index.js';
import { buildContext, groundTruth } from '../src/bench/runner.js';
import { fromScr } from '../src/index.js';
import {
  buildTasks,
  SYNTHETIC_AREA,
  SYNTHETIC_EXPANSION_AREA,
  TASK_AREAS,
} from '../src/bench/tasks.js';
import { pointInRing, scoreExpansion } from '../src/bench/score.js';
import { scoreArchived } from '../src/bench/rescore.js';
import type { GeoJsonFeatureCollection } from '../src/ingest/geojson.js';
import type { Exchange } from '../src/bench/archive.js';

/**
 * The expansion track: benefit #4 of the planning doc, the first agentic task.
 *
 * The capability under test is the protocol's signature move - compact summary
 * now, exact geometry on demand through expand_feature. The maplet names the
 * cafes but carries no coordinates; the only path to the answer runs through
 * the tool. A raw GeoJSON dump answers the same question at two orders of
 * magnitude more tokens, which is the comparison the benchmark exists to make.
 */
const fixture = JSON.parse(
  readFileSync('fixtures/bench/synthetic-expansion.geojson', 'utf8'),
) as GeoJsonFeatureCollection;

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

const fixtures = { 'synthetic-expansion': fixture };
const task = buildTasks([SYNTHETIC_EXPANSION_AREA])[0]!;

describe('the expansion task exists, and only where it is measurable', () => {
  it('generates exactly one kind for the micro-area', () => {
    expect(buildTasks([SYNTHETIC_EXPANSION_AREA]).map((t) => t.kind)).toEqual(['expand']);
    expect(task.id).toBe('synthetic-expansion/expansion');
    expect(task.groundTruth).toBe('fixture-geometry');
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

describe('expansion ground truth', () => {
  it('finds Cafe Alba inside and the others outside, with no network', async () => {
    const truth = await groundTruth(task, deadRouter, offlineCart, fixtures, 'supercarto', 1024);
    expect(truth.inside).toEqual(['Cafe Alba']);
    expect(truth.candidates?.sort()).toEqual(['Cafe Alba', 'Cafe Bex', 'Cafe Coro']);
  });

  it('shares one point-in-ring implementation with the tests', () => {
    const rect: [number, number][] = [
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
      [0, 0],
    ];
    expect(pointInRing(rect, [2, 1])).toBe(true);
    expect(pointInRing(rect, [5, 1])).toBe(false);
    expect(pointInRing(rect, [2, 4])).toBe(false);
  });
});

describe('the expansion prompt', () => {
  it('carries no coordinates but bundles the expandable document', async () => {
    const ctx = await buildContext(task, 'supercarto', 1024, offlineCart, () => {}, undefined, fixtures);
    expect(ctx.text).toMatch(/Cafe Alba/);
    // The area centre (44.01) is fine to show; the feature coordinates are
    // not. Each of these decimals is distinctive to one feature.
    const yaml = ctx.text.split('<scr>')[0]!;
    for (const coord of ['44.01005', '44.0095', '-150.0106', '-150.009438', '44.009864']) {
      expect(yaml).not.toContain(coord);
    }
    expect(ctx.text).toMatch(/<scr>/);
    const scr = ctx.text.split('<scr>\n')[1]!.split('\n</scr>')[0]!;
    const doc = fromScr(scr).doc;
    const ids = doc.features.map((f) => f.id).sort((a, b) => a - b);
    expect(ids).toEqual([100, 101, 102, 103, 104]);
    const bldg = doc.features.find((f) => f.id === 100)!;
    expect(bldg.geometry.kind).toBe('polygon');
  });

  it('gives the geojson arm raw data and no bundle', async () => {
    const ctx = await buildContext(task, 'geojson', 1024, offlineCart, () => {}, undefined, fixtures);
    expect(ctx.text).toMatch(/44\.01/);
    expect(ctx.text).not.toMatch(/<scr>/);
  });
});

describe('scoring expansion', () => {
  const inside = ['Cafe Alba'];
  const candidates = ['Cafe Alba', 'Cafe Bex', 'Cafe Coro'];

  it('passes the exact set, in any order and case, and reports the axis', () => {
    const s = scoreExpansion('Cafe Alba is inside.', inside, candidates, true);
    expect(s.correct).toBe(true);
    expect(s.flags).toEqual([]);
  });

  it('fails a subset: the confident partial answer', () => {
    // Naming one of two inside cafes claims the question answered while
    // leaving half out. Partial credit would reward stopping early.
    const s = scoreExpansion('Cafe Alba', ['Cafe Alba', 'Cafe Bex'], candidates, true);
    expect(s.correct).toBe(false);
    expect(s.flags.join(' ')).toMatch(/missed/);
  });

  it('fails an extra name and an empty answer', () => {
    expect(scoreExpansion('Cafe Alba and Cafe Bex', inside, candidates, true).correct).toBe(false);
    const s = scoreExpansion('The cafes are nearby.', inside, candidates, false);
    expect(s.correct).toBe(false);
    expect(s.flags.join(' ')).toMatch(/none of the candidates/);
  });

  it('records answering-without-expanding without failing for it', () => {
    const s = scoreExpansion('Cafe Alba', inside, candidates, false);
    expect(s.correct).toBe(true);
    expect(s.flags.join(' ')).toMatch(/without expanding/);
  });

  it('re-scores from the archive with the axis intact', () => {
    const exchange = {
      key: 'k',
      taskId: 'synthetic-expansion/expansion',
      representation: 'supercarto',
      budget: 1024,
      seed: 0,
      model: 'm',
      system: '',
      user: '',
      promptHash: 'h',
      answer: 'Cafe Alba',
      inputTokens: 1,
      outputTokens: 1,
      at: '',
      toolsUsed: ['expand_feature'],
    } as Exchange;
    const row = scoreArchived(exchange, 'expand', { inside, candidates });
    expect(row.correct).toBe(true);
    const untracked = scoreArchived({ ...exchange, toolsUsed: undefined }, 'expand', {
      inside,
      candidates,
    });
    expect(untracked.correct).toBe(true);
    expect(untracked.rationale).toMatch(/without expanding/);
  });
});

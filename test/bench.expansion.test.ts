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
import { pointInRing, polygonAreaM2, scoreExpansion } from '../src/bench/score.js';
import { scoreArchived } from '../src/bench/rescore.js';
import type { GeoJsonFeatureCollection } from '../src/ingest/geojson.js';
import type { Exchange } from '../src/bench/archive.js';

/**
 * The expansion track: benefit #4 of the planning doc, the first agentic task.
 *
 * The capability under test is the protocol's signature move - compact summary
 * now, exact geometry on demand through expand_feature. The maplet states no
 * area and carries no coordinates; the only path to the number runs through
 * the tool. A raw GeoJSON dump answers the same question at far higher token
 * cost, which is the comparison the benchmark exists to make.
 *
 * The question asks for an area rather than a name deliberately. The first
 * formulation (which cafe lies inside the footprint) proved guessable without
 * the tool: a 1-in-3 name pick scores a third of the time by chance, and both
 * models' passes came from guessing. An area has no guessable answer.
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

// Source rectangle: 0.0005° lon x 0.000272° lat at 44.01° ≈ 40.0m x 30.1m.
const TRUTH_M2 = 1204;

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
  it('computes the footprint area from source geometry, with no network', async () => {
    const truth = await groundTruth(task, deadRouter, offlineCart, fixtures, 'supercarto', 1024);
    expect(truth.areaM2).toBeDefined();
    expect(Math.abs(truth.areaM2! - TRUTH_M2)).toBeLessThan(1);
  });

  it('shares one projection between truth and tests', () => {
    const rect: [number, number][] = [
      [-150.01025, 44.009864],
      [-150.00975, 44.009864],
      [-150.00975, 44.010136],
      [-150.01025, 44.010136],
      [-150.01025, 44.009864],
    ];
    expect(Math.abs(polygonAreaM2(rect) - TRUTH_M2)).toBeLessThan(1);
    expect(pointInRing(
      [
        [0, 0],
        [4, 0],
        [4, 3],
        [0, 3],
        [0, 0],
      ],
      [2, 1],
    )).toBe(true);
  });
});

describe('the expansion prompt', () => {
  it('states no area and carries no coordinates, but bundles the document', async () => {
    // The question is appended by runOne, not buildContext, so it is checked
    // on the task: it must demand units, because the scorer requires them
    // (a bare "1200" would read "feature 100" as the answer).
    expect(task.question).toMatch(/square metres/);
    const ctx = await buildContext(task, 'supercarto', 1024, offlineCart, () => {}, undefined, fixtures);
    const yaml = ctx.text.split('<scr>')[0]!;
    for (const coord of ['44.01005', '44.0095', '-150.0106', '-150.009438', '44.009864']) {
      expect(yaml).not.toContain(coord);
    }
    // And no area figure leaks through the summary either.
    expect(yaml).not.toMatch(/1204|1,204|31,?416/);
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
  it('passes a computed area within tolerance and reports the axis', () => {
    // Grid-derived area is ~1127 (6.4% under truth from quantization); a
    // correct method with sloppy rounding still clears 20%.
    const s = scoreExpansion('The footprint is about 1150 square metres.', TRUTH_M2, true);
    expect(s.correct).toBe(true);
    expect(s.flags).toEqual([]);
  });

  it('reads through thousands separators', () => {
    // Measured: four correct step-5 answers ("1,200" / "1,198" / "1,130" /
    // "1,210" m²) were failed as "200" / "198" / "130" / "210" because the
    // number pattern matched after the comma. A separator is formatting.
    const s = scoreExpansion('about 1,200 m².', TRUTH_M2, true);
    expect(s.correct).toBe(true);
    expect(s.flags).toEqual([]);
  });

  it('fails a guess nowhere near truth', () => {
    // The point of asking for a number: the answer space is every positive
    // number, so there is no 1-in-3 pick. A guess cannot land here by chance
    // in any strategy worth the name.
    const s = scoreExpansion('Roughly 5000 m².', TRUTH_M2, true);
    expect(s.correct).toBe(false);
    expect(s.flags.join(' ')).toMatch(/stated 5000/);
  });

  it('fails an answer with no area figure, including a bare name', () => {
    // The old formulation's winning move - naming a cafe - states no area
    // and must not pass the new one.
    const s = scoreExpansion('Cafe Alba', TRUTH_M2, false);
    expect(s.correct).toBe(false);
    expect(s.flags.join(' ')).toMatch(/no area stated/);
  });

  it('does not mistake feature 100 for an area', () => {
    // "feature 100" contains digits; without units after the number it must
    // not read as 100 m² (which would fail anyway, but for the wrong reason
    // and with a confusing rationale).
    const s = scoreExpansion('Feature 100 is the building.', TRUTH_M2, false);
    expect(s.correct).toBe(false);
    expect(s.flags.join(' ')).toMatch(/no area stated/);
  });

  it('records answering-without-expanding without failing for it', () => {
    const s = scoreExpansion('1204 m²', TRUTH_M2, false);
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
      answer: 'About 1150 m²',
      inputTokens: 1,
      outputTokens: 1,
      at: '',
      toolsUsed: ['expand_feature'],
    } as Exchange;
    const row = scoreArchived(exchange, 'expand', { areaM2: TRUTH_M2 });
    expect(row.correct).toBe(true);
    const untracked = scoreArchived({ ...exchange, toolsUsed: undefined }, 'expand', {
      areaM2: TRUTH_M2,
    });
    expect(untracked.correct).toBe(true);
    expect(untracked.rationale).toMatch(/without expanding/);
  });
});

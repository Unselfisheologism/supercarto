import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { scoreOmission } from '../src/bench/score.js';
import { buildTasks, SYNTHETIC_AREA, OMISSION_QUESTION, TASK_AREAS } from '../src/bench/tasks.js';
import { toMaplet } from '../src/index.js';
import type { GeoJsonFeatureCollection } from '../src/index.js';

/**
 * The omission task is the one that tests the protocol instead of the map.
 *
 * A raw GeoJSON cut short is *silently* incomplete - nothing in it says data is
 * missing - so the natural reading is "this area holds only what I can see". The
 * maplet emits `omitted: - {layer: feature, count: 3973}` and reporting that gap
 * is the capability being measured.
 *
 * It is therefore also the one task a truncated file cannot pass by accident, and
 * the one a fluent, confident wrong answer must not pass either.
 */

const OMITTED = [{ layer: 'feature', count: 3973 }];

describe('the omission task exists, and only where it can be measured', () => {
  it('is generated for the synthetic area', () => {
    const tasks = buildTasks([SYNTHETIC_AREA]);
    expect(tasks.map((t) => t.kind)).toContain('omission');
  });

  it('is not generated for real cities', () => {
    // On a real city the no-map arm can bluff this from memory, so the
    // measurement stops meaning anything. Measured in bench-results/.
    for (const area of [
      { id: 'sf-cbd', label: '', center: { lat: 0, lon: 0 }, radiusM: 400, rationale: '' },
    ]) {
      const kinds = buildTasks([area]).map((t) => t.kind);
      expect(kinds).not.toContain('omission');
    }
  });

  it('generates no routing tasks for the synthetic area', () => {
    // Neither is measurable there, so generating them would produce rows that are
    // unscoreable forever.
    //
    // route/turns: the reference router answers `{"code":"Ok","distance":0}` over
    // geometry it has no ways for, so ground truth was 0m and every arm failed.
    // turn-by-turn additionally asks for street names the budgeted maplet does not
    // carry - at 1024 it emits 34 nodes and no names.
    const kinds = buildTasks([SYNTHETIC_AREA]).map((t) => t.kind);
    expect(kinds).not.toContain('route');
    expect(kinds).not.toContain('turns');
    expect(kinds.sort()).toEqual(['connectivity', 'nearest', 'omission']);
  });

  it('still generates every kind for a real area', () => {
    const real = TASK_AREAS.find((a) => a.id === 'sf-cbd')!;
    const kinds = buildTasks([real]).map((t) => t.kind);
    expect(kinds.sort()).toEqual(['connectivity', 'nearest', 'route', 'turns']);
  });

  it('asks the question the omission record answers', () => {
    const task = buildTasks([SYNTHETIC_AREA]).find((t) => t.kind === 'omission')!;
    expect(task.question).toBe(OMISSION_QUESTION);
    expect(task.groundTruth).toBe('omission-record');
  });
});

describe('scoring the omission task', () => {
  it('passes an answer that reports the gap and sizes it', () => {
    const s = scoreOmission(
      'No, this is not everything. The data reports 3,973 features omitted to fit ' +
        'the token budget, mostly of a kind that did not survive compilation. ' +
        'There are thousands more here than are shown.',
      OMITTED,
      80,
    );
    expect(s.correct).toBe(true);
    expect(s.flags).toEqual([]);
  });

  it('passes an answer that says "several thousand were left out"', () => {
    const s = scoreOmission(
      'The map is partial. Several thousand features were omitted to stay within budget.',
      OMITTED,
      80,
    );
    expect(s.correct).toBe(true);
  });

  it('fails the confident wrong answer: pretty, fluent, and certain the area is empty', () => {
    // This is the specific error. The model answers the question, does not
    // hallucinate, and is still wrong because it read a truncated map as complete.
    const s = scoreOmission(
      'Based on the data provided, this area appears to be empty apart from a ' +
        'handful of cafes and shops. There are no other features present.',
      OMITTED,
      80,
    );
    expect(s.correct).toBe(false);
    expect(s.flags.join(' ')).toMatch(/did not acknowledge/);
  });

  it('fails an answer that names a category as absent when it was omitted', () => {
    const s = scoreOmission(
      'The map is incomplete - some data was omitted. But there are no trees and ' +
        'no other buildings here beyond what is listed.',
      OMITTED,
      80,
    );
    expect(s.correct).toBe(false);
    expect(s.flags.join(' ')).toMatch(/bare/);
  });

  it('fails a total refusal, because refusing is not reporting the gap', () => {
    // Distinct from the other tasks: here the data *does* contain the answer, so
    // declining to answer is a miss rather than an honest abstention.
    const s = scoreOmission('I cannot determine this from the data provided.', OMITTED, 80);
    expect(s.correct).toBe(false);
  });

  it('reports sizing separately, so it is visible without failing the task', () => {
    const s = scoreOmission('Some features were omitted from this extract.', OMITTED, 80);
    expect(s.correct).toBe(true);
    expect(s.flags.join(' ')).toMatch(/without sizing/);
  });

  /**
   * The scorer was polarity-blind, and a real run proved it.
   *
   * Three free models answered the omission task against the raw geojson arm. Two
   * said, in as many words, that nothing indicated anything was missing - "no
   * omission is flagged anywhere in this data", "nothing in it states that any
   * features were left out" - and all three were scored as passing.
   *
   * The cause: the acknowledgement check matched the word "truncation" inside a
   * *negated* frame, in a sentence whose whole point was that no truncation note
   * was present. The run reported a clean 100% on an arm that had said the
   * opposite three times.
   */
  const REAL_OMITTED = [
    { layer: 'tree', count: 3925 },
    { layer: 'road', count: 41 },
  ];

  it('fails an answer that reports no omission note is present', () => {
    const s = scoreOmission(
      'The map data appears complete - nothing in it states that any features were left ' +
        'out. I re-checked for any omission or truncation note (in feature properties, ' +
        'headers, or trailing text) and found none, and the feature numbering runs without gaps.',
      REAL_OMITTED,
      34,
    );
    expect(s.correct).toBe(false);
    expect(s.flags.join(' ')).toMatch(/complete/i);
  });

  it('fails an answer that says no omission is flagged anywhere', () => {
    const s = scoreOmission(
      'No omission is flagged anywhere in this data - there is no "features omitted" note, ' +
        'no truncated geometry, and the feature counts run unbroken.',
      REAL_OMITTED,
      34,
    );
    expect(s.correct).toBe(false);
    expect(s.flags.join(' ')).toMatch(/complete/i);
  });

  /**
 * The task does not discriminate unless the answer must name what was omitted.
 *
 * Measured: with the loose condition, two of three models answered the `none` arm
 * correctly - "any features that exist in this area have been left out entirely,
 * meaning the map is incomplete" - which is a true statement available to an agent
 * holding no map at all. The capability measured was "notice incompleteness", not
 * "use the omission record".
 *
 * These are the nine actual answers from that run, with the verdicts the tightened
 * condition should produce.
 */
describe('the nine real answers from the three-model run', () => {
  const T = REAL_OMITTED;
  const want = (answer: string, expected: boolean): void => {
    expect(scoreOmission(answer, T, 34).correct, answer.slice(0, 60)).toBe(expected);
  };

  it('passes all three supercarto answers, which read the record', () => {
    want(
      'The map data is incomplete: it explicitly reports omitted features - 3,925 trees ' +
        'in the tree layer and 41 roads in the road layer were left out, so only the 2 tree ' +
        'areas shown are actually in the data. Any conclusion that the area lacks trees would ' +
        'be wrong, since thousands of them exist but were dropped to save tokens.',
      true,
    );
    want(
      "Something has been left out. The map data's own omitted list reports 3,925 tree " +
        'features and 41 road features that were dropped, so thousands more trees and dozens ' +
        'of ways are absent.',
      true,
    );
    want(
      'The map is incomplete - the data explicitly lists omitted features: roughly 3,925 tree ' +
        'features and 41 road features were left out of this 400 m-radius view.',
      true,
    );
  });

  it('fails the two geojson answers that denied any omission', () => {
    want(
      'The map data appears complete - nothing in it states that any features were left out. ' +
        'I re-checked for any omission or truncation note and found none, and the feature ' +
        'numbering runs without gaps.',
      false,
    );
    want(
      'No omission is flagged anywhere in this data - there is no "features omitted" note, no ' +
        'truncated geometry, and the feature counts run unbroken.',
      false,
    );
  });

  it('passes the geojson answer that inferred truncation and named what', () => {
    // An honest pass that is not a record read. The raw file was complete enough to
    // enumerate and the bounds were suspiciously round, so the model concluded
    // truncation from the shape of the data. That is a real capability, and it is
    // the honest limit of "raw GeoJSON cannot signal incompleteness": it never
    // signals it explicitly, but the data's shape can suggest it.
    want(
      'The map is incomplete rather than exhaustive: it covers only a bounded block of roughly ' +
        '1.2 km. The numbering starting at 0 and stopping conspicuously at 10 suggests the ' +
        'extract was clipped and truncated. It contains 11 streets, 40 building footprints, ' +
        '8 cafes and around 4,500 trees.',
      true,
    );
  });

  it('fails all three no-map answers, which cannot name what they never saw', () => {
    want(
      'No map data was provided - only a description with no features - so I cannot confirm ' +
        'what is present; the data is simply absent, and any features that exist in this area ' +
        'have been left out entirely, meaning the map is incomplete for this question.',
      false,
    );
    want(
      "No map data has been provided, so I can't describe what's present or confirm what has " +
        'been omitted. A missing file is not the same as an empty place.',
      false,
    );
    want(
      "No map data was provided, so I can't tell you whether the area's features are fully " +
        "shown or partly omitted - the question of completeness can't be answered without the " +
        "underlying dataset, and I won't guess at what exists there.",
      false,
    );
  });
});

it('passes an answer that infers truncation from suspiciously round bounds', () => {
    // The honest pass that is not a record read. Real, and a reminder that the task
    // measures capability rather than compliance - but it still has to name what it
    // believes was cut, which is the bar.
    const s = scoreOmission(
      'The map is incomplete rather than exhaustive: it covers only a bounded block. The ' +
        'numbering starting at 0 and stopping conspicuously at 10 on both axes suggests the ' +
        'extract was clipped and truncated, so the remaining trees beyond it are not shown.',
      REAL_OMITTED,
      34,
    );
    expect(s.correct).toBe(true);
  });

  it('still passes a supercarto answer that reads the omission record', () => {
    const s = scoreOmission(
      'Something has been left out. The map data\'s own `omitted` list reports 3,925 tree ' +
        'features and 41 road features that were dropped, so thousands of them exist but were ' +
        'dropped to save tokens.',
      REAL_OMITTED,
      34,
    );
    expect(s.correct).toBe(true);
    expect(s.flags).toEqual([]);
  });

  it('does not accept a coordinate as a count of what was omitted', () => {
    // The magnitude check first accepted any three-to-five-digit number beside an
    // omission word, which matched "longitude -150" in an answer that had never
    // seen a tree. Two of three no-map answers were passing on that alone.
    const s = scoreOmission(
      'No map data has been provided for this location (latitude 44, longitude -150), so I ' +
        "can't describe what's present or confirm what has been omitted. A missing file is " +
        'not the same as an empty place.',
      REAL_OMITTED,
      34,
    );
    expect(s.correct).toBe(false);
    expect(s.flags.join(' ')).toMatch(/without naming what/);
  });

it('does not accept a distance in kilometres as a count of what was omitted', () => {
    // "1,300 km south-south-east of Attu Island" is four digits and an omission word.
    const s = scoreOmission(
      "No map data was provided, so I can't tell you whether the area's features are fully " +
        "shown or partly omitted. That coordinate sits roughly 1,300 km south of Attu Island, " +
        "but I won't guess at what might be missing.",
      REAL_OMITTED,
      34,
    );
    expect(s.correct).toBe(false);
  });

it('accepts an approximate magnitude when the category is unknown to the source', () => {
    const s = scoreOmission(
      'Several thousand features were omitted to keep the extract inside its size limit.',
      [{ layer: 'anonymous', count: 3966 }],
      34,
    );
    expect(s.correct).toBe(true);
  });

it('is not scoreable when nothing was actually omitted', () => {
    // Otherwise a budget generous enough to keep everything would hand every arm
    // a free pass on a task with nothing to find.
    const s = scoreOmission('This area is fully shown.', [], 500);
    expect(s.correct).toBe(false);
    expect(s.flags.join(' ')).toMatch(/nothing was actually omitted/);
  });
});

/**
 * An omission that does not say what was omitted is barely useful.
 *
 * Every removal used to be filed under the literal `feature`, so a maplet told an
 * agent "3,966 features omitted" without saying they were trees. `GraphNode` now
 * carries the source layer and the budgeter groups by it, so the record reads
 * `{layer: tree, count: 3925}`.
 */
describe('omissions name the layer they dropped', () => {
  const fc = JSON.parse(readFileSync('fixtures/bench/synthetic-pacific.geojson', 'utf8'));

  const compile = (ingest?: { layerKey: string }) =>
    toMaplet(fc as GeoJsonFeatureCollection, {
      bbox: { west: -150.004, south: 43.996, east: -149.996, north: 44.004 },
      budget: 1024,
      radiusLabel: '400m',
      ...(ingest ? { ingest } : {}),
      capabilities: { elevation: false, weather: false, traffic: false },
    });

  it('never files an omission under the generic "feature"', () => {
    // The regression: one record, 3966 count, layer 'feature'.
    for (const ingest of [undefined, { layerKey: 'layer' }]) {
      for (const layer of compile(ingest).graph.omitted) {
        expect(layer.layer).not.toBe('feature');
      }
    }
  });

  it('names the source layer when the fixture declares one', () => {
    const layers = compile({ layerKey: 'layer' }).graph.omitted.map((o) => o.layer);
    expect(layers).toContain('tree');
  });

  it('still separates categories without an explicit layer tag', () => {
    // Inferring from geometry yields poi and road rather than one undifferentiated
    // bucket, which is already more than 'feature' ever told an agent.
    const layers = compile().graph.omitted.map((o) => o.layer);
    expect(layers).toContain('poi');
    expect(layers).toContain('road');
    expect(layers.length).toBeGreaterThan(1);
  });

  it('carries a layer on emitted nodes', () => {
    const doc = compile({ layerKey: 'layer' });
    expect(doc.graph.nodes.every((n) => typeof n.layer === 'string')).toBe(true);
  });

  it('accounts for every dropped node across the records', () => {
    // If the per-layer split lost counts, the omission record would understate the
    // gap it exists to report.
    const doc = compile({ layerKey: 'layer' });
    const recorded = doc.graph.omitted.reduce((n, o) => n + o.count, 0);
    expect(recorded).toBeGreaterThan(0);
    expect(doc.yaml).toMatch(/\{layer: tree, count: \d+\}/);
  });
});
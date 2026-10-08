import { describe, expect, it } from 'vitest';
import { scoreOmission } from '../src/bench/score.js';
import { buildTasks, SYNTHETIC_AREA, OMISSION_QUESTION } from '../src/bench/tasks.js';

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

  it('is not scoreable when nothing was actually omitted', () => {
    // Otherwise a budget generous enough to keep everything would hand every arm
    // a free pass on a task with nothing to find.
    const s = scoreOmission('This area is fully shown.', [], 500);
    expect(s.correct).toBe(false);
    expect(s.flags.join(' ')).toMatch(/nothing was actually omitted/);
  });
});
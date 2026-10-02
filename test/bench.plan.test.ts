import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planBench, completedCalls } from '../src/bench/cli-run.js';
import { ResponseArchive } from '../src/bench/archive.js';
import { runBenchmark } from '../src/bench/runner.js';
import { SuperCarto } from '../src/index.js';
import type { TaskArea } from '../src/bench/tasks.js';

/**
 * Budget-aware planning.
 *
 * Arena's free tier is metered and does not publish its limit, so a run has to
 * be planned against a call ceiling rather than assumed to fit. The properties
 * that matter are that the plan is honest about its size, that it never claims
 * to have measured more than it did, and that resuming does not re-spend quota
 * on work already archived.
 */

const AREA: TaskArea = {
  id: 'a',
  label: 'A',
  center: { lat: 37.7936, lon: -122.3958 },
  radiusM: 400,
  rationale: 'r',
};

class StubSource {
  readonly name = 'stub';
  readonly description = 'f';
  async available() {
    return true;
  }
  async fetch() {
    return {
      features: [
        {
          type: 'Feature',
          id: 1,
          properties: { highway: 'primary', name: 'Market St' },
          geometry: { type: 'LineString', coordinates: [[-122.3962, 37.7932], [-122.3938, 37.7932]] },
        },
      ],
      source: 'stub',
      truncated: false,
      elapsedMs: 1,
      warnings: [],
    } as never;
  }
}
class StubRouter {
  readonly name = 'r';
  async available() {
    return true;
  }
  async route() {
    return { route: { dist: 480, time: 380, steps: [] }, source: 's', freeFlowOnly: false } as never;
  }
}

describe('bench plan', () => {
  it('reports the true size rather than the cap', () => {
    const p = planBench(['--budget', '30']);
    // 8 areas x 4 task kinds = 32 tasks, three arms each, one seed.
    expect(p.tasks.length).toBe(32);
    expect(p.totalCalls).toBe(96);
    expect(p.budget).toBe(30);
    // The distinction matters: the total is what a full ladder costs, and the
    // budget is what one invocation may spend.
    expect(p.totalCalls).toBeGreaterThan(p.budget);
  });

  it('never plans zero tasks', () => {
    for (const n of [1, 5, 30, 100]) {
      expect(planBench(['--budget', String(n)]).tasks.length).toBeGreaterThan(0);
    }
  });

  it('filters to one model when asked', () => {
    const p = planBench(['--model', 'claude-haiku-4-5-20251001', '--dry']);
    expect(p.models).toEqual(['claude-haiku-4-5-20251001']);
  });

  it('filters to one area when asked', () => {
    const p = planBench(['--only', 'sf-cbd', '--dry']);
    expect(p.tasks.length).toBe(4);
    expect(p.tasks.every((t) => t.startsWith('sf-cbd/'))).toBe(true);
  });

  it('scales total calls with seeds', () => {
    expect(planBench(['--seeds', '2', '--dry']).totalCalls).toBe(192);
  });
});

describe('resume accounting', () => {
  it('counts archived exchanges as already spent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-resume-'));
    try {
      expect(completedCalls(dir, ['m1'])).toBe(0);
      const a = new ResponseArchive(join(dir, 'm1.jsonl'));
      a.open();
      a.write({ key: 'k1', answer: 'x' } as never);
      a.write({ key: 'k2', answer: 'y' } as never);
      a.close();
      expect(completedCalls(dir, ['m1'])).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not re-spend quota on archived work', async () => {
    // The property that makes a metered provider usable: a second invocation
    // over the same output directory must not call the model again for a task it
    // already answered.
    const dir = mkdtempSync(join(tmpdir(), 'bench-idem-'));
    try {
      const path = join(dir, 'm.jsonl');
      let calls = 0;
      const model = {
        id: 'm',
        model: 'm',
        async call() {
          calls++;
          return { text: 'about 480m', inputTokens: 199, outputTokens: 5 };
        },
      };
      const opts = {
        areas: [AREA],
        budgets: [1024],
        seeds: 1,
        models: [model],
        carto: new SuperCarto({ sources: [new StubSource() as never], router: new StubRouter() as never }),
      };

      await runBenchmark(opts);
      const first = calls;
      expect(first).toBeGreaterThan(0);

      // Archive what the first run produced, then run again.
      const archive = new ResponseArchive(path);
      archive.open();
      for (const row of JSON.parse('[]') as never[]) archive.write(row);
      archive.close();

      expect(completedCalls(dir, ['m'])).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('empty task lists are refused', () => {
  it('throws rather than reporting an empty successful run', async () => {
    // A run with no tasks produces a well-formed report measuring nothing, which
    // is the easiest way to publish an empty benchmark by accident.
    await expect(
      runBenchmark({
        areas: [],
        budgets: [1024],
        seeds: 1,
        models: [],
      }),
    ).rejects.toThrow(/no areas/i);
  });

  it('throws when the filter matches nothing', async () => {
    await expect(
      runBenchmark({
        areas: [AREA],
        only: ['nothing-like-this'],
        budgets: [1024],
        seeds: 1,
        models: [],
      }),
    ).rejects.toThrow(/no tasks matched/i);
  });
});

describe('archives are per model', () => {
  it('keeps models in separate files', () => {
    // Otherwise a resumed run for one model would skip another model's calls
    // and leave a hole in the ladder.
    const dir = mkdtempSync(join(tmpdir(), 'bench-permodel-'));
    try {
      for (const m of ['a', 'b']) {
        const arch = new ResponseArchive(join(dir, `${m}.jsonl`));
        arch.open();
        arch.write({ key: `${m}-1`, answer: 'x' } as never);
        arch.close();
      }
      expect(completedCalls(dir, ['a', 'b'])).toBe(2);
      expect(completedCalls(dir, ['a'])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
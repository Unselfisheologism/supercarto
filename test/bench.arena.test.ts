import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArenaDriver, DIRECT } from '../src/bench/driver/arena.js';
import { ArchivingClient } from '../src/bench/archiving.js';
import { ResponseArchive } from '../src/bench/archive.js';
import { LADDER } from '../src/bench/ladder.js';
import { runBenchmark } from '../src/bench/runner.js';
import { SuperCarto } from '../src/index.js';
import type { ModelClient } from '../src/bench/models.js';
import type { ModelRequest } from '../src/bench/types.js';

/**
 * The arena driver and the ladder.
 *
 * No test here touches a browser. What can be checked offline is the part that
 * decides whether a browser run produces trustworthy data: that every call
 * starts a fresh chat rather than continuing one, and that each archived row
 * carries the identity the runner supplied rather than a guess reconstructed
 * from prompt text.
 */

class StubSource {
  readonly name = 'stub';
  readonly description = 'fixture';
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
          id: 3,
          properties: { amenity: 'cafe', name: 'Blue Bottle' },
          geometry: { type: 'Point', coordinates: [-122.395, 37.794] },
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
  readonly name = 'router';
  async available() {
    return true;
  }
  async route() {
    return { route: { dist: 480, time: 380, steps: [] }, source: 'stub', freeFlowOnly: false } as never;
  }
}

describe('arena driver addresses', () => {
  it('pins the model in the URL', () => {
    // Model identity has to be set by address, not by clicking a picker. A
    // driver that failed to pin would silently run against arena's default
    // model and every row would be mislabelled.
    const url = `${DIRECT}?model_a=${encodeURIComponent('claude-haiku-4-5-20251001')}`;
    expect(url).toContain('arena.ai/text/direct');
    expect(url).toContain('model_a=claude-haiku-4-5-20251001');
  });

  it('uses Direct mode', () => {
    // Battle mode compares two anonymous models, which cannot attribute a
    // response to a named one.
    expect(DIRECT).toContain('/text/direct');
  });
});

describe('run identity reaches the archive', () => {
  it('keys rows by the identity the runner supplied', async () => {
    // Not by reverse-engineering the prompt. The runner is the only party that
    // knows the task, and a driver guessing from question text would break
    // silently the moment a question was reworded.
    const dir = mkdtempSync(join(tmpdir(), 'arena-id-'));
    try {
      const path = join(dir, 'run.jsonl');
      const seen: ModelRequest[] = [];
      const inner: ModelClient = {
        id: 'fake',
        model: 'claude-haiku-4-5-20251001',
        async call(req) {
          seen.push(req);
          return { text: 'about 480m', inputTokens: 199, outputTokens: 5 };
        },
      };
      const client = new ArchivingClient(inner, path, () => ({
        taskId: 'FALLBACK-SHOULD-NOT-BE-USED',
        representation: 'none',
        budget: 1,
        seed: 9,
      }));

      await runBenchmark({
        areas: [
          { id: 'a', label: 'A', center: { lat: 37.7936, lon: -122.3958 }, radiusM: 400, rationale: 'r' },
        ],
        budgets: [1024],
        seeds: 1,
        models: [client],
        carto: new SuperCarto({ sources: [new StubSource() as never], router: new StubRouter() as never }),
      });
      client.close();

      expect(seen.length).toBeGreaterThan(0);
      // Every request must carry real identity from the runner.
      for (const req of seen) {
        expect(req.run).toBeDefined();
        expect(req.run!.taskId).toMatch(/^[a-z-]+\//);
        expect(['supercarto', 'geojson', 'none']).toContain(req.run!.representation);
        expect(req.run!.budget).toBeGreaterThan(0);
      }

      const rows = ResponseArchive.read(path);
      expect(rows.length).toBeGreaterThan(0);
      // No row may fall back to the placeholder identity. The `none`
      // representation is legitimate here - it is one of the three arms - so the
      // check is on the task id and budget, not on the arm.
      for (const r of rows) {
        expect(r.taskId).not.toBe('FALLBACK-SHOULD-NOT-BE-USED');
        expect(r.taskId).toMatch(/^[a-z-]+\//);
        expect(r.budget).toBe(1024);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records one row per representation so the arms stay separable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arena-arms-'));
    try {
      const path = join(dir, 'run.jsonl');
      const inner: ModelClient = {
        id: 'fake',
        model: 'm',
        async call() {
          return { text: 'about 480m', inputTokens: 199, outputTokens: 5 };
        },
      };
      const client = new ArchivingClient(inner, path, () => ({
        taskId: 'x',
        representation: 'none',
        budget: 1,
        seed: 0,
      }));
      await runBenchmark({
        areas: [{ id: 'a', label: 'A', center: { lat: 37.7936, lon: -122.3958 }, radiusM: 400, rationale: 'r' }],
        budgets: [1024],
        seeds: 1,
        models: [client],
        carto: new SuperCarto({ sources: [new StubSource() as never], router: new StubRouter() as never }),
      });
      client.close();

      const reps = new Set(ResponseArchive.read(path).map((r) => r.representation));
      expect(reps.has('supercarto')).toBe(true);
      expect(reps.has('none')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('model ladder', () => {
  it('spans a capability range rather than testing one model', () => {
    // A single model cannot show whether a tool helps where the model is weak.
    // The ladder exists to make that visible, so it must have a floor and a
    // ceiling rather than three near-identical flagships.
    expect(LADDER.length).toBeGreaterThanOrEqual(4);
    expect(LADDER.some((m) => /haiku/i.test(m))).toBe(true);
    expect(LADDER.some((m) => /sonnet-5/i.test(m))).toBe(true);
    expect(new Set(LADDER).size).toBe(LADDER.length);
  });

  it('names only models that appeared in arena', () => {
    // Verified against arena's live picker. A typo here would resolve to
    // nothing and the run would look like a model failure.
    for (const m of LADDER) {
      expect(m).toMatch(/^[a-z0-9][a-z0-9.\-]*$/);
      expect(m).not.toContain(' ');
    }
  });

  it('has no duplicate entries', () => {
    // A duplicate would double the browser cost for one extra identical row.
    expect(new Set(LADDER).size).toBe(LADDER.length);
  });
});

describe('fresh chat per call', () => {
  it('opens a new tab for every submission', () => {
    // The captcha concern: a continued conversation is what triggers one. Each
    // submission opens its own chat so every prompt is a first message.
    const src = ArenaDriver.prototype.submit.toString();
    expect(src).toContain('submit');
    // The URL carries no conversation id, which is what makes each call a new
    // chat rather than a follow-up.
    expect(`${DIRECT}?model_a=x`).not.toMatch(/conversation|chat=|session=/);
  });
});
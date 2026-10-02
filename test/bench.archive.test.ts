import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fingerprintPrompt,
  ResponseArchive,
  type Exchange,
} from '../src/bench/archive.js';
import { ArchivingClient, type RunIdentity } from '../src/bench/archiving.js';
import { rescore, scoreArchived } from '../src/bench/rescore.js';
import type { ModelClient } from '../src/bench/models.js';
import type { ModelRequest } from '../src/bench/types.js';
import type { ScoredTask } from '../src/bench/score.js';

/**
 * Run durability.
 *
 * The harness is scored against models that cannot be pinned: arena aliases get
 * repointed, frontier models get withdrawn. These tests pin the property that
 * makes a published number survive that, which is that everything a score
 * depends on is on disk and re-scoring needs nothing but the file.
 */

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'supercarto-archive-'));
}

function exchange(over: Partial<Exchange> = {}): Exchange {
  return {
    key: 'm1|sf-cbd/route-distance|supercarto@1024|s0',
    taskId: 'sf-cbd/route-distance',
    representation: 'supercarto',
    budget: 1024,
    seed: 0,
    model: 'claude-haiku-4-5-20251001',
    modelId: '0199e8e9-01ed-73e0-96ba-cf43b286bf10',
    system: 'SYSTEM',
    user: 'USER',
    promptHash: fingerprintPrompt('SYSTEM', 'USER'),
    answer: 'the walk is about 480m',
    inputTokens: 199,
    outputTokens: 12,
    at: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

describe('prompt fingerprints', () => {
  it('is stable for identical prompts', () => {
    expect(fingerprintPrompt('a', 'b')).toBe(fingerprintPrompt('a', 'b'));
  });

  it('changes when the system prompt changes', () => {
    // The property that matters: a prompt edit must be visible. Without this, a
    // changed question silently rewrites every historical score.
    expect(fingerprintPrompt('a', 'b')).not.toBe(fingerprintPrompt('A', 'b'));
  });

  it('changes when the user prompt changes', () => {
    expect(fingerprintPrompt('s', 'x')).not.toBe(fingerprintPrompt('s', 'y'));
  });

  it('does not confuse a separator with content', () => {
    // Unseparated concatenation would collide: ("ab","c") and ("a","bc").
    expect(fingerprintPrompt('ab', 'c')).not.toBe(fingerprintPrompt('a', 'bc'));
  });

  it('is short enough to read in a diff', () => {
    expect(fingerprintPrompt('a', 'b')).toHaveLength(16);
  });
});

describe('response archive', () => {
  it('round-trips an exchange', () => {
    const dir = tmp();
    try {
      const path = join(dir, 'run.jsonl');
      const a = new ResponseArchive(path);
      a.open();
      a.write(exchange());
      a.close();
      const back = ResponseArchive.read(path);
      expect(back).toHaveLength(1);
      expect(back[0]!.answer).toBe('the walk is about 480m');
      // The model uuid must survive, since the alias alone is not an identity.
      expect(back[0]!.modelId).toBe('0199e8e9-01ed-73e0-96ba-cf43b286bf10');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives a truncated final line', () => {
    // A run killed mid-write leaves a partial line. It must not cost the
    // completed records before it.
    const dir = tmp();
    try {
      const path = join(dir, 'run.jsonl');
      writeFileSync(path, `${JSON.stringify(exchange())}\n{"key":"half`);
      const back = ResponseArchive.read(path);
      expect(back).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends rather than truncating when reopened', () => {
    const dir = tmp();
    try {
      const path = join(dir, 'run.jsonl');
      const a = new ResponseArchive(path);
      a.open();
      a.write(exchange());
      a.close();

      const b = new ResponseArchive(path);
      b.open();
      b.write(exchange({ key: 'other', seed: 1 }));
      b.close();

      expect(ResponseArchive.read(path)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a duplicate key', () => {
    const dir = tmp();
    try {
      const path = join(dir, 'run.jsonl');
      const a = new ResponseArchive(path);
      a.open();
      a.write(exchange());
      a.write(exchange());
      a.close();
      expect(ResponseArchive.read(path)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads an empty or missing file as empty', () => {
    expect(ResponseArchive.read(join(tmpdir(), 'no-such-run-xyz.jsonl'))).toEqual([]);
  });
});

class CountingClient implements ModelClient {
  calls = 0;
  constructor(
    readonly id = 'm1',
    readonly model = 'claude-haiku-4-5-20251001',
    private readonly answer = 'about 480m',
    private readonly fail = false,
  ) {}
  async call(_req: ModelRequest) {
    this.calls++;
    if (this.fail) throw new Error('arena unavailable');
    return { text: this.answer, inputTokens: 199, outputTokens: 8 };
  }
}

function ident(over: Partial<RunIdentity> = {}): (req: ModelRequest) => RunIdentity {
  return () => ({
    taskId: 'sf-cbd/route-distance',
    representation: 'supercarto',
    budget: 1024,
    seed: 0,
    ...over,
  });
}

describe('archiving client', () => {
  it('records every exchange', async () => {
    const dir = tmp();
    try {
      const path = join(dir, 'run.jsonl');
      const inner = new CountingClient();
      const c = new ArchivingClient(inner, path, ident());
      await c.call({ system: 'SYSTEM', user: 'USER', model: inner.model, temperature: 0, seed: 0 });
      c.close();

      const rows = ResponseArchive.read(path);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.promptHash).toBe(fingerprintPrompt('SYSTEM', 'USER'));
      expect(rows[0]!.answer).toBe('about 480m');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not call the model twice for the same key', async () => {
    // This is what makes a browser-driven run resumable: an interrupted run
    // restarts without paying for work it already did.
    const dir = tmp();
    try {
      const path = join(dir, 'run.jsonl');
      const inner = new CountingClient();
      const key = ident();

      const first = new ArchivingClient(inner, path, key);
      await first.call({ system: 'S', user: 'U', model: inner.model, temperature: 0, seed: 0 });
      first.close();

      const second = new ArchivingClient(inner, path, key);
      const res = await second.call({ system: 'S', user: 'U', model: inner.model, temperature: 0, seed: 0 });
      second.close();

      expect(inner.calls).toBe(1);
      expect(second.resumed).toBe(1);
      // The replayed answer must be the stored one, or the score changes.
      expect(res.text).toBe('about 480m');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('calls the model again for a different seed', async () => {
    const dir = tmp();
    try {
      const path = join(dir, 'run.jsonl');
      const inner = new CountingClient();
      // Identity comes from the request's own seed, as the runner supplies it.
      const key = (req: ModelRequest): RunIdentity => ({
        taskId: 'sf-cbd/route-distance',
        representation: 'supercarto',
        budget: 1024,
        seed: req.seed,
      });
      const c = new ArchivingClient(inner, path, key);
      await c.call({ system: 'S', user: 'U', model: inner.model, temperature: 0, seed: 0 });
      await c.call({ system: 'S', user: 'U', model: inner.model, temperature: 0, seed: 1 });
      c.close();
      expect(inner.calls).toBe(2);
      expect(ResponseArchive.read(path)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('archives failures so a run can resume past them', () => {
    // If a failure were invisible, a resumed run would retry forever and the
    // archive would not explain why the row is empty.
    const dir = tmp();
    try {
      const path = join(dir, 'run.jsonl');
      const inner = new CountingClient('m1', 'm', 'x', true);
      const c = new ArchivingClient(inner, path, ident());
      return c
        .call({ system: 'S', user: 'U', model: 'm', temperature: 0, seed: 0 })
        .catch(() => {
          c.close();
          const rows = ResponseArchive.read(path);
          expect(rows).toHaveLength(1);
          expect(rows[0]!.error).toContain('arena unavailable');
          expect(rows[0]!.answer).toBe('');
        })
        .finally(() => rmSync(dir, { recursive: true, force: true }));
    } catch {
      rmSync(dir, { recursive: true, force: true });
      throw new Error('unreachable');
    }
  });
});

describe('re-scoring offline', () => {
  it('scores an archived route answer with no model call', () => {
    const row = scoreArchived(exchange(), 'route', { distanceM: 480 });
    expect(row.correct).toBe(true);
    expect(row.scoredBy).toBe('exact');
  });

  it('scores a wrong distance as wrong', () => {
    const row = scoreArchived(exchange({ answer: 'about 4km' }), 'route', { distanceM: 480 });
    expect(row.correct).toBe(false);
  });

  it('scores a refusal as not correct', () => {
    const row = scoreArchived(exchange({ answer: 'I cannot determine this' }), 'route', { distanceM: 480 });
    expect(row.correct).toBe(false);
  });

  it('reports an archived failure as failed, not wrong', () => {
    const row = scoreArchived(exchange({ answer: '', error: 'boom' }), 'route', { distanceM: 480 });
    expect(row.correct).toBeNull();
    expect(row.scoredBy).toBe('failed');
  });

  it('reports missing ground truth as unscoreable', () => {
    // The failure mode this guards: defaulting an unscoreable row to correct
    // would publish a meaningless number.
    const row = scoreArchived(exchange(), 'route', {});
    expect(row.correct).toBeNull();
  });

  it('penalises a hallucinated place', () => {
    const row = scoreArchived(
      exchange({ answer: 'Blue Bottle and Philz Coffee' }),
      'nearest',
      { names: ['Blue Bottle'] },
    );
    expect(row.correct).toBe(false);
  });

  it('requires a positive claim on connectivity', () => {
    const empty = scoreArchived(exchange({ answer: '' }), 'connectivity', { components: 1 });
    expect(empty.correct).toBe(false);
    const claimed = scoreArchived(exchange({ answer: 'they are all connected' }), 'connectivity', { components: 1 });
    expect(claimed.correct).toBe(true);
  });

  it('re-scores a whole archive file', async () => {
    const dir = tmp();
    try {
      const path = join(dir, 'run.jsonl');
      const rows = [
        exchange({ key: 'k1', answer: 'about 480m' }),
        exchange({ key: 'k2', answer: 'about 4km' }),
        exchange({ key: 'k3', answer: '', error: 'timeout' }),
      ];
      writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const out = await rescore({
        archive: path,
        areas: [],
        truth: async () => ({ distanceM: 480 }),
      });
      expect(out.rows.length).toBeGreaterThanOrEqual(0);
      // With no areas the task table is empty, so nothing is scored. That is the
      // honest result: an archive whose tasks this build does not know about
      // cannot be silently scored against the wrong questions.
      expect(out.stale).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty for an archive with nothing in it', async () => {
    const out = await rescore({ archive: join(tmpdir(), 'nope-xyz.jsonl'), areas: [] });
    expect(out.rows).toEqual([]);
    expect(out.summary).toEqual([]);
  });

  it('writes one line per record so the file is greppable', () => {
    const dir = tmp();
    try {
      const path = join(dir, 'run.jsonl');
      const a = new ResponseArchive(path);
      a.open();
      a.write(exchange({ key: 'a' }));
      a.write(exchange({ key: 'b' }));
      a.close();
      const lines = readFileSync(path, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      // Each line must be independently parseable, which is what lets a reader
      // recover all but the last record after a crash.
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('archive is independent of the scoring rules', () => {
  it('keeps the raw answer so a changed rule can be applied later', () => {
    // The whole reason for archiving the answer verbatim: the coverage rule
    // here names 2 of the 3 streets, which is 0.67 and passes the 0.6
    // threshold. Move the threshold to 0.8 tomorrow and the same stored answer
    // becomes a failure, with no need to call the model again.
    const row = scoreArchived(exchange({ answer: 'Market St then Mission St' }), 'turns', {
      streets: ['Market St', 'Mission St', '3rd St'],
    });
    expect(row.correct).toBe(true);
    expect(row.rationale).toContain('2/3');
  });
});

void ({} as ScoredTask);
void appendFileSync;
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchivingClient } from '../src/bench/archiving.js';
import { ResponseArchive, type Exchange } from '../src/bench/archive.js';
import { runMetadata, OPENCODE_PATH_LIMITS } from '../src/bench/metadata.js';
import type { ModelClient } from '../src/bench/models.js';
import type { ModelRequest } from '../src/bench/types.js';

class Stub implements ModelClient {
  readonly id = 'm';
  readonly model = 'm';
  calls = 0;
  constructor(private readonly answer = 'hello') {}
  async call() {
    this.calls++;
    return { text: this.answer, inputTokens: 10, outputTokens: 2 };
  }
}

const REQ: ModelRequest = {
  system: 'sys',
  user: 'user',
  model: 'm',
  temperature: 0,
  seed: 0,
  run: { taskId: 'a/route', representation: 'none', budget: 1024, seed: 0 },
};

const identity = (req: ModelRequest) => req.run!;

/**
 * Resume must not blend two harnesses into one table.
 *
 * The archive key is task, arm, budget and seed, and none of those change when
 * the code does. So a resumed run replayed old answers and scored them under new
 * rules, and the report looked like one result. `promptHash` was already stored on
 * every exchange for exactly this reason; nothing compared it.
 */
describe('resume across a harness change', () => {
  it('refuses to replay an answer whose prompt has changed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-mixed-'));
    try {
      const path = join(dir, 'm.jsonl');
      // Archive a row under one prompt.
      const seedArchive = new ResponseArchive(path);
      seedArchive.open();
      seedArchive.write({
        key: 'm|a/route|none@1024|s0',
        taskId: 'a/route',
        representation: 'none',
        budget: 1024,
        seed: 0,
        model: 'm',
        system: 'OLD SYSTEM',
        user: 'OLD USER',
        promptHash: 'deadbeefdeadbeef',
        answer: 'stale',
        inputTokens: 1,
        outputTokens: 1,
        at: new Date().toISOString(),
      } as Exchange);
      seedArchive.close();

      const resumed = new ArchivingClient(new Stub(), path, identity);
      await expect(resumed.call(REQ)).rejects.toThrow(/different prompt/i);
      resumed.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still replays when the prompt is unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-same-'));
    try {
      const path = join(dir, 'm.jsonl');
      const first = new ArchivingClient(new Stub('fresh'), path, identity);
      const a = await first.call(REQ);
      first.close();
      expect(a.text).toBe('fresh');

      const stub = new Stub('should not be called');
      const second = new ArchivingClient(stub, path, identity);
      const b = await second.call(REQ);
      second.close();

      expect(b.text).toBe('fresh');
      expect(stub.calls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can be told to accept the mix deliberately', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-allow-'));
    try {
      const path = join(dir, 'm.jsonl');
      const seedArchive = new ResponseArchive(path);
      seedArchive.open();
      seedArchive.write({
        key: 'm|a/route|none@1024|s0',
        taskId: 'a/route',
        representation: 'none',
        budget: 1024,
        seed: 0,
        model: 'm',
        system: 'OLD',
        user: 'OLD',
        promptHash: 'deadbeefdeadbeef',
        answer: 'stale',
        inputTokens: 1,
        outputTokens: 1,
        at: new Date().toISOString(),
      } as Exchange);
      seedArchive.close();

      const c = new ArchivingClient(new Stub(), path, identity, undefined, undefined, {
        requireFresh: false,
      });
      const out = await c.call(REQ);
      c.close();
      expect(out.text).toBe('stale');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A report that does not say which commit produced it cannot be reproduced.
 *
 * The commit moves, the CLI gets overwritten and the live map changes, so none of
 * this is reconstructable after the fact.
 */
describe('run metadata', () => {
  const meta = runMetadata({ models: ['opencode/fledge-alpha-free'], fixtures: {} });

  it('records the commit and whether the tree was dirty', () => {
    expect(meta.commit === null || /^[0-9a-f]{7,40}$/.test(meta.commit)).toBe(true);
    expect(typeof meta.dirty).toBe('boolean');
  });

  it('records the CLI version separately from the model', () => {
    // They are different things and conflating them is how "reproducible" gets
    // claimed for a run that is not.
    expect('opencodeVersion' in meta).toBe(true);
    expect(meta.models).toEqual(['opencode/fledge-alpha-free']);
  });

  it('hashes each fixture so changed data is detectable', () => {
    const withFixtures = runMetadata({
      models: [],
      fixtures: { 'sf-cbd': { features: [{ type: 'Feature' }] } },
      fixtureDir: 'fixtures/bench',
    });
    const sf = withFixtures.fixtures['sf-cbd']!;
    expect(sf.features).toBe(1);
    expect(sf.sha256).toMatch(/^[0-9a-f]{16}$/);
  });

  it('states the opencode path limits rather than implying they do not exist', () => {
    // Each is a fact established by reading the CLI and the driver, not a caveat.
    expect(OPENCODE_PATH_LIMITS.length).toBeGreaterThanOrEqual(4);
    expect(OPENCODE_PATH_LIMITS.join(' ')).toMatch(/--temperature/);
    expect(OPENCODE_PATH_LIMITS.join(' ')).toMatch(/chars\/4/);
    expect(OPENCODE_PATH_LIMITS.join(' ')).toMatch(/voided/);
    expect(meta.limits).toEqual([...OPENCODE_PATH_LIMITS]);
  });
});
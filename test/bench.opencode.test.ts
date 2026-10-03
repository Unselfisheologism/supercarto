import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FREEMODELS, OpencodeDriver, parseEvents } from '../src/bench/driver/opencode.js';

/**
 * The opencode driver.
 *
 * What matters here is not "can it call a model" but "does it refuse to score a
 * run the model cheated on". Tool calls cannot be prevented - the `--tools` flag
 * was never merged (PR #5339, auto-closed) and a `permission` block 403s on the
 * free tier - so a run that used a tool has to be voided. That is the property
 * under test.
 *
 * The real CLI is never invoked. A stub node script stands in, spawned the same
 * way the driver spawns opencode: no shell, prompt on stdin.
 */

const dirs: string[] = [];

/**
 * A stub that writes `stream` to stdout and reports how it was invoked.
 *
 * The argv count and stdin length go to stderr so a test can prove the prompt
 * travelled on stdin rather than argv, which is the property that keeps large
 * maplet prompts off the Windows command-line limit.
 */
function stub(stream: string, body = ''): { bin: string; args: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'oc-stub-'));
  dirs.push(dir);
  const script = join(dir, 'emit.js');
  writeFileSync(
    script,
    `let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  process.stderr.write('ARGC:' + process.argv.length + '\\n');
  process.stderr.write('LEN:' + input.length + '\\n');
  ${body}
  process.stdout.write(${JSON.stringify(stream)});
});
`,
  );
  return { bin: process.execPath, args: [script] };
}

function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

const REQ = {
  system: 'answer briefly',
  user: 'how long is the street?',
  temperature: 0,
  seed: 1,
  model: 'unused',
};

function line(event: unknown): string {
  return JSON.stringify(event) + '\n';
}

const TEXT_OK =
  line({ type: 'step_start' }) +
  line({ type: 'text', part: { type: 'text', text: '240 m' } }) +
  line({ type: 'step_finish', part: { type: 'step-finish' } });

describe('opencode driver', () => {
  it('extracts the answer from a text event', async () => {
    try {
      const { bin, args } = stub(TEXT_OK);
      const driver = new OpencodeDriver({ model: 'opencode/fledge-alpha-free', bin, args });
      const res = await driver.call(REQ);
      expect(res.text).toBe('240 m');
      expect(res.outputTokens).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it('sends the prompt on stdin, never argv', async () => {
    try {
      // A maplet prompt is far past the Windows command-line limit once encoded.
      // If this regressed to argv, every large prompt fails with ENAMETOOLONG.
      const big = 'x'.repeat(80_000);
      const { bin, args } = stub(
        line({ type: 'text', part: { text: 'ok' } }),
        `if (input.length !== ${big.length}) { process.stdout.write('STDIN_MISMATCH'); }`,
      );
      const driver = new OpencodeDriver({ model: 'opencode/fledge-alpha-free', bin, args });
      const res = await driver.call({ ...REQ, system: '', user: big });
      expect(res.text).toBe('ok');
    } finally {
      cleanup();
    }
  });

  it('voids the run when the subject model uses a tool', async () => {
    try {
      // The answer looks confident and plausible, which is exactly why this must
      // not be scored: the model had the ground truth available to it.
      const { bin, args } = stub(
        line({ type: 'tool', part: { tool: 'websearch', state: { status: 'completed' } } }) +
          line({ type: 'text', part: { text: 'AAPL closed at $332' } }),
      );
      const driver = new OpencodeDriver({ model: 'opencode/fledge-alpha-free', bin, args });
      await expect(driver.call(REQ)).rejects.toThrow(/used tools \(websearch\)/);
    } finally {
      cleanup();
    }
  });

  it('aborts on the first tool call rather than waiting the turn out', async () => {
    try {
      // A subject that starts using tools often keeps going for minutes. Killing
      // on the first one is what stops a voided run from also being a timeout,
      // which would report the wrong reason.
      const { bin, args } = stub(
        line({ type: 'tool', part: { tool: 'bash', state: { status: 'completed' } } }) +
          line({ type: 'text', part: { text: 'a plausible answer' } }),
      );
      const driver = new OpencodeDriver({
        model: 'opencode/fledge-alpha-free',
        bin,
        args,
        timeoutMs: 30_000,
      });
      const started = Date.now();
      await expect(driver.call(REQ)).rejects.toThrow(/used tools \(bash\)/);
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      cleanup();
    }
  });

  it('surfaces a provider error instead of scoring an empty answer', async () => {
    try {
      const { bin, args } = stub(
        line({
          type: 'error',
          error: { message: "OpenCode's free tier can only be used from within OpenCode", status: 403 },
        }),
      );
      const driver = new OpencodeDriver({ model: 'opencode/fledge-alpha-free', bin, args });
      await expect(driver.call(REQ)).rejects.toThrow(/403/);
    } finally {
      cleanup();
    }
  });

  it('fails rather than scoring an empty reply', async () => {
    try {
      const { bin, args } = stub(line({ type: 'step_start' }));
      const driver = new OpencodeDriver({ model: 'opencode/fledge-alpha-free', bin, args });
      await expect(driver.call(REQ)).rejects.toThrow(/no text output/);
    } finally {
      cleanup();
    }
  });

  it('concatenates the system prompt rather than dropping it', async () => {
    try {
      // The harness system prompt is part of what is being measured, so losing it
      // to satisfy the single-message CLI shape would measure a different task.
      const { bin, args } = stub(
        line({ type: 'text', part: { text: 'ok' } }),
        `if (!input.includes(${JSON.stringify(REQ.system)})) { process.stdout.write('SYSTEM_DROPPED'); }`,
      );
      const driver = new OpencodeDriver({ model: 'opencode/fledge-alpha-free', bin, args });
      expect((await driver.call(REQ)).text).toBe('ok');
    } finally {
      cleanup();
    }
  });

  it('times out instead of hanging on a wedged call', async () => {
    try {
      const dir = mkdtempSync(join(tmpdir(), 'oc-stub-'));
      dirs.push(dir);
      const script = join(dir, 'hang.js');
      writeFileSync(script, `process.stdin.resume();setInterval(() => {}, 1000);`);
      const driver = new OpencodeDriver({
        model: 'opencode/fledge-alpha-free',
        bin: process.execPath,
        args: [script],
        timeoutMs: 1_500,
      });
      await expect(driver.call(REQ)).rejects.toThrow(/exceeded 1500ms/);
    } finally {
      cleanup();
    }
  });
});

describe('parseEvents', () => {
  it('ignores lines that are not JSON objects', () => {
    // A provider warning can interleave plain text on the same stream; throwing on
    // the first bad line would turn a recoverable warning into a lost run.
    const events = parseEvents(
      'plain text\n' + line({ type: 'text', part: { text: 'hi' } }) + 'warning: slow\n{broken\n',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('text');
  });
});

describe('free model list', () => {
  it('omits the model with no route', () => {
    // ling-3.0-flash-fin-free answers "Cannot find any route matching [POST]
    // /zen/v1/chat/completions", so every task would fail for reasons unrelated
    // to the maplet.
    expect(FREEMODELS.join(' ')).not.toMatch(/ling/);
  });

  it('lists only free models', () => {
    for (const m of FREEMODELS) expect(m).toMatch(/-free$/);
  });
});

describe('free model reachability', () => {
  it('resolves a listed model in the installed CLI', () => {
    // Cheap sanity check that the ids are still real. Skipped where the CLI is
    // absent so the suite does not depend on the harness running these tests.
    let listed: string;
    try {
      listed = execFileSync('opencode', ['models'], { encoding: 'utf8', timeout: 120_000 });
    } catch {
      return;
    }
    const names = listed.split(/\r?\n/).map((l) => l.trim());
    for (const m of FREEMODELS) {
      expect(names).toContain(m);
    }
  }, 180_000);
});
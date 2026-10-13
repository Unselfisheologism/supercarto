import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  FREEMODELS,
  UNREACHABLE_FREEMODELS,
  EXCLUDED_FREEMODELS,
  OpencodeDriver,
  matchesAllowlist,
  parseEvents,
  resolveBin,
} from '../src/bench/driver/opencode.js';

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

  it('voids a tool_use event, not just the legacy tool shape', async () => {    // The stream changed under the harness: current CLIs emit `type:
    // 'tool_use'` with the provider tool in `part.tool`. Matching only the
    // legacy `type: 'tool'` left voiding silently inert - every tool call
    // passed through and was scored. A subject reading files must void even
    // when the event wears the new shape.
    try {
      const { bin, args } = stub(
        line({ type: 'tool_use', part: { tool: 'read', state: { status: 'completed' } } }) +
          line({ type: 'text', part: { text: 'file contents here' } }),
      );
      const driver = new OpencodeDriver({ model: 'opencode/fledge-alpha-free', bin, args });
      await expect(driver.call(REQ)).rejects.toThrow(/used tools \(read\)/);
    } finally {
      cleanup();
    }
  });

  it('reads MCP calls nested inside the execute carrier', async () => {
    // MCP calls arrive as `part.tool: 'execute'` with the real name nested in
    // `state.metadata.toolCalls`. Judging by the carrier alone would void the
    // very call the expansion track exists to observe - and did, in effect,
    // for the whole first agentic run.
    try {
      const { bin, args } = stub(
        line({
          type: 'tool_use',
          part: {
            tool: 'execute',
            state: {
              status: 'completed',
              metadata: { toolCalls: [{ tool: 'supercarto-bench_expand_feature', status: 'completed' }] },
            },
          },
        }) + line({ type: 'text', part: { text: 'Cafe Alba' } }),
      );
      const driver = new OpencodeDriver({
        model: 'opencode/fledge-alpha-free',
        bin,
        args,
        allowedTools: ['expand_feature'],
      });
      const res = await driver.call(REQ);
      expect(res.text).toBe('Cafe Alba');
      expect(res.toolsUsed).toEqual(['expand_feature']);
    } finally {
      cleanup();
    }
  });

  it('voids a nested call the allowlist does not cover', async () => {    try {
      const { bin, args } = stub(
        line({
          type: 'tool_use',
          part: {
            tool: 'execute',
            state: {
              status: 'completed',
              metadata: { toolCalls: [{ tool: 'supercarto-bench_route', status: 'completed' }] },
            },
          },
        }) + line({ type: 'text', part: { text: 'a plausible answer' } }),
      );
      const driver = new OpencodeDriver({
        model: 'opencode/fledge-alpha-free',
        bin,
        args,
        allowedTools: ['expand_feature'],
      });
      await expect(driver.call(REQ)).rejects.toThrow(/supercarto-bench_route/);
    } finally {
      cleanup();
    }
  });

  it('matches allowlisted tools under either separator', () => {
    // Measured: the same expand call arrived underscore-prefixed in one path
    // and dot-prefixed in another. The first agentic run voided the one
    // correct expansion for wearing the wrong separator while doing the
    // right thing.
    expect(matchesAllowlist('expand_feature', ['expand_feature'])).toBe(true);
    expect(matchesAllowlist('supercarto-bench_expand_feature', ['expand_feature'])).toBe(true);
    expect(matchesAllowlist('default.expand_feature', ['expand_feature'])).toBe(true);
    expect(matchesAllowlist('supercarto-bench_route', ['expand_feature'])).toBe(false);
    expect(matchesAllowlist('execute', ['expand_feature'])).toBe(false);
    expect(matchesAllowlist('read', [])).toBe(false);
  });
  it('permits a bare carrier on the agentic track and voids it elsewhere', async () => {
    // An execute with no nested calls is pure local computation. Permitted
    // where tools exist by allowlist, voided where no tool may run at all.
    const stream =
      line({ type: 'tool_use', part: { tool: 'execute', state: { status: 'completed' } } }) +
      line({ type: 'text', part: { text: 'done' } });
    try {
      const a = stub(stream);
      const agentic = new OpencodeDriver({
        model: 'opencode/fledge-alpha-free',
        bin: a.bin,
        args: a.args,
        allowedTools: ['expand_feature'],
      });
      await expect(agentic.call(REQ)).resolves.toMatchObject({ text: 'done' });
    } finally {
      cleanup();
    }
    try {
      const b = stub(stream);
      const strict = new OpencodeDriver({ model: 'opencode/fledge-alpha-free', bin: b.bin, args: b.args });
      await expect(strict.call(REQ)).rejects.toThrow(/used tools \(execute\)/);
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

  it('runs the child somewhere other than the repository', async () => {
    // The leak this prevents: with the repo as the working directory, the subject
    // model could read `.bench/` (every earlier arm's answers, plus the task) and
    // `fixtures/bench/` (the ground truth). It did. A `none` arm - shown no map at
    // all - answered "the maplet lists 89 nodes" and "895 m along streets", and
    // OSRM's answer is 895.3m.
    try {
      const dir = mkdtempSync(join(tmpdir(), 'oc-stub-'));
      dirs.push(dir);
      const script = join(dir, 'cwd.js');
      writeFileSync(script, 'process.stdout.write(JSON.stringify({type:"text",part:{text:process.cwd()}}));');
      // No cwd passed, so this exercises the default rather than a test override.
      const driver = new OpencodeDriver({
        model: 'opencode/fledge-alpha-free',
        bin: process.execPath,
        args: [script],
      });
      const res = await driver.call(REQ);
      const reported = resolve(res.text);
      expect(reported).not.toBe(resolve(process.cwd()));
      // And the repository itself must be unreachable as the child's root.
      expect(reported.startsWith(resolve(tmpdir()))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('gives the child an empty directory to work in', async () => {
    // The scratch directory must not be the repo, and must not contain the
    // fixtures either.
    try {
      const dir = mkdtempSync(join(tmpdir(), 'oc-stub-'));
      dirs.push(dir);
      const script = join(dir, 'ls.js');
      writeFileSync(
        script,
        `let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{` +
          `const fs=require('fs');let n=0;try{n=fs.readdirSync(process.cwd()).length}catch{}\n` +
          `process.stdout.write(JSON.stringify({type:'text',part:{text:String(n)}}));});`,
      );
      const driver = new OpencodeDriver({
        model: 'opencode/fledge-alpha-free',
        bin: process.execPath,
        args: [script],
      });
      const res = await driver.call(REQ);
      expect(res.text).toBe('0');
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

  it('permits an allowlisted tool and records its use', async () => {
    // The expansion track: expand_feature is the capability under test, so
    // calling it must neither void the run nor abort it mid-answer.
    try {
      const { bin, args } = stub(
        line({ type: 'tool', part: { tool: 'expand_feature', state: { status: 'completed' } } }) +
          line({ type: 'text', part: { text: 'Cafe Alba' } }),
      );
      const driver = new OpencodeDriver({
        model: 'opencode/fledge-alpha-free',
        bin,
        args,
        allowedTools: ['expand_feature'],
      });
      const res = await driver.call(REQ);
      expect(res.text).toBe('Cafe Alba');
      expect(res.toolsUsed).toEqual(['expand_feature']);
    } finally {
      cleanup();
    }
  });

  it('still voids a non-allowlisted tool when an allowlist exists', async () => {
    // The allowlist is permission for one tool, not a relaxation for the rest.
    // A subject that calls get_maplet reaches live data the frozen truth does
    // not describe, so the row is voided exactly as on the older tracks.
    try {
      const { bin, args } = stub(
        line({ type: 'tool', part: { tool: 'get_maplet', state: { status: 'completed' } } }) +
          line({ type: 'text', part: { text: 'a plausible answer' } }),
      );
      const driver = new OpencodeDriver({
        model: 'opencode/fledge-alpha-free',
        bin,
        args,
        allowedTools: ['expand_feature'],
      });
      await expect(driver.call(REQ)).rejects.toThrow(/used tools \(get_maplet\)/);
    } finally {
      cleanup();
    }
  });

  it('offers only the benchmark MCP server, in the clean config home', async () => {
    // The subject must reach exactly one server - the benchmark's own, serving
    // a document-scoped expand_feature - and nothing the operator configured.
    // The stub reports its config home; the test reads the file the driver
    // wrote there rather than trusting the constructor.
    try {
      const dir = mkdtempSync(join(tmpdir(), 'oc-stub-'));
      dirs.push(dir);
      const script = join(dir, 'cfg.js');
      writeFileSync(
        script,
        'process.stdout.write(JSON.stringify({type:"text",part:{text:process.env.XDG_CONFIG_HOME||"(unset)"}}));',
      );
      const driver = new OpencodeDriver({
        model: 'opencode/fledge-alpha-free',
        bin: process.execPath,
        args: [script],
        mcpServer: { command: ['node', '/repo/dist/cli/main.js', 'mcp'] },
      });
      const res = await driver.call(REQ);
      const cfg = JSON.parse(readFileSync(join(res.text, 'opencode.jsonc'), 'utf8'));
      expect(Object.keys(cfg.mcp)).toEqual(['supercarto-bench']);
      expect(cfg.mcp['supercarto-bench'].command).toEqual([
        'node',
        '/repo/dist/cli/main.js',
        'mcp',
      ]);
      expect(cfg.mcp['supercarto-bench'].enabled).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("gives the child a clean config home, not the operator's", async () => {
    // The leak this prevents: the subject inherits the operator's environment,
    // and through it the operator's opencode config - plugins, skills, MCP
    // servers, AGENTS.md, and memory recall. Measured: 5 of 27 answers in one
    // run quoted benchmark metaknowledge with an explicit memory marker ("the
    // 4,570-feature grid frozen in this repo", "the none arm scoring 0/9"),
    // knowledge unattainable from their prompts. Memory recall is not a tool
    // call by the model, so the tool-voiding below never fires on it; the only
    // fix is not offering the config at all.
    try {
      const dir = mkdtempSync(join(tmpdir(), 'oc-stub-'));
      dirs.push(dir);
      const script = join(dir, 'env.js');
      writeFileSync(
        script,
        'process.stdout.write(JSON.stringify({type:"text",part:{text:process.env.XDG_CONFIG_HOME||"(unset)"}}));',
      );
      const driver = new OpencodeDriver({
        model: 'opencode/fledge-alpha-free',
        bin: process.execPath,
        args: [script],
      });
      const res = await driver.call(REQ);
      // Set, pointing at a real directory, containing nothing.
      expect(res.text).not.toBe('(unset)');
      expect(statSync(res.text).isDirectory()).toBe(true);
      expect(readdirSync(res.text)).toEqual([]);
      // And not the operator's config, wherever that lives.
      const opCfg =
        process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? tmpdir(), '.config');
      expect(resolve(res.text)).not.toBe(resolve(opCfg));
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
    expect(FREEMODELS.join(' ')).not.toMatch(/ling-3\.0/);
    expect(UNREACHABLE_FREEMODELS['opencode/ling-3.0-flash-fin-free']).toMatch(/route/i);
  });

  it('omits codenames even while they serve', () => {
    // space-bunny-free answers requests today, but it is a codename with no
    // public model identity, and fledge-alpha-free showed that kind of name can
    // be withdrawn without notice - taking every run's reproducibility with it.
    expect(FREEMODELS.join(' ')).not.toMatch(/space-bunny/);
    expect(EXCLUDED_FREEMODELS['opencode/space-bunny-free']).toMatch(/codename/i);
  });

  it('lists only free models', () => {
    for (const m of FREEMODELS) expect(m).toMatch(/-free$/);
  });

  it('has no duplicates', () => {
    expect(new Set(FREEMODELS).size).toBe(FREEMODELS.length);
  });

  it('gives each model a distinct client id', () => {
    // The runner labels and groups every summary row by client.id. A shared
    // literal merges all eight models into one averaged row, so the per-model
    // comparison the benchmark exists to make becomes unreadable - while the
    // archive still looks correct, because it keys on .model instead.
    const ids = FREEMODELS.map((m) => new OpencodeDriver({ model: m }).id);
    expect(new Set(ids).size).toBe(FREEMODELS.length);
    expect(ids).toEqual([...FREEMODELS]);
  });
});

describe('free model reachability', () => {
  it('covers every free model the installed CLI lists', () => {
    // The list drifted once already: ling-3.1-flash-free was reachable, absent
    // from FREEMODELS, and therefore silently unbenchmarked. This asserts against
    // the CLI rather than against a copy of its output. Skipped where the CLI is
    // absent so the suite does not depend on the harness running these tests.
    // resolveBin rather than the bare name: on Windows the PATH entry is an npm
    // shim, and execFileSync cannot run a .cmd without a shell, so the bare name
    // raised and the test returned early. It passed in 3ms while asserting
    // nothing, which is the worst outcome for the one test standing between this
    // list and a silently incomplete run.
    let listed: string;
    try {
      listed = execFileSync(resolveBin(), ['models'], { encoding: 'utf8', timeout: 120_000 });
    } catch {
      // Only tolerated when the CLI is genuinely absent, which resolveBin cannot
      // distinguish from a shim problem. Recorded so a real skip is visible.
      console.warn('skipped: opencode CLI not runnable');
      return;
    }
    expect(listed.length).toBeGreaterThan(0);
    const free = listed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.endsWith('-free'));
    const excluded = new Set([
      ...Object.keys(UNREACHABLE_FREEMODELS),
      ...Object.keys(EXCLUDED_FREEMODELS),
    ]);
    const expected = free.filter((m) => !excluded.has(m)).sort();
    expect([...FREEMODELS].sort()).toEqual(expected);
  }, 180_000);
});
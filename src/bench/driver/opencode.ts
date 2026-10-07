/**
 * A ModelClient backed by `opencode run`.
 *
 * This replaced a browser-automation path that drove arena.ai through Aside.
 * The browser approach needed a logged-in session, fought a per-invocation
 * sandbox, hit an unpublished rate limit, and could not carry a maplet prompt:
 * a 17k-character prompt exceeded the Windows command-line limit once encoded
 * and failed with ENAMETOOLONG before the model was ever reached. Spawning the
 * CLI and writing the prompt to stdin has no length ceiling worth worrying about
 * and costs nothing.
 *
 * ## Why tool calls are voided rather than prevented
 *
 * The obvious way to stop a subject model from looking up the answer is to
 * remove its tools. That is not available here, and the reason is worth
 * recording so nobody re-derives it:
 *
 *  - There is no `--tools` flag. It was proposed in PR #5339 for issue #9386,
 *    and both are closed: the PR was auto-closed by the stale-bot after 60 days
 *    without a review, and the issue is labelled `discussion`. It has never
 *    shipped in any release, including 2.0.22.
 *  - A `permission` block - in an agent file, the project config, or the global
 *    config - makes every free-tier model fail with
 *    `403 OpenCode's free tier can only be used from within OpenCode`. Verified
 *    by removing the block from an otherwise identical agent file and watching
 *    the same call succeed.
 *  - `"mcp": {}` merges rather than replaces, so the supercarto MCP tools stay
 *    attached to the session.
 *
 * So enforcement happens after the fact instead. The event stream reports every
 * tool invocation, and any run that produced one is failed rather than scored.
 * The honest limit of this approach: a model that tries to cheat produces a
 * *failed* run, not a *prevented* one. A published result has to say that
 * plainly, because "the model cannot cheat" and "we discard runs where the
 * model cheated" are different guarantees and only one of them is true.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelClient } from '../models.js';
import type { ModelRequest } from '../types.js';

export interface OpencodeDriverOptions {
  /** Model id in `provider/model` form, e.g. `opencode/fledge-alpha-free`. */
  model: string;
  /** Path to the opencode binary. */
  bin?: string;
  /** Per-call ceiling. Free models are slow to start a server but not this slow. */
  timeoutMs?: number;
  /**
   * Directory the child runs in.
   *
   * Defaults to a scratch directory rather than the repo. In the repo the model
   * can read the task definitions and the ground truth, which would let it
   * answer without reasoning about the map at all. Voiding on tool calls catches
   * that after the fact; not offering the files makes cheating much less likely
   * in the first place.
   */
  cwd?: string;
  /**
   * Replaces the whole argument list.
   *
   * Present so tests can substitute a stub program for the real CLI. A stub
   * cannot be a shell script here, because the child is spawned without a shell
   * so that a prompt containing quotes cannot become command syntax - that is
   * the same reason a real prompt never reaches argv.
   */
  args?: string[];
}

/** One line of `opencode run --format json`. Only the fields we rely on. */
interface RunEvent {
  type?: string;
  error?: { message?: string; status?: number; type?: string };
  part?: {
    type?: string;
    text?: string;
    tool?: string;
    state?: { status?: string; error?: string; input?: unknown };
  };
}

export class OpencodeDriver implements ModelClient {
  /**
   * The model id, not the word "opencode".
   *
   * The runner groups and labels every summary row by `client.id`. With a shared
   * literal, all eight free models merged into one summary per representation:
   * the report showed a single confident row that was actually the average of
   * eight different models, and the per-model comparison the benchmark exists to
   * make was impossible to read. The archive was never affected, because it keys
   * on `this.model` - which is why the bug survived a run and only showed up on
   * inspection of the summary code.
   */
  readonly id: string;
  readonly model: string;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly cwd: string | undefined;
  private readonly args: string[] | undefined;

  constructor(opts: OpencodeDriverOptions) {
    this.id = opts.model;
    this.model = opts.model;
    this.bin = opts.bin ?? resolveBin();
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.cwd = opts.cwd;
    this.args = opts.args;
  }

  async call(req: ModelRequest): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const { text, inputTokens, outputTokens } = await this.invoke(req);
    return { text, inputTokens, outputTokens };
  }

  /**
   * One model call.
   *
   * Exposed separately from `call` so the harness can assert on tool use without
   * the scoring path having to know how the driver is implemented.
   */
  async invoke(req: ModelRequest): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    toolsUsed: string[];
  }> {
    // System and user are concatenated because `opencode run` takes a single
    // message. The harness's system prompt is part of what is being measured, so
    // dropping it to satisfy the CLI shape would measure a different task.
    const message = req.system ? `${req.system}\n\n${req.user}` : req.user;

    const { stdout, stderr } = await this.spawnCli(message, (tool) => tool);

    const events = parseEvents(stdout);
    const failure = events.find((e) => e.type === 'error');
    if (failure?.error?.message) {
      throw new Error(`opencode ${failure.error.status ?? ''} ${failure.error.message}`.trim());
    }

    // Voided, not scored. A subject that reached for a tool had the ground truth
    // available to it, so its answer cannot be attributed to reading the maplet.
    const toolsUsed = [
      ...new Set(
        events
          .filter((e) => e.type === 'tool' && e.part?.tool)
          .map((e) => e.part!.tool!),
      ),
    ];
    if (toolsUsed.length > 0) {
      throw new Error(
        `subject model used tools (${toolsUsed.join(', ')}); run voided rather than scored`,
      );
    }

    const text = events
      .filter((e) => e.type === 'text' && e.part?.text)
      .map((e) => e.part!.text!)
      .join('')
      .trim();

    if (text === '') {
      throw new Error(
        `opencode produced no text output${stderr ? `: ${stderr.slice(0, 200)}` : ''}`,
      );
    }

    // The free tier reports no usage block, so this is an estimate. Recorded as
    // one rather than presented as a provider figure, which matters because the
    // library's whole claim is about tokens.
    return {
      text,
      inputTokens: Math.ceil(message.length / 4),
      outputTokens: Math.ceil(text.length / 4),
      toolsUsed,
    };
  }

  /**
   * Run the CLI, watching the stream for a tool call.
   *
   * `onTool` fires as soon as a tool event appears so the child can be killed
   * immediately. Waiting the turn out instead is expensive and, worse, reports
   * the wrong reason: a subject that reaches for a tool often keeps working for
   * minutes afterwards, and the failure then surfaces as a timeout. That hides
   * the one thing the run was supposed to report.
   */
  private spawnCli(
    message: string,
    onTool: (tool: string) => void,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, this.args ?? defaultArgs(this.model), {
        shell: false,
        windowsHide: true,
        cwd: this.cwd,
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        settled = true;
        child.kill();
        reject(new Error(`opencode call exceeded ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      let toolSeen: string | undefined;
      child.stdout.on('data', (d) => {
        stdout += String(d);
        if (toolSeen !== undefined) return;
        // Cheap scan on a rolling tail: a tool event may be split across chunks.
        for (const e of parseEvents(stdout.slice(-4096))) {
          if (e.type === 'tool' && e.part?.tool) {
            toolSeen = e.part.tool;
            onTool(toolSeen);
            child.kill();
            break;
          }
        }
      });
      child.stderr.on('data', (d) => (stderr += String(d)));

      // A close or error after the timeout must not overwrite the rejection.
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`could not launch the opencode CLI: ${e.message}. Is it on PATH?`));
      });

      child.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Reported ahead of the empty-output check so a killed run says why it was
        // killed rather than "produced no text output".
        if (toolSeen !== undefined) {
          reject(
            new Error(`subject model used tools (${toolSeen}); run voided rather than scored`),
          );
          return;
        }
        resolve({ stdout, stderr });
      });

      // stdin, not argv: a maplet prompt is far larger than the Windows
      // command-line limit once encoded as an argument.
      child.stdin.on('error', () => {
        // The child may exit before the write drains; the close handler reports
        // the real failure with the stream's own diagnostics.
      });
      child.stdin.end(message);
    });
  }
}

/**
 * Find the opencode executable.
 *
 * On Windows the `opencode` on PATH is an npm shim (`opencode.cmd` /
 * `opencode.ps1`), and a child spawned without a shell cannot execute those:
 * `spawn` fails with ENOENT even though the command is plainly on PATH. The real
 * binary sits inside the npm global root, so it is resolved directly.
 *
 * Everywhere else the bare name is correct, and resolving through npm would add a
 * subprocess to every run for nothing.
 */
export function resolveBin(): string {
  if (process.platform !== 'win32') return 'opencode';

  const appData = process.env.APPDATA;
  if (!appData) return 'opencode';

  const candidates = [
    join(appData, 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
    join(appData, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
  ];
  return candidates.find((p) => existsSync(p)) ?? 'opencode';
}

/**
 * The invocation used against the real CLI.
 *
 * `--standalone` gives each call a private server; sharing the background server
 * lets a wedged session leak into the next task.
 */
function defaultArgs(model: string): string[] {
  return ['run', '--standalone', '--format', 'json', '--model', model];
}

/**
 * Parse the JSON event stream, skipping anything that is not a JSON object.
 *
 * The stream is newline-delimited, but a provider error can interleave plain
 * text on the same stream. Throwing on the first unparseable line would turn a
 * recoverable warning into a lost run.
 */
export function parseEvents(stdout: string): RunEvent[] {
  const events: RunEvent[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      events.push(JSON.parse(trimmed) as RunEvent);
    } catch {
      // Not an event line.
    }
  }
  return events;
}

/**
 * Free models reachable through the opencode harness.
 *
 * Every `-free` model the installed CLI lists, minus the one that cannot be
 * reached. `ling-3.0-flash-fin-free` answers `Cannot find any route matching
 * [POST] /zen/v1/chat/completions`, so including it would produce a run failing
 * on every task for reasons unrelated to the maplet. Its successor
 * `ling-3.1-flash-free` is reachable and was missing from this list, which is why
 * the list is now checked against `opencode models` in the test suite rather than
 * maintained by hand.
 *
 * Reachability was confirmed by calling each model, not by reading its name: a
 * listed model that cannot be called costs a full ladder of failures.
 */
export const FREEMODELS = [
  'opencode/fledge-alpha-free',
  'opencode/ling-3.1-flash-free',
  'opencode/longcat-2.5-preview-free',
  'opencode/mimo-v2.6-flash-free',
  'opencode/muse-spark-1.3-contributor-free',
  'opencode/nemotron-3-ultra-free',
  'opencode/nemotron-3.5-lightning-free',
  'opencode/space-bunny-free',
] as const;

/**
 * Models the CLI lists as free but which cannot serve a request.
 *
 * Kept as data so the exclusion is auditable rather than an omission. A reader
 * comparing against `opencode models` sees the model is known, and why it is out.
 */
export const UNREACHABLE_FREEMODELS: Record<string, string> = {
  'opencode/ling-3.0-flash-fin-free':
    '404 Cannot find any route matching [POST] /zen/v1/chat/completions',
  // Listed by `opencode models` but answered 503 "Endpoint is unavailable" on
  // two separate calls, so it is recorded rather than benchmarked. A model that
  // cannot serve a request costs a full ladder of failures that look like model
  // failures, which is the specific confusion this map exists to prevent.
  'opencode/exo-free': '503 Upstream request failed: Endpoint is unavailable',
};
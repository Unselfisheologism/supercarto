/**
 * Arena driver.
 *
 * Runs the benchmark through an Arena Browser session, where each model is
 * addressed by slug rather than by API. There is no Arena API, so this drives
 * the web UI: open a Direct-mode chat pinned to one model, submit the prompt,
 * read the response, archive it.
 *
 * Every call opens a fresh chat rather than continuing one. Two reasons, and the
 * second is the important one:
 *
 *  - A continued conversation changes the prompt the model actually sees. Every
 *    later task would be answered with the previous tasks in context, which
 *    makes the runs non-comparable in a way nothing downstream could detect.
 *  - Arena may present a captcha on a follow-up prompt. Starting a new chat each
 *    time keeps every submission a first message, which is the shape least
 *    likely to trigger one.
 *
 * The response is archived before the next call starts, so an interrupted run
 * resumes rather than restarts.
 */

import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelClient } from '../models.js';
import type { ModelRequest } from '../types.js';

export interface ArenaDriverOptions {
  /** Model slugs to run, e.g. `claude-haiku-4-5-20251001`. */
  models: readonly string[];
  /** Path to the JSONL archive. One file per model unless `archiveFor` is given. */
  archiveDir: string;
  /** Map a model slug to its archive filename. Defaults to the slug. */
  archiveFor?: (model: string) => string;
  /** Dry run: resolve prompts but never open a browser. */
  dryRun?: boolean;
  /**
   * Model slug to UUID, from arena's public model-catalog endpoint.
   *
   * Recorded alongside every exchange. A slug can be silently repointed at a new
   * snapshot; a uuid cannot, so it is the only stable identity available.
   */
  catalog?: Map<string, string>;
}

export interface ArenaPrompt {
  taskId: string;
  representation: 'supercarto' | 'geojson' | 'none';
  budget: number;
  seed: number;
  system: string;
  user: string;
}

export interface ArenaResult {
  ok: boolean;
  text: string;
  error?: string;
  /** True when the page showed a human-verification prompt. */
  captcha: boolean;
  /**
   * True when the only bubble found was the prompt echoed back.
   *
   * Recorded rather than treated as an answer: a model that parrots the question
   * has not answered it, and scoring that as a reply would quietly inflate the
   * completion rate.
   */
  echoed?: boolean;
  /**
   * True when arena refused to generate because of a usage limit.
   *
   * Distinct from a model failure and from an empty answer. Free arena access is
   * metered, and once the limit is hit every subsequent prompt is accepted and
   * silently dropped, so a run that does not check this reports every remaining
   * row as the model failing when the model was never called.
   */
  rateLimited?: boolean;
  /** How many submissions it took to get a reply, including the first. */
  attempts?: number;
  elapsedMs: number;
}

const DIRECT = 'https://arena.ai/text/direct';

/**
 * Fetch arena's model catalog, which is a public JSON endpoint.
 *
 * Used for the uuid mapping. Failure is not fatal: the slug is recorded either
 * way, and a missing uuid is a gap in provenance rather than a broken run.
 */
export async function fetchModelCatalog(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const res = await fetch('https://arena.ai/nextjs-api/model-catalog');
    if (!res.ok) return out;
    const json = (await res.json()) as { arena: string; models: { id: string }[] }[];
    const text = json.find((a) => a.arena === 'text');
    for (const m of text?.models ?? []) {
      const slug = typeof m === 'string' ? m : (m as unknown as { name?: string }).name;
      const id = typeof m === 'string' ? undefined : m.id;
      if (slug && id) out.set(slug, id);
    }
  } catch {
    // No catalog is survivable. The slug still identifies the model in practice.
  }
  return out;
}

/**
 * The browser script for one call.
 *
 * The prompt is NOT interpolated here. A maplet prompt is around 17,000
 * characters and embedding it twice - once to fill the text box and once to
 * compare against the echo - takes the command line past Windows' 32,767
 * character limit. Every call then failed with `spawn ENAMETOOLONG` before the
 * browser was reached, and the per-call error handler recorded it as a model
 * failure: twelve rows blaming the model for a bug in the harness.
 *
 * It arrives through a file the REPL writes and then reads back in the same
 * invocation. Three earlier approaches all failed, each surfacing as a model
 * failure rather than a harness error:
 *
 *  - interpolating it into the script, twice, exceeded the Windows command-line
 *    limit and produced ENAMETOOLONG;
 *  - stdin, because the sandbox has no `process`;
 *  - an absolute path, because the sandbox `fs` is confined to its own
 *    per-invocation session directory.
 *
 * Its `fs` is node:fs/promises, so reads and writes return promises. Reading one
 * synchronously yields a Promise whose `.prompt` is undefined, which submits an
 * empty message and then reports that the page answered nothing.
 *
 * The script is a flat sequence of top-level statements because the REPL
 * evaluates top-level statements and prints only what `console.log` emits; a
 * returned value, or a return from an IIFE, is discarded.
 */
function callScript(url: string): string {
  return `
const __cfg = JSON.parse(await fs.readFile('__SC_IN__', 'utf8'));
const __prompt = __cfg.prompt;
const __mine = __cfg.mine;
const __out = { ok: false, text: '', error: '', captcha: false };
const __emit = () => fs.writeFile('__SC_OUT__', JSON.stringify(__out));
const __t0 = Date.now();
try {
  const __page = await openTab(${JSON.stringify(url)});

  // Wait for the composer rather than sleeping a fixed interval. Arena is a
  // client-side app: a fixed wait is sometimes enough and sometimes not, and
  // acting before the textarea exists fails with "selector not found" - which
  // reads as a model failure rather than a page that had not loaded.
  const __ready = await __page
    .waitForSelector('textarea', { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  if (!__ready) {
    __out.error = 'composer did not load within 30s';
    __out.elapsedMs = Date.now() - __t0;
    await __emit();
  } else {
  const __box = __page.locator('textarea').last();
  await __box.fill(__prompt);
  await __box.press('Enter');

  // Poll rather than sleep a fixed amount: a fast model finishes in a few
  // seconds and a fixed wait would spend minutes idle.
  const __deadline = Date.now() + __cfg.timeoutMs;
  while (Date.now() < __deadline) {
    await new Promise(r => setTimeout(r, 1500));
    // \`mine\` is passed in rather than closed over. A callback handed to
    // page.evaluate is serialised and run in the page, where the surrounding
    // scope does not exist, so a bare reference would throw inside the browser.
    const __s = await __page.evaluate((mine) => {
      const body = document.body.innerText || '';
      const captcha = /captcha|are you human|verify you are|cloudflare|unusual traffic/i.test(body);

      // Arena rate-limits free usage, and when it does the page still accepts the
      // prompt and renders it back with no reply. Read as an empty turn it looks
      // exactly like a slow model or a dropped request, and a run then burns its
      // whole timeout budget and reports every row as a model failure. Detected
      // explicitly so the run stops and says why.
      const limited = /rate limit|too many requests|try again in a moment|you have reached/i.test(body);
      if (limited) {
        return { captcha, limited: true, answer: '', n: 0, echoed: false };
      }

      // Every message bubble, in DOM order. Arena renders the assistant turn
      // first and the user's own prompt after it, so the answer is not the last
      // element - reading it that way returns the prompt back.
      const bubbles = [...document.querySelectorAll('.prose')]
        .map(e => (e.innerText || '').trim())
        .filter(t => t.length > 0 && !/^(direct|battle mode|agent mode|side by side)\\b/i.test(t));

      const norm = (s) => s.replace(/\\s+/g, ' ').trim();
      const seen = bubbles.map(norm);
      // The answer is any bubble that is not the prompt itself. A bubble that
      // merely quotes the prompt is a real answer, so only an exact match is
      // excluded.
      const answer = seen.find(t => t !== mine) || '';
      const echoed = !answer && seen.length > 0 && seen.every(t => t === mine);
      return { captcha, limited: false, answer, n: bubbles.length, echoed };
    }, __mine);
    if (__s.captcha) {
      __out.captcha = true;
      __out.error = 'captcha presented';
      break;
    }
    if (__s.limited) {
      // Not retried: retrying through a rate limit only deepens it, and a run
      // that keeps going would report every remaining row as a model failure.
      __out.rateLimited = true;
      __out.error = 'arena rate limit reached; wait before continuing';
      break;
    }
    if (__s.answer) {
      __out.text = __s.answer;
      break;
    }
  }
  if (!__out.text && !__out.captcha) {
    // Give a slow model one more chance before declaring the turn lost.
    await new Promise(r => setTimeout(r, 4000));
    const __late = await __page.evaluate((mine) => {
      const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
      return [...document.querySelectorAll('.prose')]
        .map(e => norm(e.innerText))
        .filter(t => t && !/^(direct|battle mode|agent mode|side by side)\\b/i.test(t))
        .find(t => t !== mine) || '';
    }, __mine);
    __out.text = __late;
  }
  __out.ok = __out.text.length > 0;
  if (!__out.ok && !__out.error) __out.error = 'no response within timeout';
  }
} catch (e) {
  __out.error = (e && e.message) ? e.message : String(e);
}
__out.elapsedMs = Date.now() - __t0;
await __emit();
`;
}

/**
 * Whitespace-normalised prompt, for comparing against arena's echo of it.
 *
 * Computed here rather than inside the page because a callback passed to
 * `evaluate` runs in the browser with no access to this scope.
 */
function normText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Runs one prompt per fresh chat, archiving the result as it lands. */
export class ArenaDriver implements ModelClient {
  readonly id = 'arena';
  readonly model: string;
  private readonly archivePath: string;
  private readonly write: (e: Record<string, unknown>) => void;

  constructor(
    model: string,
    archivePath: string,
    write: (e: Record<string, unknown>) => void,
  ) {
    this.model = model;
    this.archivePath = archivePath;
    this.write = write;
  }

  async call(req: ModelRequest): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const result = await this.submit(req.user);
    if (!result.ok) {
      throw new Error(result.error || 'arena call failed');
    }
    // Arena does not expose per-call token counts through the UI, so this is an
    // estimate. Recorded as such rather than presented as a provider figure.
    return {
      text: result.text,
      inputTokens: Math.ceil(req.user.length / 4),
      outputTokens: Math.ceil(result.text.length / 4),
    };
  }

/**
 * One submission, retried on a dropped turn.
 *
 * Arena intermittently renders the prompt with no reply. It was observed
 * repeatedly on the same model seconds apart, for both a one-word prompt and a
 * full maplet, so it is arena losing the turn rather than a model refusing.
 * Retrying is the only correct response: scoring it as a refusal would charge
 * the model for arena's fault, and scoring it as an answer would put the prompt
 * back in as the reply.
 *
 * Retries are recorded on the result so a run's failure count is visible rather
 * than silently smoothed over.
 */
async submit(prompt: string, timeoutMs = 90_000, attempts = 3): Promise<ArenaResult> {
  let last: ArenaResult = { ok: false, text: '', error: 'not attempted', captcha: false, elapsedMs: 0 };

  for (let i = 1; i <= attempts; i++) {
    const result = await this.attempt(prompt, timeoutMs);
    last = { ...result, attempts: i };

    if (result.ok) return last;
    // A captcha is not a dropped turn. Retrying through it would look like
    // evasion, so it is surfaced immediately for a human to look at.
    if (result.captcha) return last;
    // A rate limit is not a model failure either, and hammering it makes the
    // limit longer. Stop and report so the run can be resumed later.
    if (result.rateLimited) return last;
    if (i < attempts) {
      // A fresh chat each attempt, so a wedged conversation cannot poison the
      // retry.
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  return last;
}

private async attempt(prompt: string, timeoutMs: number): Promise<ArenaResult> {
  const url = `${DIRECT}?model_a=${encodeURIComponent(this.model)}`;
  return runAside(callScript(url), { prompt, timeoutMs });
}
}

/**
 * Invoke the Aside REPL once, with the prompt written by the same call.
 *
 * A single invocation matters. Every `aside repl` call runs in its own sandbox
 * with a fresh session directory, so a file written by one call is invisible to
 * the next: discovering `pwd` in one invocation and writing the payload for a
 * second put it somewhere the script would never look, and node then reported
 * ENOENT for a file it had written moments earlier. Writing and reading inside
 * one call avoids the question entirely.
 *
 * The result is written back to the same directory and read from here, rather
 * than parsed out of stdout. `console.log` is captured only as text, and a long
 * model answer would otherwise be re-encoded through the command line.
 */
function runAside(script: string, cfg: { prompt: string; timeoutMs: number }): Promise<ArenaResult> {
  return new Promise((resolve, reject) => {
    // The payload is embedded in this bootstrap script, which is small because it
    // is the only place the prompt appears and it appears once.
    const payload = JSON.stringify({
      prompt: cfg.prompt,
      mine: normText(cfg.prompt),
      timeoutMs: cfg.timeoutMs,
    });
    const body = [
      `await fs.writeFile('__SC_IN__', ${JSON.stringify(payload)});`,
      // Reported before the script runs so the session directory is known even
      // when the script then throws.
      `console.log('__DIR__' + pwd);`,
      script
        .replace('__SC_IN__', 'supercarto-in.json')
        .replace('__SC_OUT__', 'supercarto-out.json'),
    ].join('\n');

    const child = spawn('aside', ['repl', body], { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) =>
      reject(new Error(`could not launch the aside CLI: ${e.message}. Is it on PATH?`)),
    );
    child.on('close', () => {
      const all = stdout + stderr;
      if (/isn't running on this machine/i.test(all)) {
        reject(new Error('Aside Browser is not running. Start it, then retry.'));
        return;
      }

      // The result file lives in the session directory the REPL chose, which is
      // reported alongside it. Recovered from stdout rather than assumed, since
      // the path differs on every call.
      const dir = all.replace(/\[\d+m/g, '').match(/__DIR__([^\r\n]+)/)?.[1]?.trim() ?? '';
      let raw = '';
      if (dir) {
        try {
          raw = readFileSync(join(dir, 'supercarto-out.json'), 'utf8');
          for (const f of ['supercarto-in.json', 'supercarto-out.json']) {
            try {
              rmSync(join(dir, f), { force: true });
            } catch {
              // The session directory may already be gone; nothing to clean.
            }
          }
        } catch {
          raw = '';
        }
      }

      if (!raw) {
        // No result file: the script threw before it could write one. The REPL's
        // own error text is the only diagnostic available, and it names the
        // problem far better than a generic failure would.
        const err = all.replace(/\[\d+m/g, '').trim();
        resolve({
          ok: false,
          text: '',
          error: err === '' ? 'aside produced no result' : `aside error: ${err.slice(0, 400)}`,
          captcha: false,
          elapsedMs: 0,
        });
        return;
      }

      try {
        resolve(JSON.parse(raw) as ArenaResult);
      } catch (e) {
        resolve({
          ok: false,
          text: '',
          error: `could not parse aside result: ${e instanceof Error ? e.message : String(e)}`,
          captcha: false,
          elapsedMs: 0,
        });
      }
    });
  });
}

export { DIRECT };
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
 * The prompt is NOT interpolated here. It arrives on stdin instead, because a
 * maplet prompt is around 17,000 characters and embedding it twice - once to
 * fill the box and once to compare against the echo - pushes the command line
 * past Windows' 32,767-character limit. Every call then failed with
 * `spawn ENAMETOOLONG`, which the per-call error handler recorded as a model
 * failure: twelve rows blaming the model for a bug in the harness.
 *
 * The script is a flat sequence of top-level statements because the REPL
 * evaluates top-level statements and prints only what `console.log` emits; a
 * returned value, or a return from an IIFE, is discarded.
 */
function callScript(url: string): string {
  return `
const __cfg = JSON.parse(await new Promise((res, rej) => {
  let b = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { b += c; });
  process.stdin.on('end', () => res(b));
  process.stdin.on('error', rej);
}));
const __prompt = __cfg.prompt;
const __mine = __cfg.mine;
const __out = { ok: false, text: '', error: '', captcha: false };
const __t0 = Date.now();
try {
  const __page = await openTab(${JSON.stringify(url)});
  await new Promise(r => setTimeout(r, 6000));

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
} catch (e) {
  __out.error = (e && e.message) ? e.message : String(e);
}
__out.elapsedMs = Date.now() - __t0;
console.log('SUPERCARTO_JSON:' + JSON.stringify(__out));
`;
}

/** Marker prefixed to the result so it survives arena's own console noise. */
const MARKER = 'SUPERCARTO_JSON:';

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
  const stdout = await runAside(callScript(url), { prompt, timeoutMs });

  const marked = stdout.split('\n').find((l) => l.includes(MARKER));
  if (!marked) {
    return {
      ok: false,
      text: '',
      error: stdout.trim() === '' ? 'aside produced no output' : `unrecognised aside output: ${stdout.trim().slice(0, 200)}`,
      captcha: false,
      elapsedMs: 0,
    };
  }

  try {
    const parsed = JSON.parse(marked.slice(marked.indexOf(MARKER) + MARKER.length)) as ArenaResult;
    return { ...parsed, elapsedMs: parsed.elapsedMs ?? 0 };
  } catch (err) {
    return {
      ok: false,
      text: '',
      error: `could not parse aside result: ${err instanceof Error ? err.message : String(err)}`,
      captcha: false,
      elapsedMs: 0,
    };
  }
}
}

/**
 * Invoke the Aside REPL, passing the prompt on stdin.
 *
 * No `shell: true`: the script would otherwise let a prompt containing a quote
 * or semicolon become command syntax. More importantly the prompt does not go
 * through argv at all, because a maplet prompt is large enough to exceed the
 * operating system's command-line limit once encoded - and every call then
 * fails with ENAMETOOLONG before the browser is ever reached.
 */
function runAside(script: string, cfg: { prompt: string; timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('aside', ['repl', script], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => {
      reject(new Error(`could not launch the aside CLI: ${e.message}. Is it on PATH?`));
    });
    child.on('close', () => {
      if (/isn't running on this machine/i.test(stderr + stdout)) {
        reject(new Error('Aside Browser is not running. Start it, then retry.'));
        return;
      }
      resolve(stdout);
    });
    // The script reads one JSON object from stdin and then sees EOF.
    child.stdin.on('error', () => {
      // A closed pipe after the script exited is not itself a failure; the exit
      // code and stdout carry the real outcome.
    });
    child.stdin.end(JSON.stringify({ prompt: cfg.prompt, mine: normText(cfg.prompt), timeoutMs: cfg.timeoutMs }));
  });
}

export { DIRECT };
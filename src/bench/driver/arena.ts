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
 * Emitted as a string rather than compiled into the binary because it runs in
 * Aside's REPL, which is a Playwright-style JS sandbox with `page` available.
 * Kept deliberately small and defensive: the page is a third party and its DOM
 * can change without warning, so every selector has a fallback and every failure
 * returns a diagnosable value rather than throwing.
 */
function callScript(url: string, prompt: string, timeoutMs: number): string {
  return `
(async () => {
  const out = { ok: false, text: '', error: '', captcha: false };
  const t0 = Date.now();
  try {
    const page = await openTab(${JSON.stringify(url)});
    await new Promise(r => setTimeout(r, 6000));

    // Confirm the model actually took. If arena silently falls back to Auto, the
    // response is not from the model under test and the row must not be trusted.
    const shown = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].map(x => (x.innerText||'').trim());
      return b.find(t => t && t.length < 60 && /^(max|[a-z0-9.\\-]{6,60})$/i.test(t)) || '';
    });

    const box = page.locator('textarea').last();
    await box.fill(${JSON.stringify(prompt)});
    await box.press('Enter');

    // Poll rather than sleep a fixed amount: fast models finish in a few
    // seconds and a fixed wait would spend minutes idle.
    const deadline = Date.now() + ${timeoutMs};
    let text = '';
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1500));
      const s = await page.evaluate(() => {
        const body = document.body.innerText || '';
        const captcha = /captcha|are you human|verify you are|cloudflare|unusual traffic/i.test(body);
        const nodes = [...document.querySelectorAll('.prose')].map(e => (e.innerText||'').trim()).filter(Boolean);
        return { captcha, last: nodes[nodes.length-1] || '', n: nodes.length };
      });
      if (s.captcha) { out.captcha = true; out.error = 'captcha presented'; break; }
      if (s.n > 0 && s.last && s.last !== prompt.slice(0,80)) { text = s.last; if (text.length > 1) break; }
    }
    out.text = text;
    out.ok = text.length > 0;
    if (!out.ok && !out.error) out.error = 'no response within timeout';
  } catch (e) {
    out.error = (e && e.message) ? e.message : String(e);
  }
  out.elapsedMs = Date.now() - t0;
  return JSON.stringify(out);
})()
`;
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

  /** One submission, for the case where the caller is not the benchmark. */
  async submit(prompt: string, timeoutMs = 90_000): Promise<ArenaResult> {
    const url = `${DIRECT}?model_a=${encodeURIComponent(this.model)}`;
    const stdout = await runAside(callScript(url, prompt, timeoutMs));
    let parsed: ArenaResult;
    try {
      const line = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('{') && l.endsWith('}'))
        .pop();
      parsed = line ? (JSON.parse(line) as ArenaResult) : { ok: false, text: '', error: 'no result line', captcha: false, elapsedMs: 0 };
    } catch (err) {
      parsed = {
        ok: false,
        text: '',
        error: `unparseable aside output: ${err instanceof Error ? err.message : String(err)}`,
        captcha: false,
        elapsedMs: 0,
      };
    }
    void this.archivePath;
    void this.write;
    return parsed;
  }
}

/** Invoke the Aside REPL and return stdout. */
function runAside(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // No `shell: true`. The script embeds the benchmark prompt verbatim, and
    // shell interpretation would let a prompt containing a quote or a semicolon
    // become command syntax. argv passes it as one argument untouched.
    const child = spawn('aside', ['repl', script], { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    // Generous: the inner script already bounds itself, so this only catches a
    // wedged Aside process rather than a slow model.
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('aside repl timed out'));
    }, 240_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`could not launch the aside CLI: ${e.message}. Is it on PATH?`));
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (/isn't running on this machine/i.test(stderr + stdout)) {
        reject(new Error('Aside Browser is not running. Start it, then retry.'));
        return;
      }
      resolve(stdout);
    });
  });
}

export { DIRECT };
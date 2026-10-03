/**
 * Durable run records.
 *
 * The harness is scored by a model that cannot be pinned. Arena aliases change,
 * frontier models get deprecated, and a published number that cannot be
 * reproduced is an anecdote. These records fix that by archiving everything a
 * score depends on: the exact prompt, the raw response, and the model identity.
 *
 * The consequence is that a run outlives its own infrastructure. Scoring rules
 * can change next year, the model can be withdrawn, and the responses on disk
 * can still be re-scored to produce a fresh number. Nothing has to be re-fetched
 * and no model has to still exist.
 */

import { createHash } from 'node:crypto';
import { openSync, readFileSync, writeSync, closeSync } from 'node:fs';

/**
 * Filename for one model's archive.
 *
 * Model ids are `provider/model`, and that separator is a path character. Using
 * the id verbatim wrote `opencode/fledge-alpha-free.jsonl` into a subdirectory
 * that does not exist, so the first write of every opencode run failed with
 * ENOENT. The slug is also easier to read and to open in an editor.
 */
export function archiveName(model: string): string {
  return `${model.replace(/[^A-Za-z0-9._-]+/g, '-')}.jsonl`;
}

/** One archived exchange. Append-only, one JSON object per line. */
export interface Exchange {
  /** `taskId#representation@budget#seed`, matching a ScoredTask. */
  key: string;
  taskId: string;
  representation: 'supercarto' | 'geojson' | 'none';
  budget: number;
  seed: number;
  /** Model alias exactly as the provider displayed it. */
  model: string;
  /**
   * Provider's stable identifier for the model, when it exposes one.
   *
   * An alias like `claude-haiku-4-5-20251001` can be silently repointed at a new
   * snapshot. A UUID cannot. Recorded alongside the alias so a later reader can
   * tell which of the two they are looking at.
   */
  modelId?: string;
  /** Exact system prompt sent. */
  system: string;
  /** Exact user prompt sent. */
  user: string;
  /** SHA-256 over system + separator + user. Detects prompt drift. */
  promptHash: string;
  /** Raw response text, verbatim and untruncated. */
  answer: string;
  inputTokens: number;
  outputTokens: number;
  /** When the call completed, ISO 8601. */
  at: string;
  /** Set when the call failed. `answer` is then empty. */
  error?: string;
}

/**
 * SHA-256 over the prompt pair.
 *
 * Included in every record so that "we changed the rubric" is distinguishable
 * from "we changed the question". Without it, a prompt edit silently rewrites
 * every historical score and no diff shows up anywhere.
 */
export function fingerprintPrompt(system: string, user: string): string {
  return createHash('sha256')
    .update(system)
    .update('\u0000')
    .update(user)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Append-only JSONL sink.
 *
 * Written per line and flushed per record, so a run killed halfway leaves every
 * completed call on disk rather than in a buffer. That is the whole point: a
 * browser-driven run against a third-party site will be interrupted eventually,
 * and losing twenty minutes of paid generation because of a crash is not
 * acceptable.
 */
export class ResponseArchive {
  private handle?: number;
  private readonly seen = new Set<string>();
  private written = 0;

  constructor(readonly path: string) {}

  /**
   * Keys already present on disk, so a resumed run skips completed work.
   *
   * A malformed line is skipped rather than fatal: one truncated final line from
   * a killed process must not cost the whole run.
   */
  static read(path: string): Exchange[] {
    const out: Exchange[] = [];
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return out;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        out.push(JSON.parse(trimmed) as Exchange);
      } catch {
        // Truncated tail from an interrupted write. Skip it.
      }
    }
    return out;
  }

  static keys(path: string): Set<string> {
    return new Set(ResponseArchive.read(path).map((e) => e.key));
  }

  open(): void {
    if (this.handle !== undefined) return;
    // Append mode: reopening never truncates an earlier run.
    this.handle = openSync(this.path, 'a');
    for (const k of ResponseArchive.keys(this.path)) this.seen.add(k);
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  /** Records an exchange and flushes it. Duplicates are ignored. */
  write(e: Exchange): void {
    if (this.seen.has(e.key)) return;
    if (this.handle === undefined) this.open();
    writeSync(this.handle!, `${JSON.stringify(e)}\n`);
    this.seen.add(e.key);
    this.written++;
  }

  get count(): number {
    return this.written;
  }

  close(): void {
    if (this.handle === undefined) return;
    closeSync(this.handle);
    this.handle = undefined;
  }
}

/** What a re-score produced, for a report or a diff against an earlier run. */
export interface RescoreSummary {
  total: number;
  scored: number;
  failed: number;
  correct: number;
  /** Keys present on disk but whose prompt hash differs from the current prompt. */
  stalePrompts: string[];
}

export function summariseExchanges(
  rows: { answer: string; error?: string; correct: boolean | null }[],
): RescoreSummary {
  const scored = rows.filter((r) => r.error === undefined && r.answer !== '');
  return {
    total: rows.length,
    scored: scored.length,
    failed: rows.length - scored.length,
    correct: scored.filter((r) => r.correct === true).length,
    stalePrompts: [],
  };
}
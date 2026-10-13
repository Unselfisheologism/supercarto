/**
 * A ModelClient that archives every exchange to disk.
 *
 * Wrapping rather than modifying the clients means any provider works without
 * being taught about archiving: the arena driver, an OpenAI-compatible local
 * endpoint, or a scripted test double all get durability for free.
 */

import { fingerprintPrompt, ResponseArchive, type Exchange } from './archive.js';
import type { ModelClient } from './models.js';
import type { ModelRequest, RunIdentity } from './types.js';

/** Re-exported so callers need only one import for archiving and identity. */
export type { RunIdentity };

/**
 * Options for `ArchivingClient`.
 *
 * An object rather than a bare sixth positional boolean, because that is exactly
 * the argument a caller passes `undefined` to and thereby means "off" while
 * believing they meant "default".
 */
export interface ArchivingOptions {
  /**
   * Refuse to replay an archived answer whose prompt differs from the current one.
   * Default true.
   */
  requireFresh?: boolean;
}

/**
 * Provider's stable model id, recorded on every exchange.
 *
 * Kept off `RunIdentity` because it describes the model rather than the call,
 * and the runner has no way to know it. The driver supplies it through
 * `modelIdFor`.
 */
export type ModelIdFor = () => string | undefined;

/**
 * Archive every call, and skip ones already recorded.
 *
 * `keyFor` supplies the identity of the call, because the client only sees the
 * prompt and has no idea which task, arm, budget, or seed it belongs to.
 */
export class ArchivingClient implements ModelClient {
  private skipped = 0;

  constructor(
    private readonly inner: ModelClient,
    private readonly archivePath: string,
    private readonly keyFor: (req: ModelRequest) => RunIdentity,
    private readonly archive: ResponseArchive = new ResponseArchive(archivePath),
    private readonly modelIdFor: ModelIdFor = () => undefined,
    /**
     * Refuse to replay an archived answer whose prompt differs from the current
     * one. Default true: silently combining two harnesses is the failure mode this
     * exists to prevent, so opting out should be deliberate.
     *
     * Accepts a boolean for convenience at the call site and an options object for
     * anything further, because a sixth positional boolean is exactly the kind of
     * argument that gets passed as `undefined` and silently means "false" to a
     * reader who meant "default".
     */
    requireFresh: boolean | ArchivingOptions = true,
  ) {
    this.requireFresh =
      typeof requireFresh === 'boolean' ? requireFresh : (requireFresh.requireFresh ?? true);
    this.archive.open();
  }

  private readonly requireFresh: boolean;

  get id(): string {
    return this.inner.id;
  }

  get model(): string {
    return this.inner.model;
  }

  /** Calls skipped because the archive already held them. */
  get resumed(): number {
    return this.skipped;
  }

  async call(req: ModelRequest): Promise<{ text: string; inputTokens: number; outputTokens: number; toolsUsed?: string[] }> {
    // Identity comes off the request when the runner supplied it, and falls back
    // to the caller's resolver otherwise. A driver cannot work this out from the
    // prompt text alone without breaking whenever a question is reworded.
    const id: RunIdentity = req.run ?? this.keyFor(req);
    // Model first, then configuration, so a per-model archive holds one
    // comparable set of rows rather than interleaved models.
    const fullKey = `${this.model}|${id.taskId}|${id.representation}@${id.budget}|s${id.seed}`;

    const promptHash = fingerprintPrompt(req.system, req.user);

    if (this.archive.has(fullKey)) {
      const prior = ResponseArchive.read(this.archivePath).find((e) => e.key === fullKey);
      this.skipped++;

      // Resume must not blend runs from different harnesses.
      //
      // The archive key is task, arm, budget and seed, and none of those change
      // when the code does. So after a scoring or prompt change a resumed run
      // silently replayed old answers and scored them under new rules, producing a
      // table that mixed two harnesses and looked like a single result. The
      // prompt hash is already stored on every exchange precisely so this is
      // detectable; nothing compared it until now.
      //
      // `requireFresh` makes it fatal rather than silent. A run that cannot
      // distinguish its own history should stop and say so.
      if (this.requireFresh && prior && prior.promptHash !== promptHash) {
        throw new Error(
          `archived exchange ${fullKey} was produced by a different prompt ` +
            `(archive ${prior.promptHash}, now ${promptHash}). Refusing to resume ` +
            `across a harness change: use a new --out directory, or pass ` +
            `allowMixedRuns to accept that the two are being combined.`,
        );
      }

      // The caller still needs a response to score, so a resumed run replays the
      // stored answer rather than calling the model again.
      return {
        text: prior?.answer ?? '',
        inputTokens: prior?.inputTokens ?? 0,
        outputTokens: prior?.outputTokens ?? 0,
        ...(prior?.toolsUsed && prior.toolsUsed.length > 0 ? { toolsUsed: prior.toolsUsed } : {}),
      };
    }
    try {
      const res = await this.inner.call(req);
      const record: Exchange = {
        key: fullKey,
        taskId: id.taskId,
        representation: id.representation,
        budget: id.budget,
        seed: id.seed,
        model: this.model,
        modelId: this.modelIdFor(),
        system: req.system,
        user: req.user,
        promptHash,
        answer: res.text,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        at: new Date().toISOString(),
        ...(res.toolsUsed && res.toolsUsed.length > 0 ? { toolsUsed: res.toolsUsed } : {}),
      };
      this.archive.write(record);
      return res;
    } catch (err) {
      // Failures are archived too. A run that dies halfway should be
      // resumable, and it cannot be if the failure is invisible.
      const record: Exchange = {
        key: fullKey,
        taskId: id.taskId,
        representation: id.representation,
        budget: id.budget,
        seed: id.seed,
        model: this.model,
        modelId: this.modelIdFor(),
        system: req.system,
        user: req.user,
        promptHash,
        answer: '',
        inputTokens: 0,
        outputTokens: 0,
        at: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      };
      this.archive.write(record);
      throw err;
    }
  }

  close(): void {
    this.archive.close();
  }
}
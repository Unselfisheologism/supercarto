/**
 * Run metadata.
 *
 * A number without the commit that produced it, the harness version, and the
 * fixtures it ran against is not a result, it is a rumour. Reports recorded none of
 * those, so two reports could not be compared and neither could be reproduced.
 *
 * Everything here is cheap to collect and impossible to reconstruct after the
 * fact: the commit moves, `opencode --version` is overwritten, and the live map
 * changes under the answer.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FREEMODELS } from './driver/opencode.js';

export interface RunMetadata {
  /** ISO 8601. */
  at: string;
  /** Git commit of the harness, or null outside a repository. */
  commit: string | null;
  /** True when the working tree had uncommitted changes. */
  dirty: boolean;
  /** opencode CLI version, which is not the same as the model. */
  opencodeVersion: string | null;
  /** supercarto package version. */
  harnessVersion: string;
  /** Models this run intended to call. */
  models: string[];
  /** SHA-256 per fixture, so a re-run against changed data is detectable. */
  fixtures: Record<string, { features: number; sha256: string }>;
  /** The facts a report must not overstate about this path. */
  limits: string[];
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function opencodeVersion(): string | null {
  try {
    const bin =
      process.platform === 'win32'
        ? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')
        : 'opencode';
    return execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
}

function harnessVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Everything known to be weaker on the opencode path, as sentences. */
export const OPENCODE_PATH_LIMITS: readonly string[] = [
  'opencode run exposes no --temperature and no --seed flag, so neither reaches the model. Repeated seeds are repeats, not independent samples, and a spread of 0.00 is not an error bar.',
  'The free tier reports no usage block. Token counts are chars/4 estimates, not provider tokenizer output. Ratios between arms remain meaningful because both use the same estimator; absolute figures are not provider figures.',
  'Caches inside the provider cannot be disabled or measured from here. --standalone removes the shared opencode session cache only.',
  'Tool use cannot be prevented on this CLI; a run that invoked a tool is voided rather than scored, so the guarantee is detection, not prevention.',
];

/** Collect run metadata. Never throws: a missing field is better than a failed run. */
export function runMetadata(opts: {
  models: string[];
  fixtures: Record<string, unknown>;
  fixtureDir?: string;
}): RunMetadata {
  const fixtureDir = opts.fixtureDir ?? join(process.cwd(), 'fixtures', 'bench');
  const fixtures: RunMetadata['fixtures'] = {};

  for (const [id, value] of Object.entries(opts.fixtures)) {
    const features =
      value && typeof value === 'object' && 'features' in value && Array.isArray(value.features)
        ? value.features.length
        : 0;
    const path = join(fixtureDir, `${id}.geojson`);
    fixtures[id] = {
      features,
      sha256: existsSync(path) ? sha256(path) : 'unavailable',
    };
  }

  return {
    at: new Date().toISOString(),
    commit: git(['rev-parse', 'HEAD']),
    dirty: (git(['status', '--porcelain']) ?? '').length > 0,
    opencodeVersion: opencodeVersion(),
    harnessVersion: harnessVersion(),
    models: opts.models,
    fixtures,
    limits: [...OPENCODE_PATH_LIMITS],
  };
}

/** Models this build knows about, for a report that does not name any. */
export function knownFreeModels(): readonly string[] {
  return FREEMODELS;
}
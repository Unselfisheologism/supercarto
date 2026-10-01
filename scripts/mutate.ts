export {};

/**
 * Mutation harness.
 *
 * A test that passes tells you nothing unless it fails when the fix is undone.
 * This deliberately breaks each guard in turn and asserts the suite catches it,
 * so "the tests cover this" becomes a verified claim rather than a hope.
 *
 *   npx tsx scratch/mutate.ts
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'src/source/overpass.ts';
const ORIGINAL = readFileSync(SRC, 'utf8');

interface Mutation {
  name: string;
  from: string;
  to: string;
}

const MUTATIONS: Mutation[] = [
  {
    name: 'majority filter -> unanimous',
    from: 'if (good.length * 2 <= coords.length) continue;',
    to: 'if (good.length !== coords.length) continue;',
  },
  {
    name: 'tolerance floor -> 0.05 degrees (5.5km)',
    from: 'const slackLat = Math.max(0.0015, Math.min((north - south) * 0.25, 0.05));',
    to: 'const slackLat = Math.max(0.05, (north - south) * 0.1);',
  },
  {
    name: 'drop the all-features-corrupt error',
    from: 'if (features.length > 0 && ok.length === 0) {',
    to: 'if (false) {',
  },
  {
    name: 'empty-200 retry -> trust it',
    from: 'if (raw === 0 && req.layers.length === 0 && retriedEmpty) {',
    to: 'if (false) {',
  },
  {
    name: 'server-side cap 5000 -> 25000',
    from: 'const cap = Math.min(req.maxFeatures || SERVER_SIDE_CAP, SERVER_SIDE_CAP);',
    to: 'const cap = Math.min(req.maxFeatures || 25_000, 25_000);',
  },
  {
    name: 'shrink-on-corrupt-ways -> never shrink',
    from: 'const wantsShrink =',
    to: 'const wantsShrink = false &&',
  },
  {
    name: 'keep best partial result -> throw away',
    from: 'if (best) {',
    to: 'if (false && best) {',
  },
];

let survivors = 0;

for (const m of MUTATIONS) {
  if (!ORIGINAL.includes(m.from)) {
    console.log(`SKIP  ${m.name} (anchor not found - source moved?)`);
    survivors++;
    continue;
  }
  writeFileSync(SRC, ORIGINAL.replace(m.from, m.to));
  let failed = false;
  try {
    execFileSync('npx', ['vitest', 'run'], { stdio: 'pipe', timeout: 600_000 });
  } catch {
    failed = true;
  }
  console.log(`${failed ? 'CAUGHT' : 'MISSED'} ${m.name}`);
  if (!failed) survivors++;
}

writeFileSync(SRC, ORIGINAL);
console.log(
  survivors === 0
    ? '\nall mutations caught'
    : `\n${survivors} mutation(s) survived - the suite does not cover that guard`,
);
process.exit(survivors === 0 ? 0 : 1);
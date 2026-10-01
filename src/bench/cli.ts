import { writeFileSync } from 'node:fs';
import { runBenchmark, clientFor, type RunReport } from './runner.js';
import { PANEL, EVAL_PROTOCOL, TASK_AREAS, type ModelSpec } from './tasks.js';
import type { Representation } from './score.js';

/**
 * Report rendering.
 *
 * Written as plain text tables on purpose. A benchmark result that only exists
 * inside a web page cannot be diffed between runs, quoted in a changelog, or
 * checked by someone who does not trust the page. JSON goes alongside it for
 * the same reason.
 */

/** `supercarto bench:tasks` */
export async function mainBenchTasks(argv: string[]): Promise<number> {
  const flags = parse(argv);

  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const specs = PANEL.filter((s) => flags.model === true || flags.model === s.id);
  if (specs.length === 0) {
    process.stderr.write('no model selected; pass --model <id> or set credentials\n');
    return 1;
  }

  const models = specs
    .map(clientFor)
    .filter((c): c is NonNullable<typeof c> => c !== undefined);

  if (models.length === 0) {
    process.stderr.write(
      `no credentials found. Set one of:\n` +
        specs.map((s) => `  ${s.keyEnv}  (${s.id})`).join('\n') +
        `\n\nOr point at a local model:\n` +
        `  SUPERCARTO_LOCAL_LLM=http://localhost:8000/v1/chat/completions\n`,
    );
    return 1;
  }

  const budgetFlag = typeof flags.budgets === 'string' ? flags.budgets : undefined;
  const budgets = budgetFlag
    ? budgetFlag.split(',').map((n: string) => Number(n.trim()))
    : [512, 1024, 2048];
  if (budgets.some((n: number) => !Number.isFinite(n) || n < 128)) {
    process.stderr.write('budgets must be numbers of at least 128\n');
    return 1;
  }

  const areaFlag = typeof flags.areas === 'string' ? flags.areas : undefined;
  const areas = areaFlag
    ? TASK_AREAS.filter((a) => areaFlag.split(',').includes(a.id))
    : TASK_AREAS;

  if (areas.length === 0) {
    process.stderr.write(`no areas matched --areas\n`);
    return 1;
  }

  process.stderr.write(
    `benchmarking ${areas.length} areas x ${budgets.length} budgets x ${models.length} models\n` +
      `protocol: temperature ${EVAL_PROTOCOL.temperature}, ${EVAL_PROTOCOL.seeds} seeds, caches ${EVAL_PROTOCOL.disableCaches ? 'off' : 'on'}\n\n`,
  );

  const report = await runBenchmark({
    areas,
    budgets,
    models,
    onProgress: (m) => process.stderr.write(`  ${m}\n`),
  });

  if (typeof flags.out === 'string') {
    writeFileSync(flags.out, JSON.stringify(report, null, 2) + '\n', 'utf8');
    process.stderr.write(`\nwrote JSON to ${flags.out}\n`);
  }
  process.stdout.write(render(report));
  return 0;
}

const HELP = `supercarto bench:tasks - task-level accuracy benchmark

Compares the same question, the same model, and the same prompt across three
representations of the same underlying map data:

  supercarto   the compiled topological YAML graph, at each token budget
  geojson      raw GeoJSON, which is what a map API returns today
  none         coordinates and nothing else, the honest floor

Ground truth comes from OSRM for routing tasks and from the source data for
place tasks, so most rows are scored programmatically rather than by a judge.

USAGE
  supercarto bench:tasks [--model <id>] [--budgets 512,1024,2048]
                         [--areas sf-cbd,oslo] [--out report.json]

OPTIONS
  --model <id>       Run one model. Repeatable via --model twice, or omit to
                     run every model whose credential is present.
  --budgets <list>   Token budgets to sweep for the supercarto arm.
  --areas <list>     Area ids to include. Default: all.
  --out <path>       Write the full JSON report, including every answer.
  --help             This message.

CREDENTIALS
  ANTHROPIC_API_KEY              claude-sonnet
  OPENAI_API_KEY                 gpt
  GEMINI_API_KEY                 gemini
  SUPERCARTO_LOCAL_LLM=<url>     small-local, any OpenAI-compatible endpoint

  The local model is not optional decoration. A result on a 7B model is the one
  claim a token-count benchmark cannot manufacture, so it should be in every
  published run.

NOTES
  Expect this to take a while: areas x budgets x representations x models x
  seeds requests, each with a live map fetch. Budget accordingly, and prefer
  running it in CI on a schedule over running it by hand before a release.
`;

function parse(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[a.slice(2)] = next;
        i++;
      } else {
        out[a.slice(2)] = true;
      }
    }
  }
  return out;
}

function render(report: RunReport): string {
  const lines: string[] = [];

  lines.push('CONTEXT COST');
  lines.push('  representation   median tokens   vs supercarto');
  lines.push('  --------------   -------------   --------------');
  for (const t of report.tokenCost) {
    lines.push(
      `  ${t.representation.padEnd(14)}   ${String(t.medianContextTokens).padStart(11)}` +
        `   ${(t.multipleOfSupercarto ? `${t.multipleOfSupercarto}x` : '-').padStart(12)}`,
    );
  }

  lines.push('');
  lines.push('ACCURACY');
  lines.push('  model              representation   accuracy   completion   tokens   spread');
  lines.push('  -----------------  --------------   --------   ---------   ------   ------');
  for (const s of report.summaries) {
    lines.push(
      `  ${s.model.padEnd(17)}  ${s.representation.padEnd(14)}   ` +
        `${fmtPct(s.accuracy).padStart(8)}   ${fmtPct(s.completion).padStart(9)}   ` +
        `${String(s.medianInputTokens).padStart(6)}   ${s.accuracySpread.toFixed(2).padStart(6)}`,
    );
  }

  const failed = report.detail.filter((d) => d.error !== undefined);
  if (failed.length > 0) {
    lines.push('');
    lines.push(`FAILURES (${failed.length})`);
    const kinds = new Map<string, number>();
    for (const f of failed) {
      const key = f.error!.split('\n')[0]!.slice(0, 80);
      kinds.set(key, (kinds.get(key) ?? 0) + 1);
    }
    for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      lines.push(`  ${String(n).padStart(4)}x  ${k}`);
    }
  }

  lines.push('');
  lines.push('AREAS');
  for (const a of report.areas) {
    lines.push(`  ${a.id.padEnd(18)} ${a.label}`);
    lines.push(`  ${' '.repeat(18)} ${a.rationale}`);
  }

  lines.push('');
  lines.push(
    `protocol: temperature ${report.protocol.temperature}, ${report.protocol.seeds} seeds, ` +
      `caches ${report.protocol.disableCaches ? 'disabled' : 'enabled'}`,
  );
  lines.push(`generated: ${report.generatedAt}`);
  lines.push('');
  lines.push(
    'Read the accuracy column together with the token column. Accuracy alone is ' +
      'achievable by\nsending more data; accuracy at a fixed token budget is the ' +
      'claim being made here.',
  );

  return lines.join('\n') + '\n';
}

function fmtPct(n: number | null): string {
  if (n === null) return 'n/a';
  return `${Math.round(n * 100)}%`;
}

export type { Representation };

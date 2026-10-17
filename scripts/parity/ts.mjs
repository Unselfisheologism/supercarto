// Parity harness, TypeScript side.
//
// Runs the reference compiler on a GeoJSON fixture with fixed options and
// writes the emitted YAML to a file. Pair with py.py and diff the outputs:
// identical YAML is the gate for every stage of the Python-native port.
//
//   node scripts/parity/ts.mjs examples/sf-mission-5th.geojson /tmp/ts.yaml \
//     '{"budget":1024,"compile":{"now":"2026-10-01T12:00:00Z","utcOffsetMinutes":-420}}'
//
// Metrics go to stderr so stdout stays empty and the YAML is exactly the file.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { toMaplet } from '../../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

const [input, output, optsJson] = process.argv.slice(2);
const data = JSON.parse(readFileSync(input, 'utf8'));
const opts = JSON.parse(optsJson ?? '{}');

const req = { ...opts };
if (opts.compile?.now) opts.compile.now = new Date(opts.compile.now);
req.compile = opts.compile;
req.budgetOpts = opts.budgetOpts;

const m = toMaplet(data, req);
writeFileSync(output, m.yaml);
process.stderr.write(
  JSON.stringify({
    tokens: m.metrics.tokens,
    nodes: m.metrics.nodes,
    edges: m.metrics.edges,
    dropped: m.metrics.droppedNodes,
  }) + '\n',
);
void join;
void repo;

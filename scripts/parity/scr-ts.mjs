#!/usr/bin/env node
// SCR codec parity harness, TypeScript reference side.
//
// Compiles a GeoJSON fixture the way `ts.mjs` does, then writes the encoder's
// output (m.scr) to the output file, and verifies on the reference side that
// decode->re-encode is a fixed point. `scr-py.py` writes the same bytes from
// the Python port; check.sh cmps the pair per fixture.
//
//   npx tsx scripts/parity/scr-ts.mjs examples/sf-mission-5th.geojson /tmp/ts.scr \
//     '{"budget":1024,"compile":{"now":"2026-10-01T12:00:00Z","utcOffsetMinutes":-420}}'

import { readFileSync, writeFileSync } from 'node:fs';
import { toMaplet, decodeDocument, encodeDocument } from '../../src/index.ts';

const [input, output, optsJson] = process.argv.slice(2);
const data = JSON.parse(readFileSync(input, 'utf8'));
const opts = JSON.parse(optsJson ?? '{}');

const req = { ...opts };
if (opts.compile?.now) opts.compile.now = new Date(opts.compile.now);
req.compile = opts.compile;
req.budgetOpts = opts.budgetOpts;

const m = toMaplet(data, req);
writeFileSync(output, m.scr);

const round = encodeDocument(decodeDocument(m.scr), { group: false });
process.stderr.write(
  JSON.stringify({ wireBytes: m.metrics.wireBytes, roundtrip: round === m.scr }) + '\n',
);

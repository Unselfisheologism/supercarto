// Parity harness, diff engine, TypeScript side.
//
// Builds two SCR documents from two synthetic GeoJSON collections (same
// envelope, shared feature ids, mutation kinds), diffs them and prints a
// fixed report of changes and rendered diff text. Pair with diff-py.py:
// byte-identical JSON is the gate for the Python diff port.
//
//   node scripts/parity/diff-ts.mjs
//   python3 scripts/parity/diff-py.py
//   diff <(node scripts/parity/diff-ts.mjs) <(python3 scripts/parity/diff-py.py)

import {
  fromGeoJson,
  diffDocuments,
  renderDiff,
  encodeDocument,
  moveMaplet,
} from '../../dist/index.js';

const pt = (lon, lat, name, tags = {}, id) => ({
  type: 'Feature',
  id,
  properties: { name, amenity: 'cafe', ...tags },
  geometry: { type: 'Point', coordinates: [lon, lat] },
});

// Document A (the map the agent holds).
const a = {
  type: 'FeatureCollection',
  features: [
    pt(2.0, 41.38, 'Cafe Alpha', {}, 10),
    pt(2.005, 41.381, 'Cafe Beta', {}, 11),
    pt(2.004, 41.3825, 'Cafe Gamma', { wheelchair: 'yes' }, 12),
    pt(2.008, 41.383, 'Cafe Delta', {}, 13),
  ],
};

// Document B (the next view, moments later): w10 moved, w11 renamed,
// w12 lost its wheelchair tag, w13 left view, w14 entered view, and w15
// differs only by class (amenity vs shop), same name and geometry.
const b = {
  type: 'FeatureCollection',
  features: [
    pt(2.002, 41.3802, 'Cafe Alpha', {}, 10),
    pt(2.005, 41.381, 'Cafe Beta II', {}, 11),
    pt(2.004, 41.3825, 'Cafe Gamma', {}, 12),
    pt(2.006, 41.384, 'Cafe Echo', {}, 14),
    {
      type: 'Feature',
      id: 15,
      properties: { name: 'Bakery Echo', shop: 'bakery' },
      geometry: { type: 'Point', coordinates: [2.0065, 41.3842] },
    },
  ],
};

// One shared envelope, pinned explicitly: both documents must quantize
// identically (the same precondition the session enforces by re-ingesting
// every move under the session's envelope), and the harness must mirror it.
const ENVELOPE = { type: 'bbox', west: 2.0, south: 41.38, east: 2.01, north: 41.385 };

// The harness compiles at a fixed instant so the sun line is deterministic:
// session moves re-compile, and a live clock on each side would only agree
// by luck.
const COMPILE = { now: new Date('2026-10-18T12:00:00Z'), utcOffsetMinutes: 0 };

const docA = fromGeoJson(a, { envelope: ENVELOPE });
const docB = fromGeoJson(b, { envelope: ENVELOPE });

const changes = diffDocuments(docA, docB);
const report = {
  changes,
  rendered: renderDiff(changes, docA, docB),
};

// Session walk stage: open the agent's state as SCR from document A, take a
// step to view B, then a step to view C (a subset: one departed place). Each
// move re-ingests under the agent's own envelope, so everything downstream -
// diff text, counts, metrics and the returned SCR bytes - must match the
// Python port byte for byte.
const scrA = encodeDocument(docA, { group: false });
const move1 = moveMaplet(scrA, b, { envelope: ENVELOPE, compile: COMPILE });

// View C: a later step back through the same corridor, one cafe departed.
const c = {
  type: 'FeatureCollection',
  features: [
    pt(2.002, 41.3802, 'Cafe Alpha', {}, 10),
    pt(2.006, 41.384, 'Cafe Echo', {}, 14),
  ],
};
const move2 = moveMaplet(move1.scr, c, { envelope: ENVELOPE, compile: COMPILE });

process.stdout.write(
  JSON.stringify({
    engine: report,
    session: [move1, move2].map((m) => ({
      counts: m.counts,
      report: m.report,
      scr: m.scr,
      yaml: m.yaml,
      metrics: m.metrics,
      view: m.view,
    })),
  }) + '\n',
);

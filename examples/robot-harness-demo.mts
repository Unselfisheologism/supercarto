/**
 * Robot-harness demonstration prototype (D1 research prop — NOT a product).
 *
 * The question this prototype answers, in numbers a robotics team asks
 * first: given an onboard extract of map data and a stream of GPS ticks,
 * what does one "what's around me?" read cost the agent per tick in
 * tokens and milliseconds, and what does the answer look like when the
 * robot leaves the mapped area?
 *
 * The "device-local extract" here is examples/sf-mission-5th.geojson; on a
 * real robot it would be a PMTiles extract read off disk — the source
 * contract is the same select-near-pose query either way.
 *
 * Run:  npx tsx examples/robot-harness-demo.mts
 *
 * Deliberately in examples/, not shipped: it is a conversation prop for the
 * robot-harness research bet (docs/strategy/robot-harness-brief.md), so the
 * prompt-shaped design can be argued from measurements instead of
 * adjectives.
 */

import { readFileSync } from 'node:fs';
import { SuperCarto } from '../src/live.js';
import type { MapSource, SourceRequest, SourceResult } from '../src/source/types.js';

const BUDGET = 512; // a per-tick prompt budget, not a chat budget
const TICKS = 6;

// --- the onboard extract -----------------------------------------------------

const raw = JSON.parse(
  readFileSync(new URL('./sf-mission-5th.geojson', import.meta.url), 'utf8'),
) as {
  features: { type: 'Feature'; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }[];
};

/** Central point of the extract; ticks walk north out of it. */
const extract = { lat: 37.7749, lon: -122.4194, radiusM: 400 };

const source: MapSource = {
  name: 'device-extract',
  async available(): Promise<boolean> {
    return true;
  },
  async fetch(req: SourceRequest): Promise<SourceResult> {
    // On a robot this is the PMTiles reader selecting by pose. Here it is
    // the same select over fixture features.
    return { features: raw.features as never, source: this.name, truncated: false, elapsedMs: 0, warnings: [] };
  },
};

const carto = new SuperCarto({ sources: [source] });

// --- the tick loop -----------------------------------------------------------

const toRad = (d: number) => (d * Math.PI) / 180;

for (let tick = 0; tick < TICKS; tick++) {
  // Walk ~55m north per tick: inside the extract for the first ticks, then
  // past its edge.
  const lat = extract.lat + toRad((tick * 55) / 111_320);
  const t0 = performance.now();
  const res = await carto.maplet({ lat, lon: extract.lon, radiusM: extract.radiusM, budget: BUDGET });
  const ms = Math.round(performance.now() - t0);

  const offExtract = Math.abs(lat - extract.lat) * 111_320 > extract.radiusM;
  const note = res.yaml.split('note:')[1]?.split('\n')[0]?.trim() ?? '';
  const empty = res.graph.edges.length === 0 && res.graph.nodes.length === 0;

  console.log(
    `tick ${tick}  ${ms}ms  ${res.metrics.yamlTokens} tok  ` +
      `near=${res.graph.nodes.length} nodes ` +
      `${res.graph.edges.length} edges  withinExtract=${JSON.stringify(!offExtract)}`,
  );
  if (offExtract || empty) {
    console.log(`   degraded answer on purpose (honest state preserved): ${note}`);
  }
}

console.log('\nWhat this is not: no motion (no heading/speed), no PMTiles reader wired');
console.log('here (GeoJSON fixture plays its role), no per-tick diff. Those are the');
console.log('three changes the two-week prototype would add; this file exists to give');
console.log('the conversation its first real numbers, not to claim a product.');

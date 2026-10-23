// probe-budget: why does the live maplet exceed budget 512 on sf fixture?
import { toMaplet } from '../../src/pipeline.js';
import { estimateTokens } from '../../src/emit/yaml.js';

const parsed = JSON.parse(
  (await import('node:fs')).readFileSync(
    '/root/supercarto/examples/sf-mission-5th.geojson',
    'utf8',
  ),
);

const feats = parsed.features as {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
}[];

const r = toMaplet(feats as never, {
  bbox: { west: -122.42394, south: 37.77112, east: -122.41494, north: 37.77866 },
  budget: 512,
});
console.log('graph nodes:', r.graph.nodes.length, 'edges:', r.graph.edges.length);
console.log('metrics:', r.metrics.budget, r.metrics.tokens, r.metrics.yamlTokens);

// does the final yaml itself claim to fit?
console.log('estimateTokens(final yaml):', estimateTokens(r.yaml));

// Split the yaml into blocks; count tokens of each block so we can see
// what the budget engine saw vs what left the door.
const yaml = r.yaml;
const lines = yaml.split('\n');
console.log('--- block sizes (indent-0 sections) ---');
let section = 'prologue';
const sizes = new Map<string, number>();
for (const line of lines) {
  if (!line.startsWith(' ')) {
    section = line.trim() || 'prologue';
    sizes.set(section, 0);
  }
  sizes.set(section, (sizes.get(section) || 0) + estimateTokens(line));
}
for (const [sec, tok] of sizes) console.log(`  ${sec.padEnd(12)} ${tok}`);

/**
 * Offline Jakarta-Monas maplet builder.
 *
 * Reads ONLY the saved capture (no network, no API key), compiles it at two
 * token budgets through the same pipeline `toMaplet` uses in production, and
 * writes the YAML maplets plus a JSON summary a GIS developer can scan.
 *
 *   npx tsx examples/jakarta-monas/compile-offline.ts
 *
 * Every number in the summary is an estimate where token counts are involved:
 * the engine estimates tokens as characters/4 (see src/emit/yaml.ts), so token
 * figures are labeled `tokenEstimate` and `budget` is enforced on that basis.
 */
import { writeFileSync } from 'node:fs';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toMaplet } from '../../src/pipeline.js';
import type { SpatialGraph } from '../../src/compile/graph.js';
import type { GeoJsonFeatureCollection } from '../../src/ingest/geojson.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const UTC_OFFSET_MINUTES = 7 * 60; // WIB, Jakarta: UTC+7, no DST.

interface CaptureMeta {
  timestamp: string;
  endpoint: string;
  center: { lat: number; lon: number; label: string };
  radiusM: number;
  bbox: { west: number; south: number; east: number; north: number };
  attempts: number;
  truncated: boolean;
  attribution: string;
  warnings: string[];
}

const meta = JSON.parse(readFileSync(join(HERE, 'capture-meta.json'), 'utf8')) as CaptureMeta;
const capture: GeoJsonFeatureCollection = JSON.parse(
  readFileSync(join(HERE, 'jakarta-monas.geojson'), 'utf8'),
);

/**
 * Time-dependent inputs are fixed to the capture, not to the wall clock:
 * opening-hours phrases and the `hours` field would otherwise change between
 * runs, and the YAML would stop being reproducible offline.
 */
const RUN = {
  now: new Date(meta.timestamp),
  utcOffsetMinutes: UTC_OFFSET_MINUTES,
  bbox: meta.bbox,
  radiusLabel: `${meta.radiusM}m`,
};

const BUDGETS = [1024, 2048];

interface BudgetReport {
  budget: number;
  bytes: number;
  chars: number;
  /** Engine estimate: chars/4. An estimate, not a tokenizer count. */
  tokenEstimate: number;
  nodes: number;
  edges: number;
  namedPlaces: Array<{ id: string; name: string; kind: string; tags: string[] }>;
  streetConnections: number;
  blockedEdges: number;
  disconnectedGroups: Array<{ id: number; nodes: string[] }>;
  omissions: Array<{ layer: string; count: number; near: string }>;
  partial: boolean;
  drops: { nodes: number; edges: number };
  warnings: string[];
}

/** Weakly-connected components, by BFS over a plain adjacency map. */
function components(g: SpatialGraph): Map<string, number> {
  const adj = new Map(g.nodes.map((n) => [n.id, [] as string[]]));
  for (const e of g.edges) {
    adj.get(e.from)?.push(e.to);
    adj.get(e.to)?.push(e.from);
  }
  const label = new Map<string, number>();
  let group = 0;
  for (const n of g.nodes) {
    if (label.has(n.id)) continue;
    const stack = [n.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (label.has(id)) continue;
      label.set(id, group);
      stack.push(...adj.get(id)!);
    }
    group++;
  }
  return label;
}

const gisWarnings = [...meta.warnings];

const budgets: Array<{ id: number; file: string; report: BudgetReport }> = [];

for (const budget of BUDGETS) {
  const result = toMaplet(capture, {
    bbox: RUN.bbox,
    radiusLabel: RUN.radiusLabel,
    budget,
    // OpenStreetMap provenance carried from the capture meta.
    compile: {
      now: RUN.now,
      utcOffsetMinutes: RUN.utcOffsetMinutes,
    },
  });

  const g = result.graph;
  const labels = components(g);
  const groups = new Map<number, string[]>();
  for (const [id, comp] of labels) {
    const list = groups.get(comp) ?? [];
    list.push(id);
    groups.set(comp, list);
  }

  /**
   * Street connections are the emitted directed edges on a road-class path,
   * counted mid-arrows: a two-way street contributes 2 edges in 1 connection.
   */
  const streetEdges = g.edges.filter((e) => e.path === 'road' && !e.blocked);
  const blocked = g.edges.filter((e) => e.blocked);

  if (g.omitted.length > 0) gisWarnings.push('budget omissions recorded below');

  const file = `jakarta-monas-${budget}.yaml`;
  writeFileSync(join(HERE, file), result.yaml);

  const named = g.nodes.filter((n) => n.name);
  const report: BudgetReport = {
    budget,
    bytes: Buffer.byteLength(result.yaml, 'utf8'),
    chars: result.yaml.length,
    tokenEstimate: result.metrics.yamlTokens,
    nodes: g.nodes.length,
    edges: g.edges.length,
    namedPlaces: named.map((n) => ({ id: n.id, name: n.name!, kind: n.kind, tags: n.tags ?? [] })),
    streetConnections: streetEdges.length,
    blockedEdges: blocked.length,
    disconnectedGroups: [...groups.entries()].map(([id, nodes]) => ({ id, nodes })),
    omissions: g.omitted.map((o) => ({ layer: o.layer, count: o.count, near: o.near })),
    partial: g.partial,
    drops: { nodes: result.metrics.droppedNodes, edges: result.metrics.droppedEdges },
    warnings: gisWarnings.slice(),
  };

  budgets.push({ id: budget, file, report });
  console.log(`${file}: ${report.bytes}B ≈${report.tokenEstimate} tok (estimate; chars/4), ${named.length} named places, ${report.streetConnections} street connections, ${groups.size} disconnected group(s)`);
}

if (!existsSync(join(HERE, 'raw-overpass.json'))) {
  console.error('raw-overpass.json missing; cannot compile offline');
  process.exit(1);
}

const summary = {
  example: 'jakarta-monas',
  purpose: 'Reproducible compact Jakarta street graph: how much context a token-budgeted graph adds over a place list.',
  data: {
    source: 'raw-overpass.json, captured from Overpass exactly once',
    captureTimestamp: meta.timestamp,
    center: meta.center,
    radiusMeters: meta.radiusM,
    bbox: meta.bbox,
    attempts: meta.attempts,
    truncated: meta.truncated,
    attribution: meta.attribution,
    warnings: gisWarnings.slice(0, meta.warnings.length),
    caveat: 'Real Jakarta data, one capture. Not synthetic and not re-fetchable without a new capture.',
  },
  determinism: {
    offlineInputs: ['jakarta-monas.geojson', 'capture-meta.json', 'raw-overpass.json'],
    timeInputsFixed: `now=${meta.timestamp}, utcOffsetMinutes=${UTC_OFFSET_MINUTES} (WIB)`,
    command: 'npm run example:jakarta-monas',
  },
  tokenEstimates: 'All token figures are engine estimates (characters/4), not tokenizer counts.',
  budgets,
};
writeFileSync(join(HERE, 'maplet-summary.json'), JSON.stringify(summary, null, 2));
console.log('wrote maplet-summary.json');

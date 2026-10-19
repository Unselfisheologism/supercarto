/**
 * Directed-path check between two retained named places, offline.
 *
 * Picks two places by name from the budgeted maplet, answers "does a directed
 * path exist between them" with plain BFS written HERE (not the library's own
 * search or router), prints the supporting node and edge ids, and audits every
 * claimed join against raw-overpass.json: each edge's OSM way must exist in the
 * raw capture, and each endpoint must weld to a vertex of that way.
 *
 * Valid answers are any of connected, disconnected, unknown. This is a
 * feasibility check on the emitted graph, not navigation advice.
 *
 *   npx tsx examples/jakarta-monas/path-check.ts
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toMaplet } from '../../src/pipeline.js';
import { decodeDocument } from '../../src/wire/decode.js';
import { gridScaleFor } from '../../src/geo/scale.js';
import { haversine } from '../../src/geo/project.js';
import type { SpatialGraph, GraphEdge } from '../../src/compile/graph.js';
import type { GeoJsonFeatureCollection } from '../../src/ingest/geojson.js';

const HERE = dirname(fileURLToPath(import.meta.url));

interface RawElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
}

const raw = JSON.parse(readFileSync(join(HERE, 'raw-overpass.json'), 'utf8')) as {
  elements: RawElement[];
};
const rawById = new Map(raw.elements.map((e) => [e.id as number, e]));
const capture: GeoJsonFeatureCollection = JSON.parse(
  readFileSync(join(HERE, 'jakarta-monas.geojson'), 'utf8'),
);
const capMeta = JSON.parse(readFileSync(join(HERE, 'capture-meta.json'), 'utf8'));

/** Same frozen inputs the compile script uses, so the graph matches the YAML. */
const COMPILE = {
  now: new Date(capMeta.timestamp),
  utcOffsetMinutes: 420, // WIB
  bbox: capMeta.bbox,
  radiusLabel: `${capMeta.radiusM}m`,
};

/** Pairs under test: one that should be connected, one that should not be. */
const PAIRS: Array<[string, string]> = [
  ['Monas Barat', 'Taman Monas'],
  ['Loket', 'Monas Barat'],
];

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
      stack.push(...(adj.get(id) ?? []));
    }
    group++;
  }
  return label;
}

/** Directed BFS over the emitted edges. Written here, deliberately naive. */
function directedPath(
  g: SpatialGraph,
  from: string,
  to: string,
): GraphEdge[] | undefined {
  const adj = new Map<string, GraphEdge[]>();
  for (const e of g.edges) (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e);
  const prev = new Map<string, { node: string; via: GraphEdge }>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length) {
    const id = queue.shift()!;
    if (id === to) break;
    for (const e of adj.get(id) ?? []) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      prev.set(e.to, { node: id, via: e });
      queue.push(e.to);
    }
  }
  if (from === to) return [];
  if (!prev.has(to)) return undefined;
  const path: GraphEdge[] = [];
  let cur = to;
  while (cur !== from) {
    const step = prev.get(cur)!;
    path.unshift(step.via);
    cur = step.node;
  }
  return path;
}

/** Welding merges vertices within about one grid unit; one metre is safe. */
const WELD_TOLERANCE_M = 1;

function coordsOf(el: RawElement): Array<{ lat: number; lon: number }> {
  if (el.geometry) return el.geometry;
  if (el.lat !== undefined && el.lon !== undefined) return [{ lat: el.lat, lon: el.lon }];
  return [];
}

/** True when some vertex of feature A sits within tolerance of some vertex of B. */
function joinsWithin(A: RawElement, bs: RawElement[]): boolean {
  const va = coordsOf(A);
  return va.some((p) =>
    bs.some((b) => coordsOf(b).some((q) => haversine(p, q) < WELD_TOLERANCE_M)),
  );
}

const run = (): void => {
  for (const budget of [1024, 2048]) {
    const result = toMaplet(capture, { ...COMPILE, budget });
    const g = result.graph;
    const scale = gridScaleFor(decodeDocument(result.scr));
    const distM = (e: GraphEdge): string => {
      // The same per-axis conversion the YAML emitter applies, including
      // contracted multi-leg paths.
      if (!(scale.x > 0 && scale.y > 0 && Number.isFinite(scale.x) && Number.isFinite(scale.y))) {
        return `${Math.round(e.dist)}u`;
      }
      const metres = (e.segments ?? [e]).reduce(
        (sum, leg) => sum + Math.hypot(leg.dx * scale.x, leg.dy * scale.y), 0,
      );
      return `${Math.round(metres)}m`;
    };
    const labels = components(g);
    const groups = [...new Set(labels.values())].map((id) =>
      g.nodes.filter((n) => labels.get(n.id) === id).map((n) => n.id),
    );

    console.log(`\n=== budget ${budget} ===`);
    console.log(`disconnected groups: ${groups.length}`);
    for (const [name, target] of PAIRS) {
      const a = g.nodes.find((n) => n.name === name);
      const b = g.nodes.find((n) => n.name === target);
      if (!a || !b) {
        console.log(`\n${name} -> ${target}: unknown (place not retained at this budget; no answer invented)`);
        continue;
      }
      const path = directedPath(g, a.id, b.id);
      if ((labels.get(a.id) as number) !== (labels.get(b.id) as number) || !path) {
        console.log(`\n${name} -> ${target}: disconnected`);
        console.log(`  ${name} is ${a.id}, ${target} is ${b.id}; no edge sequence joins them in the emitted graph.`);
        continue;
      }
      console.log(`\n${name} -> ${target}: connected, directed path exists`);
      console.log(`  nodes: ${path.map((e) => e.from).concat(path.at(-1)!.to).join(' -> ')}`);
      console.log(`  edges (node->node | dist | dir | path | OSM features):`);
      for (const e of path) {
        const f = e.features.map((id) => `${id}(${rawById.get(id)?.tags?.name ?? rawById.get(id)?.tags?.highway ?? rawById.get(id)?.tags?.leisure ?? 'way'})`);
        console.log(`    ${e.from}->${e.to} | ${distM(e)} | ${e.dir} | ${e.path ?? '-'} | ${f.join(', ')}`);
      }
      // Audit every claimed join against the raw capture.
      //   path road/sidewalk/access-on-a-way: the endpoint nodes must weld to
      //     a vertex of the way the edge claims to walk on, present in the raw
      //     capture.
      //   path access: a compiler-built proximity link from a place to its
      //     nearest network node - a straight-line claim, not a street join.
      //     Reported as such; asserting a turn there would be inventing one.
      let audited = 0;
      let streetJoins = 0;
      let accessLinks = 0;
      let unverified = 0;
      for (const e of path) {
        for (const side of ['from', 'to'] as const) {
          audited++;
          const node = g.nodes.find((n) => n.id === e[side])!;
          const els = node.features.map((id) => rawById.get(id)).filter((x) => x !== undefined);
          if (els.length === 0) {
            unverified++;
            console.log(`  UNVERIFIED: none of node ${node.id}'s OSM features ${node.features} are in the raw capture`);
            continue;
          }
          const ways = e.features.map((id) => rawById.get(id)).filter((x) => x !== undefined);
          if (e.path === 'access') {
            // Straight-line proximity link: check what it can honestly claim.
            if (ways.length > 0) accessLinks++;
            else console.log(`  UNVERIFIED: ${e.from}->${e.to} has no raw way behind it`);
            continue;
          }
          if (ways.length === 0) {
            unverified++;
            console.log(`  UNVERIFIED: no raw way behind ${e.from}->${e.to}`);
            continue;
          }
          if (els.some((ely) => joinsWithin(ely!, ways))) streetJoins++;
          else {
            unverified++;
            console.log(`  UNVERIFIED: node ${node.id} welds to none of the claimed way(s) ${e.features}`);
          }
        }
      }
      console.log(`  join audit: ${streetJoins} street joins verified, ${accessLinks} compiler access links (both ends in raw data, straight-line claim), ${unverified} unverified, of ${audited} endpoint joins`);
    }
  }
};

run();

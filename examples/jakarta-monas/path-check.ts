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
    // Components, with units: each count is a number of components; kinds are
    // numbers of singleton nodes grouped by their node kind.
    const touching = new Set<string>();
    for (const e of g.edges) {
      touching.add(e.from);
      touching.add(e.to);
    }
    const groupNodes = new Map<number, string[]>();
    for (const [id, comp] of labels) {
      const list = groupNodes.get(comp) ?? [];
      list.push(id);
      groupNodes.set(comp, list);
    }
    const edgeGroups = [...groupNodes.values()].filter((ns) => ns.some((id) => touching.has(id)));
    const singletons = [...groupNodes.values()].filter((ns) => !ns.some((id) => touching.has(id)));
    const kinds = new Map<string, number>();
    for (const ns of singletons) {
      for (const id of ns) {
        const kind = g.nodes.find((n) => n.id === id)!.kind;
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      }
    }
    const kindLine = [...kinds.entries()].map(([k, n]) => `${k} ${n}`).join(', ');
    console.log(`components (unit: components): total ${groupNodes.size}, withEdges ${edgeGroups.length}, singletons ${singletons.length}`);
    console.log(`singletons (unit: nodes): ${kindLine || 'none'}`);
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
      // Path composition, unit: directed edges. Every count below names its
      // unit; no count is inferred from another count.
      const composition = { road: 0, sidewalk: 0, access: 0, other: 0 };
      for (const e of path) {
        const k = e.path ?? 'other';
        composition[k === 'road' || k === 'sidewalk' || k === 'access' ? k : 'other']++;
      }
      console.log(`  path composition (unit: directed edges): ${path.length} = ${composition.sidewalk} sidewalk + ${composition.access} access + ${composition.road} road + ${composition.other} other`);

      // Audit:
      //   Street edges (path road/sidewalk): scored per endpoint join, unit
      //     endpoint joins. Each endpoint's retained geometry must weld (share
      //     a vertex within tolerance) with the raw way the edge claims to
      //     walk on, present in the raw capture.
      //   Access edges: scored per edge, unit access edges. Compiler-built
      //     straight-line proximity links from a place to its nearest network
      //     vertex - NOT verified entrances and NOT walking routes. Recorded
      //     when both ends exist in the raw data; the straight line itself is
      //     a compiler claim, and asserting a walkable turn there would be
      //     inventing one.
      let endpointJoins = 0;
      let endpointJoinsVerified = 0;
      let endpointJoinsUnverified = 0;
      let accessEdges = 0;
      let accessEdgesWithRawEnds = 0;
      for (const e of path) {
        if (e.path === 'access') {
          accessEdges++;
          const endsRaw = ['from', 'to'].every((side) => {
            const node = g.nodes.find((n) => n.id === e[side])!;
            return node.features.some((id) => rawById.has(id));
          });
          if (endsRaw) accessEdgesWithRawEnds++;
          continue;
        }
        for (const side of ['from', 'to'] as const) {
          endpointJoins++;
          const node = g.nodes.find((n) => n.id === e[side])!;
          const els = node.features.map((id) => rawById.get(id)).filter((x) => x !== undefined);
          if (els.length === 0) {
            endpointJoinsUnverified++;
            console.log(`  UNVERIFIED: none of node ${node.id}'s OSM features ${node.features} are in the raw capture`);
            continue;
          }
          const ways = e.features.map((id) => rawById.get(id)).filter((x) => x !== undefined);
          if (ways.length === 0) {
            endpointJoinsUnverified++;
            console.log(`  UNVERIFIED: no raw way behind ${e.from}->${e.to}`);
            continue;
          }
          if (els.some((ely) => joinsWithin(ely!, ways))) endpointJoinsVerified++;
          else {
            endpointJoinsUnverified++;
            console.log(`  UNVERIFIED: node ${node.id} welds to none of the claimed way(s) ${e.features}`);
          }
        }
      }
      console.log(`  street-join audit (unit: endpoint joins): ${endpointJoinsVerified}/${endpointJoins} verified, ${endpointJoinsUnverified} unverified`);
      console.log(`  access-edge audit (unit: access edges): ${accessEdgesWithRawEnds}/${accessEdges} with both ends in raw-overpass.json; these are one straight-line approximation each, not entrances or walking routes. See README.md.`);
    }
  }
};

run();

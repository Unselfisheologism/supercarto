/**
 * The Jakarta-Monas example, tested offline and deterministically.
 *
 * Three guarantees, all against committed files, no network:
 *  1. the committed YAML artifacts reproduce themselves byte-for-byte from the
 *     committed capture with time-dependent inputs frozen (compile regression);
 *  2. the graph statements an agent reads — a directed path between two named
 *     places, and a documented negative case — hold when re-derived HERE with
 *     a hand-rolled parser and BFS written in this file. Expected answers are
 *     hard-coded; nothing is checked against the function that produced it;
 *  3. the capture is honest: every coordinate sits inside the recorded bbox,
 *     south of the equator (real Jakarta, not synthetic), and every retained
 *     name exists in the raw Overpass response (nothing invented).
 *
 * The artifact tests parse the saved YAML with a small substring reader rather
 * than the library emitter, so a broken emitter cannot make its own story pass.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toMaplet } from '../src/pipeline.js';
import type { GeoJsonFeatureCollection } from '../src/ingest/geojson.js';

const EXAMPLE = new URL('../examples/jakarta-monas/', import.meta.url);

const read = (name: string): string => readFileSync(new URL(name, EXAMPLE), 'utf8');
const capMeta = JSON.parse(read('capture-meta.json')) as {
  timestamp: string;
  bbox: { west: number; south: number; east: number; north: number };
  radiusM: number;
};

// --- A tiny reader for the maplet YAML subset -------------------------------

interface Parsed {
  nodes: Map<string, { name?: string; type: string }>;
  edges: Map<string, string>; // "a->b" -> body
  names: Map<string, string>; // name -> node id
}

/** Parse node and edge lines only; this is not a YAML parser. */
function parseMaplet(yaml: string): Parsed {
  const nodes = new Map<string, { name?: string; type: string }>();
  const edges = new Map<string, string>();
  let section = '';
  for (const line of yaml.split('\n')) {
    if (line.startsWith('nodes:')) { section = 'n'; continue; }
    if (line.startsWith('edges:')) { section = 'e'; continue; }
    if (line.startsWith('map:') || line.startsWith('omitted:') || line.startsWith('tools:') || line.startsWith('indoor:')) {
      section = '-'; continue;
    }
    if (section === 'n') {
      const m = line.match(/^  (n\d+): \{(.*)\}$/);
      if (!m) continue;
      const body = m[2]!;
      const type = body.match(/type: (\w+)/)?.[1] ?? '';
      const nm = body.match(/(?:^|, )name: (("[^"]*")|([^,}]+))/);
      const name = nm ? (nm[2] ?? nm[3])!.replace(/^"|"$/g, '') : undefined;
      nodes.set(m[1]!, { type, name });
    }
    if (section === 'e') {
      const m = line.match(/^  (n\d+)->(n\d+): \{.*\}$/);
      if (m) edges.set(`${m[1]}->${m[2]}`, m[0]);
    }
  }
  const names = new Map<string, string>();
  for (const [id, n] of nodes) if (n.name) names.set(n.name, id);
  return { nodes, edges, names };
}

/** Reachability over directed edges. Plain BFS, written here on purpose. */
function neighbors(parsed: Parsed, directed: boolean): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const add = (a: string, b: string) => {
    const list = adj.get(a) ?? [];
    list.push(b);
    adj.set(a, list);
  };
  for (const key of parsed.edges.keys()) {
    const [a, b] = key.split('->');
    add(a!, b!);
    if (!directed) add(b!, a!);
  }
  return adj;
}

/** Directed reachability. Directed edges only. */
function reachable(parsed: Parsed, from: string, to: string): boolean {
  if (from === to) return true;
  const adj = neighbors(parsed, true);
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of adj.get(id) ?? []) {
      if (next === to) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

/** Connected components over weak adjacency (either direction counts). */
function weakComponents(parsed: Parsed): number {
  const adj = neighbors(parsed, false);
  const seen = new Set<string>();
  let groups = 0;
  for (const id of parsed.nodes.keys()) {
    if (seen.has(id)) continue;
    groups++;
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(adj.get(cur) ?? []));
    }
  }
  return groups;
}

const y1024 = read('jakarta-monas-1024.yaml');
const y2048 = read('jakarta-monas-2048.yaml');
const p1024 = parseMaplet(y1024);
const p2048 = parseMaplet(y2048);

// --- Hard-coded expectations, derived by reading the artifacts ---------------

const PATH_NODES = ['n112', 'n8', 'n10', 'n5', 'n6', 'n7', 'n113'];
const PATH_EDGES = [
  'n112->n8', 'n8->n10', 'n10->n5', 'n5->n6', 'n6->n7', 'n7->n113',
];

describe('jakarta-monas artifacts parse and reproduce', () => {
  it('names the tested places at both budgets', () => {
    for (const p of [p1024, p2048]) {
      expect(p.names.get('Monas Barat')).toBe('n112');
      expect(p.names.get('Taman Monas')).toBe('n113');
      expect(p.names.get('Loket')).toBe('n108');
    }
  });

  it('every directed edge is mirrored in the emitted YAML', () => {
    for (const p of [p1024, p2048]) {
      for (const key of p.edges.keys()) {
        const [a, b] = key.split('->');
        expect(p.edges.has(`${b}->${a}`), `missing mirror of ${key}`).toBe(true);
      }
    }
  });

  it('character/4 estimates stay inside the budget they were cut for', () => {
    // The budget is enforced on the engine's estimate; the same rough formula
    // computed independently here must satisfy it too.
    expect(Math.ceil(y1024.length / 4)).toBeLessThanOrEqual(1024);
    expect(Math.ceil(y2048.length / 4)).toBeLessThanOrEqual(2048);
  });

  it('the 1024 artifact records what the budget dropped', () => {
    expect(y1024).toMatch(/omitted:/);
    expect(y1024).toMatch(/- \{layer: /);
  });

  it('recompiles byte-for-byte from the committed capture', () => {
    const capture = JSON.parse(read('jakarta-monas.geojson')) as GeoJsonFeatureCollection;
    for (const [budget, saved] of [[1024, y1024], [2048, y2048]] as const) {
      const result = toMaplet(capture, {
        bbox: capMeta.bbox,
        radiusLabel: `${capMeta.radiusM}m`,
        budget,
        compile: { now: new Date(capMeta.timestamp), utcOffsetMinutes: 420 },
      });
      expect(result.yaml).toBe(saved);
    }
  });
});

describe('jakarta-monas connectivity, re-derived here', () => {
  it('Monas Barat to Taman Monas: directed path exists, through the recorded nodes', () => {
    // Recorded path: park area -> nearest path vertex -> three welded sidewalk
    // chains -> park area. Asserted node-by-node against the parsed YAML.
    for (const p of [p1024, p2048]) {
      for (const n of PATH_NODES) expect(p.nodes.has(n), `node ${n} missing`).toBe(true);
      for (const key of PATH_EDGES) expect(p.edges.has(key), `edge ${key} missing`).toBe(true);
      expect(reachable(p, p.names.get('Monas Barat')!, p.names.get('Taman Monas')!)).toBe(true);
      expect(reachable(p, p.names.get('Taman Monas')!, p.names.get('Monas Barat')!)).toBe(true);
    }
  });

  it('negative: Loket to Monas Barat has no path, in either direction', () => {
    // Both budgets. The ticket booth sits on its own island (n70/n78/n82/n108);
    // its component never attaches to the Monas Barat side.
    for (const p of [p1024, p2048]) {
      const a = p.names.get('Loket')!;
      const b = p.names.get('Monas Barat')!;
      expect(reachable(p, a, b)).toBe(false);
      expect(reachable(p, b, a)).toBe(false);
    }
  });

  it('negative: an unretained place name cannot be answered', () => {
    // Never invent an answer for a name that is not in the data.
    expect(p2048.names.has('Gambir Station')).toBe(false);
    expect(p1024.names.has('Gambir Station')).toBe(false);
  });

  it('fragmentation is where the artifacts recorded it', () => {
    expect(weakComponents(p1024)).toBe(4);
    expect(weakComponents(p2048)).toBe(39);
  });
});

describe('jakarta-monas capture honesty', () => {
  const raw = JSON.parse(read('raw-overpass.json')) as {
    elements: Array<{ id: number; type: string; lat?: number; lon?: number; geometry?: Array<{ lat: number; lon: number }>; tags?: Record<string, string> }>;
  };

  it('is real Jakarta: every coordinate near the recorded bbox, south of the equator', () => {
    const { west, south, east, north } = capMeta.bbox;
    const SLACK = 0.006; // whole ways crossing the box keep vertices beyond it
    expect(north).toBeLessThan(0);
    expect(west - SLACK).toBeGreaterThan(100); // lons near 106.8, not synthetic grid values
    for (const el of raw.elements) {
      const pts = el.geometry ?? (el.lat !== undefined ? [{ lat: el.lat!, lon: el.lon! }] : []);
      for (const q of pts) {
        expect(q.lon).toBeGreaterThanOrEqual(west - SLACK);
        expect(q.lon).toBeLessThanOrEqual(east + SLACK);
        expect(q.lat).toBeGreaterThanOrEqual(south - SLACK);
        expect(q.lat).toBeLessThanOrEqual(north + SLACK);
      }
    }
  });

  it('keeps the geometry the path claims: park ways and pedestrian streets in the raw capture', () => {
    const byId = new Map(raw.elements.map((e) => [e.id as number, e]));
    for (const wid of [28216671, 628537709, 256807113, 201183596, 256807112]) {
      const el = byId.get(wid);
      expect(el, `way ${wid} missing from the capture`).toBeDefined();
      expect(el!.type).toBe('way');
      expect(el!.geometry?.length ?? 0).toBeGreaterThan(1);
      // 28216671 is the Monas Barat park polygon and 628537709 the Taman Monas
      // one; the other three are the pedestrian street segments between them.
      if (wid === 256807113 || wid === 201183596 || wid === 256807112) {
        expect(el!.tags?.highway).toBe('pedestrian');
      } else {
        expect(el!.tags?.leisure).toBe('park');
        expect(el!.tags?.name).toBeDefined();
      }
    }
  });

  it('retains no name that does not exist in the raw response', () => {
    const rawNames = new Set(raw.elements.map((e) => e.tags?.name).filter((n) => n !== undefined));
    for (const [name] of p1024.names) expect(rawNames.has(name), `invented name: ${name}`).toBe(true);
    for (const [name] of p2048.names) expect(rawNames.has(name), `invented name: ${name}`).toBe(true);
  });
});

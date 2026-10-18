import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compile } from '../src/compile/compiler.js';
import { fromGeoJson } from '../src/ingest/geojson.js';
import { articulationPoints, contractAnonymousChains } from '../src/budget/budget.js';
import { toMaplet } from '../src/pipeline.js';
import { emitGraph } from '../src/emit/yaml.js';
import type { GraphNode, GraphEdge, SpatialGraph } from '../src/compile/graph.js';
import type { GeoJsonFeatureCollection } from '../src/ingest/geojson.js';

const node = (id: string): GraphNode => ({ id, kind: 'intersection', features: [] });
const edge = (from: string, to: string, dx = 1, dy = 0): GraphEdge => ({
  from, to, dx, dy, dist: Math.hypot(dx, dy), dir: 'east', path: 'road', features: [],
});
function pair(a: string, b: string, dx = 1, dy = 0): GraphEdge[] {
  return [edge(a, b, dx, dy), { ...edge(b, a, -dx, -dy), dir: 'west' }];
}
function components(nodes: GraphNode[], edges: GraphEdge[], directed = false): Map<string, number> {
  const adj = new Map(nodes.map((n) => [n.id, [] as string[]]));
  for (const e of edges) {
    adj.get(e.from)?.push(e.to);
    if (!directed) adj.get(e.to)?.push(e.from);
  }
  const labels = new Map<string, number>();
  let count = 0;
  for (const n of nodes) {
    if (labels.has(n.id)) continue;
    const stack = [n.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (labels.has(id)) continue;
      labels.set(id, count);
      stack.push(...adj.get(id)!);
    }
    count++;
  }
  return labels;
}

const fixture = JSON.parse(readFileSync(new URL('../examples/synthetic-dense.geojson', import.meta.url), 'utf8')) as GeoJsonFeatureCollection;

describe('connectivity under a real token budget', () => {
  const original = compile(fromGeoJson(fixture));
  const labels = components(original.nodes, original.edges);

  it('compiles actual reverse endpoints and negative reverse deltas', () => {
    for (const e of original.edges) {
      expect(original.edges.some((r) => r.from === e.to && r.to === e.from
        && r.dx === -e.dx && r.dy === -e.dy)).toBe(true);
    }
  });

  for (const budget of [512, 1024, 2048, 4096]) {
    it(`splits honestly under a real token budget at ${budget} tokens`, () => {
      const r = toMaplet(fixture, { budget });
      expect(r.metrics.tokens).toBeLessThanOrEqual(budget);
      expect(r.graph.nodes.some((n) => n.name)).toBe(true);
      expect(r.graph.partial).toBe(true);
      expect(r.graph.omitted.some((o) => o.count > 0)).toBe(true);
      const after = components(r.graph.nodes, r.graph.edges);
      // The budgeter's promise, tiered (issue #3): connectivity is kept while
      // it still reaches the budget, and fragmentation is the documented
      // escape once connected pruning is exhausted - the alternative being
      // landmark deletion. Three hard invariants hold either way:
      // 1. no stranding: every retained landmark keeps access;
      // 2. no cross-merging: two nodes in the same after-component were in
      //    the same component before pruning (removals and contractions
      //    never join previously-unreachable nodes);
      // 3. mirrored edges agree: every directed statement is reversible.
      for (const a of r.graph.nodes) {
        if (a.name) {
          expect(r.graph.edges.some((e) => e.from === a.id || e.to === a.id)).toBe(true);
        }
      }
      const beforeOf = (id: string): number | undefined => labels.get(id);
      for (const a of r.graph.nodes) for (const b of r.graph.nodes) {
        if (after.get(a.id) === after.get(b.id)) {
          expect(beforeOf(a.id)).toBe(beforeOf(b.id));
        }
      }
      for (const e of r.graph.edges) {
        expect(r.graph.edges.some((r) => r.from === e.to && r.to === e.from)).toBe(true);
      }
    });
  }

  it('stays connected at a budget the connected skeleton can afford', () => {
    // At a generous budget the fit never fragments: the whole retained
    // subgraph is one component, so the older guarantee holds exactly where
    // it is affordable.
    const r = toMaplet(fixture, { budget: 8192 });
    expect(r.metrics.tokens).toBeLessThanOrEqual(8192);
    expect(r.graph.nodes.some((n) => n.name)).toBe(true);
    const after = components(r.graph.nodes, r.graph.edges);
    expect(new Set(after.values()).size).toBe(1);
  });
});

describe('articulation point oracle', () => {
  it('matches brute-force component counts for every undirected five-node graph', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'].map(node);
    const candidates: [string, string][] = [];
    for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) candidates.push([nodes[a]!.id, nodes[b]!.id]);
    for (let mask = 0; mask < 2 ** candidates.length; mask++) {
      const edges = candidates.flatMap(([a, b], i) => mask & (1 << i) ? pair(a, b) : []);
      const count = new Set(components(nodes, edges).values()).size;
      const expected = nodes.filter((n) => new Set(components(nodes.filter((x) => x.id !== n.id), edges.filter((e) => e.from !== n.id && e.to !== n.id)).values()).size > count).map((n) => n.id).sort();
      expect([...articulationPoints(nodes, edges, new Set(nodes.map((n) => n.id)))].sort()).toEqual(expected);
    }
  });
});

describe('chain contraction', () => {
  it('skips an asymmetric candidate without skipping a later valid passage', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map(node);
    const edges = [edge('a', 'b'), edge('b', 'c'), ...pair('d', 'e'), ...pair('e', 'f')];
    contractAnonymousChains(nodes, edges);
    expect(nodes.some((n) => n.id === 'b')).toBe(true);
    expect(nodes.some((n) => n.id === 'e')).toBe(false);
    expect(edges.some((e) => e.from === 'f' && e.to === 'd')).toBe(true);
  });

  it('leaves restricted or differently labelled passages explicit', () => {
    for (const change of ['blocked', 'different-path'] as const) {
      const nodes = ['a', 'b', 'c'].map(node);
      const edges = [...pair('a', 'b'), ...pair('b', 'c')];
      if (change === 'blocked') for (const e of edges) e.blocked = true;
      else edges[0]!.path = 'stairs';
      expect(contractAnonymousChains(nodes, edges)).toBe(0);
      expect(nodes).toHaveLength(3);
    }
  });

  it('does not create duplicate directed YAML edge keys around a triangle', () => {
    const nodes = ['a', 'b', 'c'].map(node);
    const edges = [...pair('a', 'b'), ...pair('b', 'c'), ...pair('a', 'c')];
    expect(contractAnonymousChains(nodes, edges)).toBe(0);
    expect(edges).toHaveLength(6);
  });

  it('preserves bent-path lengths with anisotropic scale and both directions', () => {
    const nodes = ['a', 'b', 'c', 'd'].map(node);
    const edges = [...pair('a', 'b', 3, 0), ...pair('b', 'c', 0, 4), ...pair('c', 'd', 3, 0)];
    expect(contractAnonymousChains(nodes, edges)).toBe(2);
    expect(edges).toHaveLength(2);
    for (const e of edges) expect(e.dist).toBe(10);
    const g = { nodes, edges, meta: { center: '0,0' }, omitted: [], heat: [], obstacles: [], tools: [], indoor: null } as unknown as SpatialGraph;
    const yaml = emitGraph(g, { scale: { x: 2, y: 3 }, includeIndoor: false }).yaml;
    expect(yaml.match(/dist: 24m/g)).toHaveLength(2);
    expect(edges[0]!.dx).toBe(-edges[1]!.dx);
    expect(edges[0]!.dy).toBe(-edges[1]!.dy);
  });
});

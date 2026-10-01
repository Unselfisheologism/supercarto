import { describe, expect, it } from 'vitest';
import {
  compile,
  contractAnonymousChains,
  fitToBudget,
  fromGeoJson,
  toMaplet,
  type GraphEdge,
  type GraphNode,
  type GeoJsonFeature,
  type SpatialGraph,
} from '../src/index.js';

const ENV = {
  type: 'bbox' as const,
  west: -122.42,
  south: 37.77,
  east: -122.41,
  north: 37.78,
};

function grid(size: number): GeoJsonFeature[] {
  const features: GeoJsonFeature[] = [];
  const west = -122.42;
  const south = 37.77;
  const stepLon = 0.01 / size;
  const stepLat = 0.01 / size;
  let id = 1;
  for (let i = 0; i <= size; i++) {
    features.push({
      type: 'Feature',
      id: id++,
      properties: { highway: 'primary', name: `H${i}` },
      geometry: {
        type: 'LineString',
        coordinates: [
          [west, south + stepLat * i],
          [west + 0.01, south + stepLat * i],
        ],
      },
    });
    features.push({
      type: 'Feature',
      id: id++,
      properties: { highway: 'primary', name: `V${i}` },
      geometry: {
        type: 'LineString',
        coordinates: [
          [west + stepLon * i, south],
          [west + stepLon * i, south + 0.01],
        ],
      },
    });
  }
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      features.push({
        type: 'Feature',
        id: id++,
        properties: { amenity: 'cafe', name: `Cafe ${i}-${j}` },
        geometry: {
          type: 'Point',
          // Deliberately offset from the street centreline, as real POIs are.
          coordinates: [west + stepLon * (i + 0.4), south + stepLat * (j + 0.6)],
        },
      });
    }
  }
  return features;
}

function degreesOf(graph: SpatialGraph): Map<string, number> {
  const d = new Map<string, number>();
  for (const n of graph.nodes) d.set(n.id, 0);
  for (const e of graph.edges) {
    d.set(e.from, (d.get(e.from) ?? 0) + 1);
    d.set(e.to, (d.get(e.to) ?? 0) + 1);
  }
  return d;
}

describe('landmark attachment', () => {
  it('attaches an offset POI to the network rather than leaving it an island', () => {
    const doc = fromGeoJson({ type: 'FeatureCollection', features: grid(4) }, { envelope: ENV });
    const graph = compile(doc, {});
    const degrees = degreesOf(graph);
    const named = graph.nodes.filter((n) => n.name !== undefined);
    expect(named.length).toBeGreaterThan(0);
    // Every named landmark must be reachable, or the budgeter discards it and
    // the agent gets a map with no places in it.
    for (const n of named) {
      expect(degrees.get(n.id) ?? 0).toBeGreaterThan(0);
    }
  });

  it('records the attached landmark so budgeting can see it', () => {
    const doc = fromGeoJson({ type: 'FeatureCollection', features: grid(4) }, { envelope: ENV });
    const graph = compile(doc, {});
    expect(graph.pinned.length).toBeGreaterThan(0);
  });
});

describe('budget integrity', () => {
  it('respects the budget at every size on a dense grid', () => {
    const features = grid(8);
    for (const budget of [400, 600, 800, 1024, 2048]) {
      const r = toMaplet({ type: 'FeatureCollection', features }, { bbox: ENV, budget });
      expect(r.metrics.yamlTokens).toBeLessThanOrEqual(budget);
    }
  });

  it('never leaves a dangling edge after pruning', () => {
    const features = grid(8);
    const r = toMaplet({ type: 'FeatureCollection', features }, { bbox: ENV, budget: 700 });
    const ids = new Set(r.graph.nodes.map((n) => n.id));
    for (const e of r.graph.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });

  it('keeps named landmarks connected at every budget', () => {
    const features = grid(8);
    for (const budget of [600, 1024, 2048]) {
      const r = toMaplet({ type: 'FeatureCollection', features }, { bbox: ENV, budget });
      const degrees = degreesOf(r.graph);
      const named = r.graph.nodes.filter((n) => n.name !== undefined);
      expect(named.length).toBeGreaterThan(0);
      for (const n of named) {
        // A name the agent can see but cannot route to is worse than no name.
        expect(degrees.get(n.id) ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it('always retains some connectivity at a tiny budget', () => {
    for (const budget of [128, 200, 256, 384]) {
      const r = toMaplet(
        { type: 'FeatureCollection', features: grid(8) },
        { bbox: ENV, budget },
      );
      // A map with zero edges is not a map: it advertises places the agent
      // cannot reach, and it will try to route to them.
      expect(r.graph.edges.length).toBeGreaterThan(0);
    }
  });

  it('keeps a large extract fast enough to be usable per request', () => {
    // Regression guard: an earlier implementation recomputed articulation
    // points per removal and took ~40s on a 950-node extract. This is a soft
    // ceiling, not a benchmark.
    const features = grid(14);
    const started = Date.now();
    const r = toMaplet({ type: 'FeatureCollection', features }, { bbox: ENV, budget: 1024 });
    const elapsed = Date.now() - started;
    expect(r.metrics.yamlTokens).toBeLessThanOrEqual(1024);
    expect(elapsed).toBeLessThan(5000);
  });

  it('reports omissions rather than silently truncating', () => {
    const r = toMaplet({ type: 'FeatureCollection', features: grid(8) }, { bbox: ENV, budget: 500 });
    expect(r.graph.partial).toBe(true);
    expect(r.graph.omitted.length).toBeGreaterThan(0);
    const total = r.graph.omitted.reduce((a, o) => a + o.count, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('aggregates omissions instead of one line per dropped node', () => {
    const r = toMaplet({ type: 'FeatureCollection', features: grid(8) }, { bbox: ENV, budget: 500 });
    // A per-node omission list would cost more than the map it describes.
    expect(r.graph.omitted.length).toBeLessThanOrEqual(4);
  });

  it('does not strand the network when over budget', () => {
    const features = grid(8);
    const doc = fromGeoJson({ type: 'FeatureCollection', features }, { envelope: ENV });
    const graph = compile(doc, {});
    const fitted = fitToBudget(graph, { budget: 300 });
    // The surviving graph should still have edges among its surviving nodes.
    const ids = new Set(fitted.graph.nodes.map((n) => n.id));
    const internal = fitted.graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    expect(internal.length).toBeGreaterThan(0);
  });
});

describe('chain contraction', () => {
  it('collapses a bidirectional chain to a single mirrored edge pair', () => {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 5; i++) nodes.push({ id: `n${i + 1}`, kind: 'intersection', features: [] });
    nodes[0]!.name = 'Start';
    nodes[4]!.name = 'End';
    for (let i = 0; i < 4; i++) {
      edges.push({ from: `n${i + 1}`, to: `n${i + 2}`, dist: 10, dx: 10, dy: 0, dir: 'east', features: [1] });
      edges.push({ from: `n${i + 2}`, to: `n${i + 1}`, dist: 10, dx: -10, dy: 0, dir: 'west', features: [1] });
    }
    expect(contractAnonymousChains(nodes, edges)).toBe(3);
    expect(nodes).toHaveLength(2);
    const fwd = edges.find((e) => e.from === 'n1' && e.to === 'n5');
    const rev = edges.find((e) => e.from === 'n5' && e.to === 'n1');
    expect(fwd).toBeDefined();
    expect(rev).toBeDefined();
    // The join must preserve total length and mirror the direction.
    expect(fwd!.dist).toBe(40);
    expect(rev!.dist).toBe(40);
    expect(fwd!.dir).not.toBe(rev!.dir);
  });

  it('negates the axis deltas on the reverse join so it is geometrically correct', () => {
    const nodes: GraphNode[] = [
      { id: 'a', kind: 'intersection', name: 'A', features: [] },
      { id: 'b', kind: 'intersection', features: [] },
      { id: 'c', kind: 'intersection', name: 'C', features: [] },
    ];
    const edges: GraphEdge[] = [
      { from: 'a', to: 'b', dist: 5, dx: 5, dy: 1, dir: 'east', features: [] },
      { from: 'b', to: 'a', dist: 5, dx: -5, dy: -1, dir: 'west', features: [] },
      { from: 'b', to: 'c', dist: 5, dx: 5, dy: -1, dir: 'east', features: [] },
      { from: 'c', to: 'b', dist: 5, dx: -5, dy: 1, dir: 'west', features: [] },
    ];
    contractAnonymousChains(nodes, edges);
    const fwd = edges.find((e) => e.from === 'a' && e.to === 'c')!;
    const rev = edges.find((e) => e.from === 'c' && e.to === 'a')!;
    // Signed zero: Object.is distinguishes 0 from -0, but they are the same
    // coordinate, so compare numerically.
    expect(fwd.dx).toBe(10);
    expect(fwd.dy).toBe(0);
    // The reverse must be the negated displacement, not a relabelled copy.
    expect(rev.dx).toBe(-10);
    expect(Math.abs(rev.dy)).toBe(0);
  });

  it('leaves a real junction alone', () => {
    // A four-way intersection has four incident edges, not the two of a chain.
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      nodes.push({ id, kind: 'intersection', name: id, features: [] });
    }
    for (const [x, y] of [['a', 'b'], ['b', 'c'], ['b', 'd'], ['b', 'e']]) {
      edges.push({ from: x!, to: y!, dist: 1, dx: 1, dy: 0, dir: 'east', features: [] });
      edges.push({ from: y!, to: x!, dist: 1, dx: -1, dy: 0, dir: 'west', features: [] });
    }
    expect(contractAnonymousChains(nodes, edges)).toBe(0);
    expect(nodes).toHaveLength(5);
  });
});

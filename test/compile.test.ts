import { describe, expect, it } from 'vitest';
import {
  compile,
  contractAnonymousChains,
  emitGraph,
  estimateGraphTokens,
  estimateTokens,
  fitToBudget,
  fromGeoJson,
  gridScaleFor,
  toMaplet,
  emptyIndoor,
  type GeoJsonFeature,
  type GraphEdge,
  type GraphNode,
} from '../src/index.js';

const ENV = {
  type: 'bbox' as const,
  west: -122.42,
  south: 37.77,
  east: -122.41,
  north: 37.78,
};

function line(id: number, name: string, coords: [number, number][], extra = {}) {
  return {
    type: 'Feature' as const,
    id,
    properties: { highway: 'primary', name, ...extra },
    geometry: { type: 'LineString' as const, coordinates: coords },
  };
}

function point(id: number, props: Record<string, unknown>, lon: number, lat: number): GeoJsonFeature {
  return {
    type: 'Feature',
    id,
    properties: props,
    geometry: { type: 'Point', coordinates: [lon, lat] },
  };
}

function build(features: GeoJsonFeature[]) {
  const doc = fromGeoJson({ type: 'FeatureCollection', features }, { envelope: ENV });
  return { doc, graph: compile(doc, {}) };
}

describe('compilation', () => {
  it('turns a two-vertex line into one bidirectional edge pair', () => {
    const { graph } = build([
      line(1, 'A', [
        [-122.42, 37.77],
        [-122.41, 37.77],
      ]),
    ]);
    expect(graph.edges).toHaveLength(2);
    const [fwd] = graph.edges;
    expect(fwd!.dir).toBe('east');
    expect(graph.edges[1]!.dir).toBe('west');
  });

  it('welds a shared endpoint into a single junction', () => {
    // Two lines meeting at the same point must produce one shared node, or the
    // agent sees two unconnected streets.
    const { graph } = build([
      line(1, 'A', [
        [-122.42, 37.77],
        [-122.415, 37.77],
      ]),
      line(2, 'B', [
        [-122.415, 37.77],
        [-122.41, 37.77],
      ]),
    ]);
    expect(graph.nodes).toHaveLength(3);
    const middle = graph.nodes[1]!;
    const touching = graph.edges.filter((e) => e.from === middle.id || e.to === middle.id);
    // The junction has two neighbours, so four directed edges meet there.
    expect(touching).toHaveLength(4);
  });

  it('names a point feature and records its tags', () => {
    const { graph } = build([
      point(1, { amenity: 'cafe', name: 'Blue Bottle' }, -122.415, 37.775),
    ]);
    const named = graph.nodes.find((n) => n.name === 'Blue Bottle');
    expect(named).toBeDefined();
    expect(named!.kind).toBe('poi');
    expect(named!.tags).toContain('cafe');
  });

  it('attaches a building height from a numeric property', () => {
    const { graph } = build([
      {
        type: 'Feature',
        id: 1,
        properties: { building: 'yes', name: 'Tower', height: 108 },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [-122.418, 37.778],
            [-122.417, 37.778],
            [-122.417, 37.7775],
            [-122.418, 37.7775],
          ]],
        },
      },
    ]);
    const tower = graph.nodes.find((n) => n.name === 'Tower');
    expect(tower).toBeDefined();
    expect(tower!.kind).toBe('building');
    expect(tower!.heightM).toBe(108);
  });

  it('does not turn a building footprint into a walkable cycle', () => {
    // A building ring must not become edges: that would invent a path through
    // the walls.
    const { graph } = build([
      {
        type: 'Feature',
        id: 1,
        properties: { building: 'yes' },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [-122.418, 37.778],
            [-122.417, 37.778],
            [-122.417, 37.7775],
            [-122.418, 37.7775],
          ]],
        },
      },
    ]);
    // A four-vertex ring would have produced a 4-edge cycle.
    expect(graph.edges.length).toBeLessThanOrEqual(2);
  });

  it('marks a construction edge as blocked and lists an obstacle', () => {
    const { graph } = build([
      line(1, 'Closed', [
        [-122.42, 37.775],
        [-122.41, 37.775],
      ], { highway: 'construction' }),
    ]);
    expect(graph.edges.every((e) => e.blocked)).toBe(true);
    expect(graph.obstacles.length).toBeGreaterThan(0);
    expect(graph.obstacles[0]!.blocks).toBe(true);
  });

  it('sets a crosswalk flag from a crossing property', () => {
    const { graph } = build([
      line(1, 'Crossing', [
        [-122.42, 37.775],
        [-122.41, 37.775],
      ], { highway: 'footway', crossing: 'crosswalk' }),
    ]);
    expect(graph.edges.every((e) => e.crosswalk)).toBe(true);
    expect(graph.edges[0]!.path).toBe('sidewalk');
  });

  it('records the feature ids behind each edge so it can be expanded', () => {
    const { graph } = build([
      line(42, 'A', [
        [-122.42, 37.77],
        [-122.41, 37.77],
      ]),
    ]);
    expect(graph.edges[0]!.features).toContain(42);
  });

  it('excludes classes on request', () => {
    const features = [
      line(1, 'Road', [
        [-122.42, 37.77],
        [-122.41, 37.77],
      ]),
      point(2, { amenity: 'cafe', name: 'Cafe' }, -122.415, 37.775),
    ];
    const doc = fromGeoJson({ type: 'FeatureCollection', features }, { envelope: ENV });
    const graph = compile(doc, { exclude: ['amenity.cafe'] });
    expect(graph.nodes.find((n) => n.name === 'Cafe')).toBeUndefined();
  });

  it('surfaces heat hotspots with relative intensity', () => {
    const doc = fromGeoJson({ type: 'FeatureCollection', features: [] }, { envelope: ENV });
    doc.heat.push({
      id: 1,
      name: 'crowd',
      resolution: 64,
      minValue: 0,
      maxValue: 100,
      encoding: 'sparse',
      cells: [
        { x: 100, y: 100, value: 90 },
        { x: 200, y: 200, value: 20 },
      ],
    });
    const graph = compile(doc, {});
    expect(graph.heat).toHaveLength(1);
    // Hotspots are sorted most intense first.
    expect(graph.heat[0]!.hotspots[0]!.value).toBe(90);
    expect(graph.heat[0]!.hotspots[0]!.rel).toBe(0.9);
  });

  it('translates omission records into agent-readable entries', () => {
    const doc = fromGeoJson({ type: 'FeatureCollection', features: [] }, { envelope: ENV });
    doc.layers.set(1, { id: 1, name: 'building' });
    doc.omissions.push({ layerId: 1, count: 137, centroid: { x: 2048, y: 2048 } });
    const graph = compile(doc, {});
    expect(graph.partial).toBe(true);
    expect(graph.omitted[0]).toMatchObject({ layer: 'building', count: 137 });
    expect(graph.omitted[0]!.near).not.toBe('unspecified');
  });

it('offers the tools that exist, and no ghosts', () => {
    // These assertions used to name `expand_node`, a tool that has never
    // existed. The list was hand-written and had drifted away from what the
    // server actually registers.
    const { graph } = build([]);
    expect(graph.tools).toContain('expand_feature(id)');
    expect(graph.tools).toContain('route(from,to,mode)');
    expect(graph.tools).toContain('get_maplet(lat,lon,radius,layers,budget)');
    expect(graph.tools).toContain('search_places(lat,lon,radius,query,limit)');
    // Registered but not advertised without an elevation source.
    expect(graph.tools).not.toContain('get_terrain(lat,lon,radiusM,samples)');
    // Never existed.
    expect(graph.tools.join(' ')).not.toMatch(/expand_node|get_place/);
  });
});

describe('budgeting', () => {
  /** A grid of streets: many nodes, few names, easy to over-run a budget. */
  function grid(size: number): GeoJsonFeature[] {
    const features: GeoJsonFeature[] = [];
    const west = -122.42;
    const south = 37.77;
    const stepLon = 0.01 / size;
    const stepLat = 0.01 / size;
    let id = 1;
    for (let i = 0; i <= size; i++) {
      features.push(
        line(id++, `H${i}`, [
          [west, south + stepLat * i],
          [west + 0.01, south + stepLat * i],
        ]),
      );
      features.push(
        line(id++, `V${i}`, [
          [west + stepLon * i, south],
          [west + stepLon * i, south + 0.01],
        ]),
      );
    }
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        features.push(
          point(id++, { amenity: 'cafe', name: `Cafe ${i}-${j}` },
            west + stepLon * (i + 0.5), south + stepLat * (j + 0.5)),
        );
      }
    }
    return features;
  }

  it('fits a large graph under budget and reports what it dropped', () => {
    const features = grid(8);
    const doc = fromGeoJson({ type: 'FeatureCollection', features }, { envelope: ENV });
    const graph = compile(doc, {});
    const scale = gridScaleFor(doc);
    const before = estimateTokens(emitGraph(graph, { scale }).yaml);
    expect(before).toBeGreaterThan(800);

    // The pipeline is the real contract: it verifies the emitted YAML against
    // the budget rather than trusting the cheap internal estimate.
    const r = toMaplet({ type: 'FeatureCollection', features }, { bbox: ENV, budget: 800 });
    expect(r.metrics.yamlTokens).toBeLessThanOrEqual(800);
    expect(r.graph.omitted.length).toBeGreaterThan(0);
    expect(r.graph.partial).toBe(true);
  });

  it('the internal estimate stays close to the real output', () => {
    // Guards the budgeter's calibration: if the linear estimate drifts far
    // from reality, the pipeline has to do more corrective work and the
    // reported metrics stop being trustworthy.
    const features = grid(6);
    const doc = fromGeoJson({ type: 'FeatureCollection', features }, { envelope: ENV });
    const graph = compile(doc, {});
    const actual = estimateTokens(emitGraph(graph, { scale: gridScaleFor(doc) }).yaml);
    const estimate = estimateGraphTokens(graph.nodes, graph.edges, graph);
    expect(Math.abs(actual - estimate) / actual).toBeLessThan(0.35);
  });

  it('keeps named landmarks when squeezing hard', () => {
    const features = grid(8);
    const doc = fromGeoJson({ type: 'FeatureCollection', features }, { envelope: ENV });
    const graph = compile(doc, {});
    const fitted = fitToBudget(graph, { budget: 300, minLandmarks: 5 });
    const named = fitted.graph.nodes.filter((n) => n.name !== undefined);
    // Some landmarks must survive: an agent with no names cannot navigate.
    expect(named.length).toBeGreaterThan(0);
  });

  it('leaves a small graph untouched', () => {
    const { graph } = build([
      line(1, 'A', [
        [-122.42, 37.77],
        [-122.41, 37.77],
      ]),
    ]);
    const fitted = fitToBudget(graph, { budget: 4000 });
    expect(fitted.applied).toBe(false);
    expect(fitted.graph.nodes).toHaveLength(graph.nodes.length);
  });

  it('never emits an edge pointing at a dropped node', () => {
    const features = grid(8);
    const doc = fromGeoJson({ type: 'FeatureCollection', features }, { envelope: ENV });
    const graph = compile(doc, {});
    const fitted = fitToBudget(graph, { budget: 400 });
    const ids = new Set(fitted.graph.nodes.map((n) => n.id));
    for (const e of fitted.graph.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });

  it('preserves reachability when contracting a chain', () => {
    // A chain of anonymous intersections must collapse to its two endpoints
    // while keeping a path between them.
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 5; i++) {
      nodes.push({ id: `n${i + 1}`, kind: 'intersection', features: [] });
    }
    nodes[0]!.name = 'Start';
    nodes[4]!.name = 'End';
    for (let i = 0; i < 4; i++) {
      edges.push({
        from: `n${i + 1}`,
        to: `n${i + 2}`,
        dist: 10,
        dx: 10,
        dy: 0,
        dir: 'east' as const,
        features: [1],
      });
      edges.push({
        from: `n${i + 2}`,
        to: `n${i + 1}`,
        dist: 10,
        dx: -10,
        dy: 0,
        dir: 'west' as const,
        features: [1],
      });
    }
    const removed = contractAnonymousChains(nodes, edges);
    expect(removed).toBe(3);
    expect(nodes).toHaveLength(2);
    // The joined edge must span the whole original chain.
    const fwd = edges.find((e) => e.from === 'n1' && e.to === 'n5')!;
    expect(fwd).toBeDefined();
    expect(fwd.dist).toBe(40);
  });

  it('does not contract a node the agent can name', () => {
    // Every node is named, so there is nothing to collapse even though the
    // chain is otherwise collapsible.
    const nodes: GraphNode[] = [
      { id: 'n1', kind: 'intersection', name: 'Main & 1st', features: [] },
      { id: 'n2', kind: 'intersection', name: 'Main & 2nd', features: [] },
      { id: 'n3', kind: 'intersection', name: 'End', features: [] },
    ];
    const edges: GraphEdge[] = [];
    for (const [a, b] of [['n1', 'n2'], ['n2', 'n3']] as const) {
      edges.push({ from: a, to: b, dist: 5, dx: 5, dy: 0, dir: 'east', features: [] });
      edges.push({ from: b, to: a, dist: 5, dx: -5, dy: 0, dir: 'west', features: [] });
    }
    expect(contractAnonymousChains(nodes, edges)).toBe(0);
    expect(nodes).toHaveLength(3);
  });
});

describe('emission', () => {
  it('renders distances in metres when the scale is known', () => {
    const r = toMaplet(
      {
        type: 'FeatureCollection',
        features: [
          line(1, 'A', [
            [-122.42, 37.77],
            [-122.415, 37.77],
          ]),
        ],
      },
      { bbox: { west: -122.42, south: 37.77, east: -122.41, north: 37.78 } },
    );
    expect(r.yaml).toMatch(/dist: \d+m/);
    expect(r.yaml).not.toMatch(/dist: \d+u/);
  });

  it('falls back to labelled grid units when no scale is available', () => {
    const { graph } = build([
      line(1, 'A', [
        [-122.42, 37.77],
        [-122.41, 37.77],
      ]),
    ]);
    const out = emitGraph(graph);
    expect(out.yaml).toMatch(/dist: \d+u/);
  });

  it('never prints NaN for a broken distance', () => {
    const graph = {
      meta: { center: '0, 0' },
      nodes: [{ id: 'n1', kind: 'intersection' as const, features: [] }],
      edges: [
        {
          from: 'n1',
          to: 'n1',
          dist: Number.NaN,
          dx: Number.NaN,
          dy: Number.NaN,
          dir: 'north' as const,
          features: [],
        },
      ],
      obstacles: [],
      heat: [],
      indoor: emptyIndoor(),
      omitted: [],
      tools: [],
      pinned: [],
      partial: false,
    };
    const out = emitGraph(graph);
    expect(out.yaml).not.toContain('NaN');
    expect(out.yaml).toContain('dist: unknown');
  });

  it('quotes values that YAML would otherwise misinterpret', () => {
    const graph = {
      meta: { center: '0, 0', note: 'a: b #c' },
      nodes: [{ id: 'n1', kind: 'poi' as const, name: 'Yes', features: [] }],
      edges: [],
      obstacles: [],
      heat: [],
      indoor: emptyIndoor(),
      omitted: [],
      tools: [],
      pinned: [],
      partial: false,
    };
    const out = emitGraph(graph);
    expect(out.yaml).toContain('"Yes"');
    expect(out.yaml).toContain('note: "a: b #c"');
  });

  it('includes the tools list so the agent never has to guess', () => {
    const { graph } = build([]);
    expect(emitGraph(graph).yaml).toContain('tools:');
  });
});

describe('pipeline', () => {
  it('reports metrics for the request', () => {
    const r = toMaplet(
      {
        type: 'FeatureCollection',
        features: [
          line(1, 'A', [
            [-122.42, 37.77],
            [-122.41, 37.77],
          ]),
        ],
      },
      { budget: 500 },
    );
    expect(r.metrics.budget).toBe(500);
    expect(r.metrics.wireBytes).toBeGreaterThan(0);
    expect(r.metrics.yamlTokens).toBeGreaterThan(0);
    expect(r.scr.startsWith('SCR 1')).toBe(true);
  });

  it('records layer filtering as an omission rather than silently emptying', () => {
    const r = toMaplet(
      {
        type: 'FeatureCollection',
        features: [
          line(1, 'Road', [
            [-122.42, 37.77],
            [-122.41, 37.77],
          ]),
          {
            type: 'Feature',
            id: 2,
            properties: { building: 'yes', name: 'B' },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [-122.418, 37.778],
                [-122.417, 37.778],
                [-122.417, 37.7775],
              ]],
            },
          },
        ],
      },
      { layers: ['road'], budget: 1000 },
    );
    expect(r.graph.omitted.length).toBeGreaterThan(0);
    expect(r.graph.omitted.some((o) => o.layer === 'building')).toBe(true);
  });

  it('handles an empty feature collection without throwing', () => {
    const r = toMaplet({ type: 'FeatureCollection', features: [] }, { budget: 300 });
    expect(r.yaml).toContain('nodes:');
    expect(r.metrics.nodes).toBe(0);
  });
});

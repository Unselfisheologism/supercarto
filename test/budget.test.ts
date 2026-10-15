import { describe, it, expect } from 'vitest';
import { fitToBudget } from '../src/budget/budget.js';
import { toMaplet } from '../src/index.js';
import type { SpatialGraph, GraphNode } from '../src/compile/graph.js';

/**
 * The budget is a real budget, including on edgeless maps.
 *
 * Measured on a live Tokyo fetch: 1,309 tokens delivered against a 1,024
 * budget, with zero edges. The "keep the last connections" guard compared
 * 0 - 0 < 2 for every node, so nothing was ever removable and the loop
 * exited over budget. An edgeless map has no connections to protect, so the
 * guard is vacant below 2 live edges and pruning falls through to rank.
 */
function edgeless(nodes: number, named: number): SpatialGraph {
  const list: GraphNode[] = [];
  for (let i = 0; i < nodes; i++) {
    list.push({
      id: `n${i}`,
      kind: 'poi',
      ...(i < named ? { name: `Place ${i}` } : {}),
      features: [],
    } as unknown as GraphNode);
  }
  return {
    meta: { center: '0, 0' },
    nodes: list,
    edges: [],
    heat: [],
    omitted: [],
    obstacles: [],
    indoor: null,
    tools: [],
    pinned: [],
  } as unknown as SpatialGraph;
}

describe('fitToBudget on edgeless graphs', () => {
  it('enforces the budget when there are no edges', () => {
    const r = fitToBudget(edgeless(400, 200), { budget: 1024 });
    expect(r.tokens).toBeLessThanOrEqual(1024);
    expect(r.droppedNodes).toBeGreaterThan(0);
  });

  it('keeps the landmark floor even while pruning hard', () => {
    const r = fitToBudget(edgeless(400, 200), { budget: 1024, minLandmarks: 8 });
    expect(r.graph.nodes.filter((n) => n.name !== undefined).length).toBeGreaterThanOrEqual(8);
  });

  it('leaves a fitting graph alone', () => {
    const r = fitToBudget(edgeless(10, 5), { budget: 1024 });
    expect(r.droppedNodes).toBe(0);
    expect(r.applied).toBe(false);
  });
});

describe('emitAndVerify on edgeless graphs', () => {
  // The estimate says 28 chars/node; tag-heavy lines run double that. The
  // verify loop exists to close exactly this gap, but it used to break out
  // on `edges <= 2` first - so 1,800 tokens shipped against a 1,024 budget.
  // Measured with 120 unnamed tag-heavy POIs and zero edges.
  function heavyUnnamed(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [-122.4194 + (i % 20) * 0.0005, 37.7749 + Math.floor(i / 20) * 0.0005],
      },
      properties: {
        amenity: 'toilets',
        access: 'yes',
        operator: 'San Francisco Recreation and Parks Department with a very long name indeed',
      },
    }));
  }

  function compile(features: unknown[], extra: Record<string, unknown> = {}) {
    return toMaplet(
      { type: 'FeatureCollection', features } as never,
      {
        bbox: { west: -122.425, south: 37.771, east: -122.414, north: 37.779 },
        budget: 1024,
        radiusLabel: '400m',
        ...extra,
      },
    );
  }

  it('fits unnamed edgeless maps by thinning what has no name', () => {
    const doc = compile(heavyUnnamed(120));
    expect(doc.metrics.tokens).toBeLessThanOrEqual(1024);
    expect(doc.graph.edges).toHaveLength(0);
  });

  it('drops named orphans on default requests but records them', () => {
    const feats = heavyUnnamed(120).map((f: never, i: number) =>
      i % 40 === 0
        ? { ...(f as object), properties: { amenity: 'cafe', name: `Place${i}` } }
        : f,
    );
    const doc = compile(feats);
    expect(doc.metrics.tokens).toBeLessThanOrEqual(1024);
    const landmark = doc.graph.omitted.find((o) => o.layer === 'landmark');
    expect(landmark).toBeDefined();
  });

  it('keeps named orphans on explicit POI-only requests', () => {
    const feats = heavyUnnamed(60).map((f: never) => ({
      ...(f as object),
      properties: { layer: 'poi', amenity: 'cafe', name: 'Cafe Kept' },
    }));
    const doc = compile(feats, { layers: ['poi'], ingest: { layerKey: 'layer' } });
    const named = doc.graph.nodes.filter((n) => n.name !== undefined);
    expect(named.length).toBeGreaterThan(0);
    expect(doc.metrics.tokens).toBeLessThanOrEqual(1024);
  });
});


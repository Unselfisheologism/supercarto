import { describe, it, expect } from 'vitest';
import { fitToBudget } from '../src/budget/budget.js';
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

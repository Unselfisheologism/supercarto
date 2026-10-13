import { describe, it, expect } from 'vitest';
import { fromGeoJson } from '../src/ingest/geojson.js';
import { diffDocuments, renderDiff } from '../src/diff/diff.js';
import type { GeoJsonFeatureCollection } from '../src/ingest/geojson.js';

/**
 * State diffs, benefit #5: what changed between two documents.
 *
 * An agent that moves needs `+` (entered view), `-` (left view) and `~`
 * (updated) - not the whole map again. These tests pin the computation
 * against two hand-built collections sharing an envelope (the benchmark
 * ingests both fixtures with their union bbox, which is what makes grid
 * comparison meaningful across independently ingested docs).
 */
const ENV = {
  envelope: { type: 'bbox', west: -150.02, south: 44.0, east: -150.0, north: 44.03 } as const,
  layerKey: 'layer',
};

function coll(names: string[]): GeoJsonFeatureCollection {
  // Stable ids per name: the wire matches features by id across documents, so
  // index-assigned ids would alias different cafes to the same id (and the
  // diff would correctly, confusingly, report them as changed).
  const ids: Record<string, number> = { 'Cafe A': 300, 'Cafe B': 301, 'Cafe C': 302, 'Cafe Z': 303 };
  const at: Record<string, [number, number]> = {
    'Cafe A': [-150.012, 44.01],
    'Cafe B': [-150.01, 44.01],
    'Cafe C': [-150.008, 44.01],
    'Cafe Z': [-150.012, 44.01],
  };
  return {
    type: 'FeatureCollection',
    features: names.map((name, i) => ({
      type: 'Feature',
      id: ids[name] ?? 390 + i,
      properties: { layer: 'poi', name },
      geometry: { type: 'Point', coordinates: at[name] ?? [-150.01 + i * 0.001, 44.01] },
    })),
  } as unknown as GeoJsonFeatureCollection;
}

describe('diffDocuments', () => {
  it('reports additions, removals, and nothing else for identical content', () => {
    const a = fromGeoJson(coll(['Cafe A', 'Cafe B']), ENV);
    const b = fromGeoJson(coll(['Cafe B', 'Cafe C']), ENV);
    const changes = diffDocuments(a, b);
    expect(changes).toEqual([
      { op: '-', id: 300, aspects: [] },
      { op: '+', id: 302, aspects: [] },
    ]);
  });

  it('is empty for identical documents ingested separately', () => {
    // The interning trap: layer/class/attribute ids are per-document
    // counters, so id comparison would flag every shared feature as changed.
    // Names and resolved content must compare clean.
    const a = fromGeoJson(coll(['Cafe A']), ENV);
    const b = fromGeoJson(coll(['Cafe A']), ENV);
    expect(diffDocuments(a, b)).toEqual([]);
  });

  it('flags geometry and attribute changes by aspect', () => {
    const a = fromGeoJson(coll(['Cafe A']), ENV);
    const moved = coll(['Cafe A']);
    (moved.features[0]!.geometry as any).coordinates = [-150.005, 44.015];
    const b = fromGeoJson(moved, ENV);
    expect(diffDocuments(a, b)).toEqual([{ op: '~', id: 300, aspects: ['geometry'] }]);

    const renamed = coll(['Cafe Z']);
    // Same wire id, new name: the rename path, not add+remove.
    (renamed.features[0] as any).id = 300;
    const c = fromGeoJson(renamed, ENV);
    expect(diffDocuments(a, c)).toEqual([{ op: '~', id: 300, aspects: ['attributes'] }]);
  });

  it('renders named lines from the holding document', () => {
    const a = fromGeoJson(coll(['Cafe A', 'Cafe B']), ENV);
    const b = fromGeoJson(coll(['Cafe B', 'Cafe C']), ENV);
    const text = renderDiff(diffDocuments(a, b), a, b);
    expect(text).toContain('- 300 Cafe A (poi)');
    expect(text).toContain('+ 302 Cafe C (poi)');
  });
});

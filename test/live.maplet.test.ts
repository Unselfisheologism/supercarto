import { describe, it, expect } from 'vitest';
import { SuperCarto } from '../src/index.js';
import type { GeoJsonFeature } from '../src/ingest/geojson.js';
import type { MapSource } from '../src/source/types.js';
import type { SourceRequest, SourceResult } from '../src/source/types.js';

/**
 * A connected map with places but no streets is a contradiction, not a result.
 *
 * Measured against Tokyo: 55 named places, zero edges, served with a 200 as
 * if nothing were wrong. Default requests now fail clearly; explicitly
 * POI-only requests still pass; genuinely empty maps (open ocean) still serve.
 */
class StubSource implements MapSource {
  readonly name = 'stub';
  readonly description = 'test fixture';
  constructor(private readonly features: GeoJsonFeature[] = []) {}
  async available() {
    return true;
  }
  async fetch(_req: SourceRequest): Promise<SourceResult> {
    return {
      features: this.features,
      source: this.name,
      truncated: false,
      elapsedMs: 1,
      warnings: [],
    };
  }
}

function poi(name: string, lon: number, lat: number): GeoJsonFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { name },
  } as GeoJsonFeature;
}

const SF = { lat: 37.7749, lon: -122.4194 };

describe('maplet fail-fast on streetless results', () => {
  it('refuses a default request that yields places but no streets', async () => {
    const carto = new SuperCarto({
      sources: [new StubSource([poi('Cafe', -122.4194, 37.7749), poi('Shop', -122.418, 37.775)])],
      weather: false,
    });
    await expect(carto.maplet({ ...SF, radiusM: 400, budget: 1024 })).rejects.toThrow(
      /no walkable network/,
    );
  });

  it('serves an explicitly POI-only request over the same data', async () => {
    const carto = new SuperCarto({
      sources: [new StubSource([poi('Cafe', -122.4194, 37.7749)])],
      weather: false,
    });
    const res = await carto.maplet({ ...SF, radiusM: 400, budget: 1024, layers: ['poi'] });
    expect(res.graph.nodes.length).toBeGreaterThan(0);
  });

  it('serves a genuinely empty map without throwing', async () => {
    const carto = new SuperCarto({ sources: [new StubSource([])], weather: false });
    const res = await carto.maplet({ lat: 0, lon: 0, budget: 300 });
    expect(res.graph.nodes).toHaveLength(0);
  });
});

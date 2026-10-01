import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import {
  SuperCarto,
  McpStdioServer,
  MapApiServer,
  OverpassSource,
  OsrmRouter,
  straightLineRoute,
  bboxAround,
  normalizeBbox,
  bboxAreaSqm,
  encodeBinary,
  decodeBinary,
  encodeBinaryPacked,
  decodeBinaryPacked,
  isScrBinary,
  elevationToHeat,
  featuresFromDocument,
  fromGeoJson,
  toMaplet,
  encodeDocument,
  defineTools,
  assertToolsMatchCatalog,
  type MapSource,
  type SourceRequest,
  type SourceResult,
  type ElevationSource,
} from '../src/index.js';
import type { GeoJsonFeature } from '../src/ingest/geojson.js';
import type { ElevationGrid } from '../src/source/terrain.js';
import type { BboxQuery } from '../src/source/types.js';
import {
  TOOL_CATALOG,
  advertisedTools,
  allToolNames,
  offersTool,
} from '../src/toolcatalog.js';

// --- fixtures ---------------------------------------------------------------

const SF_FEATURES: GeoJsonFeature[] = [
  {
    type: 'Feature', id: 1,
    properties: { highway: 'primary', name: 'Market St' },
    geometry: { type: 'LineString', coordinates: [[-122.4194, 37.7749], [-122.4150, 37.7749]] },
  },
  {
    type: 'Feature', id: 2,
    properties: { highway: 'secondary', name: '5th St' },
    geometry: { type: 'LineString', coordinates: [[-122.4150, 37.7749], [-122.4150, 37.7780]] },
  },
  {
    type: 'Feature', id: 3,
    properties: { amenity: 'cafe', name: 'Blue Bottle' },
    geometry: { type: 'Point', coordinates: [-122.4170, 37.7750] },
  },
  {
    type: 'Feature', id: 4,
    properties: { railway: 'subway_entrance', name: 'Powell Station' },
    geometry: { type: 'Point', coordinates: [-122.4150, 37.7748] },
  },
];

class StubSource implements MapSource {
  readonly name = 'stub';
  readonly description = 'test fixture';
  constructor(private readonly features: GeoJsonFeature[] = SF_FEATURES) {}
  async available() { return true; }
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

class FailingSource implements MapSource {
  readonly name = 'failing';
  readonly description = 'always fails';
  async available() { return true; }
  async fetch(): Promise<SourceResult> {
    throw new Error('upstream down');
  }
}

function stubCarto(features?: GeoJsonFeature[]): SuperCarto {
  return new SuperCarto({ sources: [new StubSource(features)] });
}

/**
 * A terrain source whose ground rises eastward.
 *
 * A constant-elevation grid would produce zero gradient everywhere, which is the
 * one input `slopeToHeat` cannot turn into a layer - so a test using it would
 * pass whether or not the wiring existed.
 */
class StubElevation implements ElevationSource {
  readonly name = 'stub-terrain';
  async fetch(_bbox: BboxQuery, res: number): Promise<ElevationGrid> {
    const width = res;
    const height = res;
    const values = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Rises about 100m across the box: a real hill, not noise.
        values[y * width + x] = x * 100;
      }
    }
    return {
      bbox: { west: -122.43, south: 37.76, east: -122.40, north: 37.79 },
      width,
      height,
      values,
      min: 0,
      max: (width - 1) * 100,
    };
  }
}

// --- geo helpers ------------------------------------------------------------

/**
 * Bounding box matching OVERPASS_RESPONSE's San Francisco coordinates.
 *
 * These used to be a dummy `{0,0,1,1}` box at Null Island, which was harmless
 * while out-of-area features were dropped silently. Now that a total wipeout
 * raises an error - which is the correct behaviour - the fixture and its bbox
 * have to describe the same place.
 */
const SF_BBOX = { west: -122.43, south: 37.77, east: -122.4, north: 37.79 };

// --- Overpass ---------------------------------------------------------------

describe('bboxAround', () => {
  it('produces a box that contains the requested radius', () => {
    const b = bboxAround(37.7749, -122.4194, 300);
    expect(b.west).toBeLessThan(-122.4194);
    expect(b.east).toBeGreaterThan(-122.4194);
    expect(b.south).toBeLessThan(37.7749);
    expect(b.north).toBeGreaterThan(37.7749);
  });

  it('widens the east-west axis by 1/cos(latitude)', () => {
    // This is the bug that silently drops everything outside a thin strip at
    // high latitudes, so the ratio is asserted rather than eyeballed.
    const equator = bboxAround(0, 0, 1000);
    const north = bboxAround(70, 0, 1000);
    const ew = (b: { west: number; east: number }) => b.east - b.west;
    expect(ew(north)).toBeGreaterThan(ew(equator) * 2);
  });

  it('keeps the north-south axis constant across latitude', () => {
    const a = bboxAround(0, 0, 1000);
    const b = bboxAround(70, 0, 1000);
    expect(a.north - a.south).toBeCloseTo(b.north - b.south, 4);
  });
});

describe('normalizeBbox', () => {
  it('clamps latitudes to the mercator limit', () => {
    const b = normalizeBbox({ west: 0, south: -89, east: 1, north: 89 });
    expect(b.south).toBeGreaterThanOrEqual(-85.05112878);
    expect(b.north).toBeLessThanOrEqual(85.05112878);
  });

  it('orders west before east', () => {
    const b = normalizeBbox({ west: 10, south: 0, east: 5, north: 1 });
    expect(b.west).toBeLessThanOrEqual(b.east);
  });

  it('never produces NaN at the poles', () => {
    const b = normalizeBbox({ west: 179.9, south: -90, east: -179.9, north: 90 });
    expect(Number.isFinite(b.west)).toBe(true);
    expect(Number.isFinite(b.north)).toBe(true);
  });
});

describe('bboxAreaSqm', () => {
  it('scales with radius', () => {
    const small = bboxAreaSqm(bboxAround(37.77, -122.41, 100));
    const large = bboxAreaSqm(bboxAround(37.77, -122.41, 200));
    expect(large / small).toBeCloseTo(4, 1);
  });
});

  describe('tool catalogue', () => {
  it('advertises exactly the tools the MCP server registers', async () => {
    // The maplet's `tools:` list used to be hand-written and had drifted: it
    // advertised `expand_node` and `get_place`, which have never existed, and
    // omitted `search_places`, which does. An agent following those
    // instructions calls tools that are not there.
    const carto = stubCarto();
    const registered = defineTools(carto, 8192).map((t) => t.name).sort();
    const advertised = advertisedTools(carto.capabilities).map((s) => s.split('(')[0]!).sort();

    expect(registered).toEqual(advertised);
    // A stub deployment has no terrain and no traffic credential, so neither
    // tool may be advertised.
    expect(registered).not.toContain('get_terrain');
    expect(registered).not.toContain('get_traffic');
    // And the surface must not drift from the catalogue.
    expect(() => assertToolsMatchCatalog(defineTools(carto, 8192), carto)).not.toThrow();
  });

  it('fails loudly when the server registers a tool the catalogue does not know', () => {
    // The drift this guards against: a tool added to the server but not the
    // catalogue is invisible in a maplet, so an agent is never told it exists.
    const rogue = [{ name: 'expand_node' }] as never;
    expect(() => assertToolsMatchCatalog(rogue, stubCarto())).toThrow(/absent from the catalogue/);
  });

  it('registers every catalogued tool when every capability is available', () => {
    const grid = {
      bbox: SF_BBOX,
      width: 2, height: 2,
      values: new Float32Array([0, 10, 20, 30]),
      min: 0, max: 30,
    };
    const carto = new SuperCarto({
      sources: [new StubSource([])],
      elevation: { name: 'stub-terrain', fetch: async () => grid },
      traffic: [{ name: 'stub-flow', configured: () => true, flow: async () => undefined }],
    });
    const tools = defineTools(carto, 8192);
    expect(() => assertToolsMatchCatalog(tools, carto)).not.toThrow();
    expect(tools.map((t) => t.name).sort()).toEqual(allToolNames().sort());
    expect(advertisedTools(carto.capabilities).map((s) => s.split('(')[0]!).sort())
      .toEqual(tools.map((t) => t.name).sort());
  });

  it('withholds traffic until a credential is present', () => {
    // The distinction that matters: weather works with no key, traffic never
    // does. An agent handed `get_traffic` with no flow source behind it will
    // confidently quote a free-flow ETA as if it were live.
    const withoutKey = stubCarto();
    expect(withoutKey.hasWeather).toBe(true);
    expect(withoutKey.hasTraffic).toBe(false);
    expect(advertisedTools(withoutKey.capabilities)).not.toContain('get_traffic(from,to,mode)');

    const withKey = new SuperCarto({
      sources: [new StubSource([])],
      traffic: [{ name: 'stub-flow', configured: () => true, flow: async () => undefined }],
    });
    expect(withKey.hasTraffic).toBe(true);
    expect(advertisedTools(withKey.capabilities)).toContain('get_traffic(from,to,mode)');
  });

  it('offers weather by default and can be switched off', () => {
    // Weather needs no credential, so shipping it on by default is what lets an
    // operator get correct advice about rain without configuring anything.
    expect(stubCarto().hasWeather).toBe(true);
    const off = new SuperCarto({ sources: [new StubSource([])], weather: false });
    expect(off.hasWeather).toBe(false);
    expect(advertisedTools(off.capabilities)).not.toContain('get_weather(lat,lon,hours)');
  });

  it('never advertises a tool the deployment cannot answer', () => {
    // A maplet must not tell an agent to call get_terrain when there is no
    // elevation source; the agent pays tokens to learn it cannot be helped.
    expect(advertisedTools(false)).not.toContain('get_terrain(lat,lon,radiusM,samples)');
    expect(advertisedTools(true)).toContain('get_terrain(lat,lon,radiusM,samples)');
  });

  it('lists every tool that exists and no tool that does not', () => {
    // Every capability on. `advertisedTools(true)` alone means elevation-only now
    // that there are three independently gated tools, so passing a full
    // capability object is the only way to ask "is the whole catalogue reachable".
    const lines = advertisedTools({ elevation: true, weather: true, traffic: true });
    for (const t of TOOL_CATALOG) expect(lines).toContain(t.signature);
    // No stale entries left over from the old hand-written list.
    expect(lines.join(' ')).not.toMatch(/expand_node|get_place/);
  });

  it('advertises search_places, which the old list omitted', () => {
    expect(advertisedTools(false)).toContain(
      'search_places(lat,lon,radius,query,limit)',
    );
  });

  it('tells the agent to use the feature tool for exact geometry', () => {
    // The note referenced `expand_node`, which does not exist.
    const g = toMaplet(
      { type: 'FeatureCollection', features: [] },
      { bbox: { west: -122.43, south: 37.77, east: -122.4, north: 37.79 } },
    );
    expect(g.graph.meta.note).toMatch(/expand_feature/);
    expect(g.graph.meta.note).not.toMatch(/expand_node/);
  });

  it('omits get_terrain from a graph unless told elevation exists', () => {
    const geo = {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          properties: { amenity: 'cafe', name: 'X' },
          geometry: { type: 'Point' as const, coordinates: [-122.41, 37.78] },
        },
      ],
    };
    const without = toMaplet(geo, { bbox: SF_BBOX });
    const with_ = toMaplet(geo, { bbox: SF_BBOX, hasElevation: true });
    expect(without.graph.tools).not.toContain('get_terrain(lat,lon,radiusM,samples)');
    expect(with_.graph.tools).toContain('get_terrain(lat,lon,radiusM,samples)');
  });
});

describe('OverpassSource', () => {
  const OVERPASS_RESPONSE = {
    elements: [
      { type: 'node', id: 1, lat: 37.7749, lon: -122.4194, tags: { highway: 'bus_stop' } },
      { type: 'node', id: 2, lat: 37.7749, lon: -122.4150 },
      { type: 'node', id: 3, lat: 37.7780, lon: -122.4150 },
      { type: 'node', id: 4, lat: 37.7750, lon: -122.4170, tags: { amenity: 'cafe', name: 'Blue Bottle' } },
      {
        type: 'way', id: 10,
        nodes: [2, 3],
        tags: { highway: 'primary', name: '5th St' },
      },
      {
        type: 'way', id: 11,
        nodes: [4, 3, 4],
        tags: { building: 'yes', height: '18' },
      },
      {
        type: 'way', id: 12,
        nodes: [1, 4],
        tags: { highway: 'residential' },
      },
    ],
  };

  function stubFetch(body: unknown = OVERPASS_RESPONSE) {
    return (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
  }

  it('requests the right area', async () => {
    let captured = '';
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      captured = String(init.body);
      return new Response(JSON.stringify(OVERPASS_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    const src = new OverpassSource({ fetchImpl });
    await src.fetch({
      bbox: { west: -122.42, south: 37.77, east: -122.41, north: 37.78 },
      layers: [],
      maxFeatures: 100,
    });

    // The body is form-encoded, so decode it rather than matching the escaped form.
    const decoded = new URLSearchParams(captured).get('data') ?? '';
    // The bbox must sit inside the parentheses. Written as a bracket prefix it is
    // a parse error, and Overpass reports that as an opaque 400.
    expect(decoded).toContain('(bbox:37.77,-122.42,37.78,-122.41)');
  });

  it('discards features whose coordinates lie outside the requested area', async () => {
    // Observed live: the public Overpass instance returned transposed
    // latitudes for a whole region, so a 400m request came back with places
    // 22km away. Passed through unchecked, the compiler then reports a 22km
    // edge between two bus stops that are on the same street.
    const body = {
      elements: [
        { type: 'node', id: 1, lat: 37.7750, lon: -122.4240, tags: { amenity: 'cafe', name: 'Near' } },
        { type: 'node', id: 2, lat: 37.3929, lon: -122.4224, tags: { amenity: 'cafe', name: 'Far' } },
        { type: 'node', id: 3, lat: 60.0, lon: 20.0, tags: { amenity: 'cafe', name: 'Elsewhere' } },
      ],
    };
    const src = new OverpassSource({ fetchImpl: stubFetch(body) });
    const res = await src.fetch({
      bbox: { west: -122.43, south: 37.772, east: -122.418, north: 37.781 },
      layers: [],
      maxFeatures: 100,
    });
    const names = res.features.map((f) => f.properties?.['name']);
    expect(names).toContain('Near');
    expect(names).not.toContain('Far');
    expect(names).not.toContain('Elsewhere');
    expect(res.warnings.join(' ')).toMatch(/outside the requested area/);
  });

  it('asks for a server-side cap low enough for the public instance to answer', async () => {
    // Verified live: a cap of 25,000 on a dense London bbox produced the
    // empty-200 described above, while a cap of 5,000 returned elements. The
    // limit is load-bearing, not a politeness knob.
    let decoded = '';
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      decoded = new URLSearchParams(String(init.body)).get('data') ?? '';
      return new Response(JSON.stringify(OVERPASS_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    const src = new OverpassSource({ fetchImpl });
    await src.fetch({ bbox: SF_BBOX, layers: [], maxFeatures: 50_000 });
    const cap = Number(/out (?:body|geom) qt (\d+)/.exec(decoded)?.[1]);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(5_000);
  });

  it('retries a 200-with-no-elements result instead of believing it', async () => {
    // Observed live against central London: the public instance answers a query
    // whose result set is too large for it with HTTP 200 and an empty `elements`
    // array, not with an error. Read naively that is indistinguishable from
    // "this area is empty", and the result was an empty map for the middle of
    // one of the densest cities on earth.
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      // Empty on the first two attempts, then a real result.
      if (calls < 3) return new Response(JSON.stringify({ elements: [] }), { status: 200 });
      return new Response(JSON.stringify(OVERPASS_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    const src = new OverpassSource({ fetchImpl });
    const res = await src.fetch({ bbox: SF_BBOX, layers: [], maxFeatures: 100 });
    expect(calls).toBeGreaterThan(1);
    expect(res.features.length).toBeGreaterThan(0);
    expect(res.warnings.join(' ')).toMatch(/empty result for a populated area/);
  });

  it('accepts an empty result over open ocean without retrying forever', async () => {
    // The flip side: the Southern Ocean genuinely has no data, and treating
    // that as a permanent failure would either spin the retry loop or turn an
    // honest blank into an error.
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const src = new OverpassSource({ fetchImpl, maxAttempts: 4 });
    const res = await src.fetch({
      // Far enough south to be unambiguous open ocean.
      bbox: { west: -40, south: -62, east: -30, north: -55 },
      layers: [],
      maxFeatures: 100,
    });
    // Re-asked a bounded number of times, then believed.
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(4);
    expect(res.features).toEqual([]);
  }, 20_000);

  it('errors rather than reporting an empty map when every feature is corrupt', async () => {
    // The most damaging possible answer was an empty feature list for a dense
    // city. If all the upstream coordinates are unusable, say so instead.
    const body = {
      elements: [
        // Transposed latitude, exactly as the public instance returned it for
        // London: 51.5 written as 5.5.
        { type: 'node', id: 1, lat: 5.5669273, lon: -0.1323806, tags: { amenity: 'cafe', name: 'Bad' } },
      ],
    };
    const src = new OverpassSource({ fetchImpl: stubFetch(body), maxAttempts: 1 });
    await expect(
      src.fetch({ bbox: { west: -0.14, south: 51.5, east: -0.11, north: 51.52 }, layers: [], maxFeatures: 100 }),
    ).rejects.toThrow(/outside the requested area/);
  });

  it('refuses to report an empty map when a populated area keeps coming back empty', async () => {
    // The retry budget is bounded, so a degraded instance can still return
    // nothing every time. When that happens over land, an empty graph is the
    // most misleading possible answer, so it is turned into an error that names
    // the real remedy.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ elements: [] }), { status: 200 })) as unknown as typeof fetch;

    const src = new OverpassSource({ fetchImpl });
    // Three attempts, each backing off, so this outruns the default test timeout.
    await expect(
      src.fetch({
        bbox: { west: -0.14, south: 51.5, east: -0.11, north: 51.52 },
        layers: [],
        maxFeatures: 100,
      }),
    ).rejects.toThrow(/populated area after \d+ attempts/);
  }, 20_000);

it('reports the real reason from an Overpass error page, not the licence boilerplate', async () => {
    // A 504 body opens with OpenStreetMap attribution and only then states the
    // failure. Surfacing the attribution as the explanation is useless.
    const xml = `<html><body>
      <p>The data included in this document is from www.openstreetmap.org.</p>
      <p><strong>Error</strong>: runtime error: open64: 0 Success /osm3s_temp/files/et</p>
      <p>It is made available under ODbL.</p>
    </body></html>`;
    const fetchImpl = (async () =>
      new Response(xml, { status: 504, statusText: 'Gateway Timeout' })) as unknown as typeof fetch;

    const src = new OverpassSource({ fetchImpl, maxAttempts: 1 });
    await expect(
      src.fetch({ bbox: SF_BBOX, layers: [], maxFeatures: 100 }),
    ).rejects.toThrow(/runtime error/);
  });

it('requests way geometry so streets actually have coordinates', async () => {
    // Observed live: a San Francisco maplet returned 180 named places and zero
    // edges. The query asked for ways but used `out body`, which returns only
    // vertex ids; since the query never selects those nodes, every road resolved
    // to an empty coordinate list and was thrown away. Streets are the entire
    // point of a map for an agent, so `out geom` is load-bearing.
    let decoded = '';
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      decoded = new URLSearchParams(String(init.body)).get('data') ?? '';
      return new Response(JSON.stringify(OVERPASS_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    const src = new OverpassSource({ fetchImpl });
    await src.fetch({ bbox: SF_BBOX, layers: [], maxFeatures: 100 });
    expect(decoded).toContain('out geom qt');
    expect(decoded).not.toContain('out body qt');
  });

it('keeps a road way that arrived with inline geometry', async () => {
    // The shape `out geom` actually returns: a way with its vertices inline and
    // no separately-selected nodes to resolve against.
    const body = {
      elements: [
        {
          type: 'way',
          id: 99,
          geometry: [
            { lat: 37.7750, lon: -122.4194 },
            { lat: 37.7760, lon: -122.4180 },
          ],
          tags: { highway: 'primary', name: 'Market St' },
        },
      ],
    };
    const src = new OverpassSource({ fetchImpl: stubFetch(body) });
    const res = await src.fetch({ bbox: SF_BBOX, layers: ['highway'], maxFeatures: 100 });
    const road = res.features.find((f) => f.properties?.['name'] === 'Market St');
    expect(road).toBeDefined();
    expect(road?.geometry?.type).toBe('LineString');
  });

it('retries over a smaller box when streets arrive but none are usable', async () => {
    // Observed live: past a result-size threshold the instance answers with way
    // geometry that is entirely corrupt rather than refusing. A 250m San
    // Francisco box came back with 1,408 points and zero streets, and read as a
    // city with no roads. Asking again over a smaller box recovered them.
    const boxes: Array<[number, number, number, number]> = [];
    const corrupt = {
      elements: [
        // Roads, all at the wrong latitude, exactly as upstream served them.
        { type: 'way', id: 1, geometry: [{ lat: 37.20, lon: -122.41 }, { lat: 37.21, lon: -122.42 }], tags: { highway: 'primary', name: 'Broken St' } },
        { type: 'node', id: 2, lat: 37.775, lon: -122.419, tags: { amenity: 'bench' } },
      ],
    };
    const healthy = {
      elements: [
        { type: 'way', id: 3, geometry: [{ lat: 37.7750, lon: -122.4194 }, { lat: 37.7760, lon: -122.4180 }], tags: { highway: 'primary', name: 'Market St' } },
        { type: 'node', id: 4, lat: 37.775, lon: -122.419, tags: { amenity: 'bench' } },
      ],
    };
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const q = new URLSearchParams(String(init.body)).get('data') ?? '';
      const m = /bbox:([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)/.exec(q);
      boxes.push(m
        ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
        : [0, 0, 0, 0]);
      // First request is corrupted; the smaller retry is healthy.
      return new Response(JSON.stringify(boxes.length === 1 ? corrupt : healthy), { status: 200 });
    }) as unknown as typeof fetch;

    const src = new OverpassSource({ fetchImpl });
    const res = await src.fetch({ bbox: SF_BBOX, layers: [], maxFeatures: 100 });
    expect(boxes.length).toBeGreaterThan(1);
    // The retry really did ask about a smaller area.
    const span = (b: [number, number, number, number]) => Math.max(b[2] - b[1], b[3] - b[0]);
    expect(span(boxes[1]!)).toBeLessThan(span(boxes[0]!));
    const road = res.features.find((f) => f.properties?.name === 'Market St');
    expect(road).toBeDefined();
    expect(res.warnings.join(' ')).toMatch(/no usable street geometry/);
  });

  it('does not shrink the box when the response contained no ways at all', async () => {
    // A points-only response has not proved anything is wrong upstream, so
    // re-asking it would just spend shared quota to learn the same thing.
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ elements: [{ type: 'node', id: 1, lat: 37.775, lon: -122.419, tags: { amenity: 'bench' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const src = new OverpassSource({ fetchImpl });
    const res = await src.fetch({ bbox: SF_BBOX, layers: [], maxFeatures: 100 });
    expect(calls).toBe(1);
    expect(res.features.length).toBe(1);
  });

  it('keeps a road whose single stray vertex is out of range', async () => {
    // One corrupt vertex used to discard the entire street, which is how every
    // road in San Francisco disappeared while picnic tables survived.
    const body = {
      elements: [
        {
          type: 'way',
          id: 50,
          geometry: [
            { lat: 37.7750, lon: -122.4194 },
            { lat: 37.7760, lon: -122.4180 },
            { lat: 37.7770, lon: -122.4160 },
            { lat: 37.2000, lon: -122.4100 },
            { lat: 37.7780, lon: -122.4140 },
          ],
          tags: { highway: 'residential', name: 'Mostly Fine St' },
        },
      ],
    };
    const src = new OverpassSource({ fetchImpl: stubFetch(body) });
    const res = await src.fetch({ bbox: SF_BBOX, layers: ['highway'], maxFeatures: 100 });
    const road = res.features.find((f) => f.properties?.name === 'Mostly Fine St');
    expect(road).toBeDefined();
    // The corrupt vertex is not carried through into the graph.
    const kept = (road?.geometry as { coordinates: number[][] }).coordinates;
    expect(kept.every(([lon, lat]) => lat! > 37.7 && lat! < 37.8)).toBe(true);
  });

  it('rejects a way whose vertices are all out of range', async () => {
    // The counterpart: a majority rule must not resurrect genuinely corrupt data.
    const body = {
      elements: [
        {
          type: 'way',
          id: 51,
          geometry: [
            { lat: 37.2000, lon: -122.4100 },
            { lat: 37.2100, lon: -122.4200 },
            { lat: 37.2200, lon: -122.4300 },
          ],
          tags: { highway: 'residential', name: 'Wholly Corrupt St' },
        },
      ],
    };
    const src = new OverpassSource({ fetchImpl: stubFetch(body), maxAttempts: 1 });
    await expect(
      src.fetch({ bbox: SF_BBOX, layers: ['highway'], maxFeatures: 100 }),
    ).rejects.toThrow(/outside the requested area/);
  });

  it('does not admit a distant place just because the tolerance has a floor', async () => {
    // Observed live: a 350m San Francisco request reported bus stops 1.6km away,
    // wired to intersections with 1.6km "access" edges. The cause was a fixed
    // 0.05-degree slack - 5.5km of latitude - applied to every request
    // regardless of its size. A tolerance floor must not exceed what a road
    // leaving the request area actually needs.
    const tiny = { west: -122.4230, south: 37.7730, east: -122.4160, north: 37.7770 };
    const body = {
      elements: [
        { type: 'node', id: 1, lat: 37.7750, lon: -122.4194, tags: { amenity: 'cafe', name: 'Inside' } },
        // ~1.6km north-east of the request.
        { type: 'node', id: 2, lat: 37.7896, lon: -122.4024, tags: { highway: 'bus_stop', name: 'Far Away' } },
      ],
    };
    const src = new OverpassSource({ fetchImpl: stubFetch(body) });
    const res = await src.fetch({ bbox: tiny, layers: ['amenity'], maxFeatures: 100 });
    const names = res.features.map((f) => f.properties?.name);
    expect(names).toContain('Inside');
    expect(names).not.toContain('Far Away');
  });

  it('serves the best partial map when later attempts fail', async () => {
    // Observed live: a request that got a usable map, then hit a busy server on
    // every retry, used to throw away the good result and report a bare
    // "exhausted retries". A real map beats a tidy error.
    let calls = 0;
    const corrupt = {
      elements: [
        { type: 'way', id: 1, geometry: [{ lat: 37.20, lon: -122.41 }, { lat: 37.21, lon: -122.42 }], tags: { highway: 'primary', name: 'Broken St' } },
        { type: 'node', id: 2, lat: 37.775, lon: -122.419, tags: { amenity: 'cafe', name: 'Blue Bottle' } },
      ],
    };
    const fetchImpl = (async () => {
      calls++;
      // First attempt yields a map but triggers a shrink; the rest hit a busy
      // server, so the loop can never improve on what it already has.
      if (calls === 1) return new Response(JSON.stringify(corrupt), { status: 200 });
      return new Response('busy', { status: 504, statusText: 'Gateway Timeout' });
    }) as unknown as typeof fetch;

    const src = new OverpassSource({ fetchImpl, maxAttempts: 3 });
    const res = await src.fetch({ bbox: SF_BBOX, layers: [], maxFeatures: 100 });
    expect(calls).toBeGreaterThan(1);
    expect(res.features.length).toBeGreaterThan(0);
    expect(res.features.some((f) => f.properties?.name === 'Blue Bottle')).toBe(true);
    expect(res.warnings.join(' ')).toMatch(/best result obtained/);
  });

  it('surfaces the underlying failure when nothing was ever usable', async () => {
    // The counterpart: with no data to fall back on, the caller must still be
    // told what actually went wrong.
    const fetchImpl = (async () =>
      new Response('busy', { status: 504, statusText: 'Gateway Timeout' })) as unknown as typeof fetch;

    const src = new OverpassSource({ fetchImpl, maxAttempts: 1 });
    await expect(
      src.fetch({ bbox: SF_BBOX, layers: [], maxFeatures: 100 }),
    ).rejects.toThrow(/504/);
  });

  it('keeps a way that merely straddles the edge of the request', async () => {
    // Ways legitimately extend past a bbox edge, so the tolerance must admit
    // them while still rejecting data that is genuinely elsewhere.
    const body = {
      elements: [
        { type: 'node', id: 1, lat: 37.7800, lon: -122.4240 },
        { type: 'node', id: 2, lat: 37.7730, lon: -122.4240 },
        { type: 'way', id: 9, nodes: [1, 2], tags: { highway: 'primary' } },
      ],
    };
    const src = new OverpassSource({ fetchImpl: stubFetch(body) });
    const res = await src.fetch({
      bbox: { west: -122.43, south: 37.772, east: -122.418, north: 37.781 },
      layers: [],
      maxFeatures: 100,
    });
    expect(res.features.length).toBeGreaterThan(0);
  });

  it('requests highways by subtype, not as a bare match', () => {
    // A bare `[highway]` matches every traffic signal and crossing in the area.
    // Those are street furniture, not places, and each would become an anonymous
    // junction crowding out the landmarks.
    let decoded = '';
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      decoded = new URLSearchParams(String(init.body)).get('data') ?? '';
      return new Response(JSON.stringify(OVERPASS_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    const src = new OverpassSource({ fetchImpl });
    src.fetch({ bbox: SF_BBOX, layers: ['highway'], maxFeatures: 10 });
    expect(decoded).toContain('[highway=primary]');
    expect(decoded).not.toContain('[highway][');
  });

  it('excludes micro-pathways, which time out on the public instance', () => {
    let decoded = '';
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      decoded = new URLSearchParams(String(init.body)).get('data') ?? '';
      return new Response(JSON.stringify(OVERPASS_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    const src = new OverpassSource({ fetchImpl });
    src.fetch({ bbox: SF_BBOX, layers: ['amenity'], maxFeatures: 10 });
    expect(decoded).toContain('footway');
  });

  it('shrinks the query and retries when the server refuses it', async () => {
    // A query that is too heavy comes back as a 504, not a 400. Retrying with
    // fewer layers is what turns a failure into a partial map.
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      if (call === 1) {
        return new Response('<p><strong>Error</strong>: dispatcher timeout</p>', { status: 504 });
      }
      return new Response(JSON.stringify(OVERPASS_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    const src = new OverpassSource({ fetchImpl });
    const res = await src.fetch({
      bbox: { west: -122.42, south: 37.77, east: -122.41, north: 37.78 },
      layers: [],
      maxFeatures: 100,
    });
    expect(call).toBe(2);
    expect(res.features.length).toBeGreaterThan(0);
    expect(res.warnings.join(' ')).toMatch(/refused the full query/);
  });

  it('does not retry a malformed query, which cannot be fixed by shrinking', async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      return new Response('<p><strong>Error</strong>: parse error</p>', { status: 400 });
    }) as unknown as typeof fetch;

    const src = new OverpassSource({ fetchImpl });
    await expect(
      src.fetch({ bbox: SF_BBOX, layers: [], maxFeatures: 10 }),
    ).rejects.toThrow(/parse error/);
    expect(call).toBe(1);
  });

  it('sends a User-Agent, which the public instance requires', async () => {
    // Apache answers 406 to any Overpass request without one, and the failure
    // looks like a malformed query rather than a missing header.
    let ua = '';
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      ua = new Headers(init.headers).get('user-agent') ?? '';
      return new Response(JSON.stringify(OVERPASS_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    const src = new OverpassSource({ fetchImpl });
    await src.fetch({ bbox: SF_BBOX, layers: [], maxFeatures: 10 });
    expect(ua).toMatch(/supercarto/);
  });

  it('requests ways as well as nodes, so the city has streets in it', async () => {
    // Points of interest are nodes; roads, buildings and parks are ways. Asking
    // only for nodes returns a city with no streets.
    let decoded = '';
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      decoded = new URLSearchParams(String(init.body)).get('data') ?? '';
      return new Response(JSON.stringify(OVERPASS_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    const src = new OverpassSource({ fetchImpl });
    await src.fetch({ bbox: SF_BBOX, layers: [], maxFeatures: 10 });
    expect(decoded).toContain('way(bbox:');
  });

  it('surfaces Overpass XML errors instead of a JSON syntax error', async () => {
    // Rate limiting comes back as an XML document with a 4xx status. Parsing it
    // as JSON throws an opaque SyntaxError and hides the real cause.
    const xml = '<html><body><p><strong>Error</strong>: too many requests</p></body></html>';
    const fetchImpl = (async () =>
      new Response(xml, { status: 429, statusText: 'Too Many Requests' })) as unknown as typeof fetch;

    // maxAttempts 1: this asserts the error surfaces, not the retry policy.
    const src = new OverpassSource({ fetchImpl, maxAttempts: 1 });
    await expect(
      src.fetch({ bbox: SF_BBOX, layers: [], maxFeatures: 10 }),
    ).rejects.toThrow(/too many requests/);
  });

  it('turns tagged nodes into point features', async () => {
    const src = new OverpassSource({ fetchImpl: stubFetch() });
    const res = await src.fetch({
      bbox: { west: -122.42, south: 37.77, east: -122.41, north: 37.78 },
      layers: [],
      maxFeatures: 100,
    });
    const cafe = res.features.find((f) => f.properties?.name === 'Blue Bottle');
    expect(cafe).toBeDefined();
    expect(cafe!.geometry!.type).toBe('Point');
  });

  it('skips untagged nodes, which are way vertices rather than places', async () => {
    const src = new OverpassSource({ fetchImpl: stubFetch() });
    const res = await src.fetch({
      bbox: { west: -122.42, south: 37.77, east: -122.41, north: 37.78 },
      layers: [],
      maxFeatures: 100,
    });
    expect(res.features.find((f) => f.id === 2)).toBeUndefined();
  });

  it('resolves way geometry from node coordinates', async () => {
    const src = new OverpassSource({ fetchImpl: stubFetch() });
    const res = await src.fetch({
      bbox: { west: -122.42, south: 37.77, east: -122.41, north: 37.78 },
      layers: [],
      maxFeatures: 100,
    });
    const way = res.features.find((f) => f.id === 10);
    expect(way).toBeDefined();
    expect(way!.geometry!.type).toBe('LineString');
    expect(way!.geometry!.coordinates).toHaveLength(2);
  });

  it('treats a closed building way as a polygon', async () => {
    const src = new OverpassSource({ fetchImpl: stubFetch() });
    const res = await src.fetch({
      bbox: { west: -122.42, south: 37.77, east: -122.41, north: 37.78 },
      layers: [],
      maxFeatures: 100,
    });
    const building = res.features.find((f) => f.id === 11);
    expect(building!.geometry!.type).toBe('Polygon');
  });

  it('does not treat a closed highway as an area', async () => {
    // A roundabout is a closed way with `highway`, which is a road loop, not a
    // polygon. Classifying it as an area would give an agent a walkable blob.
    const body = {
      elements: [
        { type: 'node', id: 1, lat: 1, lon: 1 },
        { type: 'node', id: 2, lat: 1, lon: 2 },
        { type: 'node', id: 3, lat: 2, lon: 2 },
        { type: 'way', id: 9, nodes: [1, 2, 3, 1], tags: { highway: 'primary' } },
      ],
    };
    const src = new OverpassSource({ fetchImpl: stubFetch(body) });
    const res = await src.fetch({
      bbox: { west: 0, south: 0, east: 3, north: 3 },
      layers: [],
      maxFeatures: 10,
    });
    expect(res.features[0]!.geometry!.type).toBe('LineString');
  });

  it('reports truncation so a caller knows the area is not exhausted', async () => {
    const src = new OverpassSource({ fetchImpl: stubFetch() });
    const res = await src.fetch({
      bbox: { west: -122.42, south: 37.77, east: -122.41, north: 37.78 },
      layers: [],
      maxFeatures: 2,
    });
    expect(res.truncated).toBe(true);
    expect(res.warnings.join(' ')).toMatch(/truncated/);
  });

  it('surfaces an HTTP error rather than returning nothing', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 504, statusText: 'Gateway Timeout' })) as unknown as typeof fetch;
    const src = new OverpassSource({ fetchImpl, maxAttempts: 1 });
    await expect(
      src.fetch({ bbox: SF_BBOX, layers: [], maxFeatures: 10 }),
    ).rejects.toThrow(/504/);
  });

  it('warns about unresolved relations instead of dropping them silently', async () => {
    const body = {
      elements: [
        {
          type: 'relation', id: 5,
          members: [],
          tags: { natural: 'water', name: 'Round Lake' },
        },
      ],
    };
    const src = new OverpassSource({ fetchImpl: stubFetch(body) });
    const res = await src.fetch({
      bbox: SF_BBOX,
      layers: [],
      maxFeatures: 10,
    });
    expect(res.warnings.join(' ')).toMatch(/relation 5/);
  });
});

// --- routing ----------------------------------------------------------------

describe('OsrmRouter', () => {
  const OSRM_RESPONSE = {
    code: 'Ok',
    routes: [
      {
        distance: 842.5,
        duration: 610.2,
        geometry: { coordinates: [[-122.419, 37.774], [-122.415, 37.775]] },
        legs: [
          {
            steps: [
              { distance: 10, maneuver: { type: 'depart', modifier: 'left' }, name: 'Mission St' },
              { distance: 120, maneuver: { type: 'turn', modifier: 'right', bearing_after: 90 }, name: '5th St' },
              { distance: 300, maneuver: { type: 'continue', modifier: 'straight' }, name: '5th St' },
              { distance: 5, maneuver: { type: 'arrive' }, name: '5th St' },
            ],
          },
        ],
      },
    ],
  };

  function stubFetch(body: unknown = OSRM_RESPONSE, status = 200) {
    return (async () =>
      new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  }

  const req = {
    from: { lat: 37.7749, lon: -122.4194 },
    to: { lat: 37.7755, lon: -122.4150 },
    mode: 'walk' as const,
  };

  it('maps an OSRM route onto SCR route records', async () => {
    const r = await new OsrmRouter({ fetchImpl: stubFetch() }).route(req);
    expect(r.route.dist).toBe(843);
    expect(r.route.time).toBe(610);
    expect(r.route.mode).toBe('walk');
    expect(r.route.steps.length).toBeGreaterThan(0);
  });

  it('renders maneuvers as prose, not enums', async () => {
    const r = await new OsrmRouter({ fetchImpl: stubFetch() }).route(req);
    const text = r.route.steps.map((s) => s.instruction).join(' | ');
    expect(text).toContain('head onto Mission St');
    expect(text).toContain('turn right onto 5th St');
    expect(text).toContain('arrive');
  });

  it('drops maneuvers that carry no information', async () => {
    // A "continue" on an unnamed way tells the agent nothing, and keeping every
    // one would triple the step count for no gain.
    const r = await new OsrmRouter({ fetchImpl: stubFetch() }).route(req);
    expect(r.route.steps.every((s) => s.instruction.length > 0)).toBe(true);
  });

  it('uses the profile matching the travel mode', async () => {
    let url = '';
    const fetchImpl = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify(OSRM_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;
    await new OsrmRouter({ fetchImpl }).route({ ...req, mode: 'drive' });
    expect(url).toContain('/driving/');
    await new OsrmRouter({ fetchImpl }).route({ ...req, mode: 'bike' });
    expect(url).toContain('/bike/');
  });

  it('throws when no route exists, so the caller can fall back', async () => {
    const fetchImpl = stubFetch({ code: 'NoRoute', routes: [] });
    await expect(new OsrmRouter({ fetchImpl }).route(req)).rejects.toThrow(/no route/i);
  });

  it('keeps full geometry for code even though the model never sees it', async () => {
    const r = await new OsrmRouter({ fetchImpl: stubFetch() }).route(req);
    expect(r.geometry).toHaveLength(2);
  });
});

describe('straightLineRoute', () => {
  const a = { lat: 37.7749, lon: -122.4194 };
  const b = { lat: 37.7849, lon: -122.4194 };

  it('reports a plausible distance for a 1km north-south span', () => {
    const r = straightLineRoute(a, b, 'walk');
    expect(r.route.dist).toBeGreaterThan(1000);
    expect(r.route.dist).toBeLessThan(1150);
  });

  it('labels itself as an approximation', () => {
    // An agent that believes it has real turn instructions will confidently
    // send someone the wrong way.
    const r = straightLineRoute(a, b);
    expect(r.route.mode).toMatch(/approx/);
    expect(r.route.steps[0]!.instruction).toMatch(/approx/);
  });

  it('produces a different duration per mode', () => {
    const walk = straightLineRoute(a, b, 'walk').route.time!;
    const drive = straightLineRoute(a, b, 'drive').route.time!;
    expect(drive).toBeLessThan(walk);
  });
});

describe('SuperCarto.route', () => {
  const from = { lat: 37.7749, lon: -122.4194 };
  const to = { lat: 37.7849, lon: -122.4194 };

  it('falls back to an approximation when the engine fails', async () => {
    const failing = {
      name: 'dead',
      route: async () => { throw new Error('connection refused'); },
    };
    const carto = new SuperCarto({ sources: [new StubSource()], router: failing });
    const res = await carto.route({ from, to });
    expect(res.source).toBe('straight-line');
    expect(res.route.mode).toMatch(/approx/);
  });
});

// --- live maplet ------------------------------------------------------------

describe('SuperCarto.maplet', () => {
  it('returns an agent-ready graph for any coordinates', async () => {
    const carto = stubCarto();
    const res = await carto.maplet({ lat: 37.7749, lon: -122.4194, radiusM: 400, budget: 800 });
    expect(res.yaml).toContain('map:');
    expect(res.yaml).toContain('nodes:');
    expect(res.yaml).toContain('edges:');
    expect(res.graph.nodes.length).toBeGreaterThan(0);
  });

  it('respects the token budget', async () => {
    const carto = stubCarto();
    for (const budget of [300, 600, 1200]) {
      const res = await carto.maplet({ lat: 37.7749, lon: -122.4194, budget });
      expect(res.metrics.yamlTokens).toBeLessThanOrEqual(budget);
    }
  });

  it('names the source it used', async () => {
    const res = await stubCarto().maplet({ lat: 37.7749, lon: -122.4194 });
    expect(res.fetchedFrom).toBe('stub');
  });

  it('derives a slope layer when a terrain source is configured', async () => {
    // The option's docstring promised slope heat and the code only ever derived
    // density. This is the test that would have caught that, and it needs a
    // terrain grid with a real gradient: a flat one yields no slope layer and
    // the assertion would pass or fail for the wrong reason.
    const carto = new SuperCarto({
      sources: [new StubSource()],
      elevation: new StubElevation(),
    });
    const res = await carto.maplet({
      lat: 37.7749, lon: -122.4194, radiusM: 400, budget: 3000,
    });
    expect(res.graph.heat.map((h) => h.name)).toContain('slope');
    expect(res.yaml).toContain('slope');
  });
  it('still returns a maplet when the terrain fetch fails', async () => {
    // Terrain is an enrichment. Losing it must not cost the agent the topology
    // it actually asked for.
    const brokenTerrain: ElevationSource = {
      name: 'broken',
      fetch: async () => { throw new Error('terrain down'); },
    };
    const carto = new SuperCarto({ sources: [new StubSource()], elevation: brokenTerrain });
    const res = await carto.maplet({ lat: 37.7749, lon: -122.4194, budget: 800 });
    expect(res.graph.nodes.length).toBeGreaterThan(0);
    expect(res.graph.heat.map((h) => h.name)).not.toContain('slope');
  });

  it('derives no slope layer without a terrain source', async () => {
    // The capability must not be advertised from nowhere.
    const res = await stubCarto().maplet({ lat: 37.7749, lon: -122.4194, budget: 3000 });
    expect(res.graph.heat.map((h) => h.name)).not.toContain('slope');
  });

  it('caches repeat requests for the same area', async () => {
    let calls = 0;
    const counting: MapSource = {
      name: 'counting',
      description: '',
      available: async () => true,
      fetch: async () => {
        calls++;
        return {
          features: SF_FEATURES, source: 'counting',
          truncated: false, elapsedMs: 1, warnings: [],
        };
      },
    };
    const carto = new SuperCarto({ sources: [counting] });
    await carto.maplet({ lat: 37.7749, lon: -122.4194, radiusM: 300 });
    await carto.maplet({ lat: 37.7749, lon: -122.4194, radiusM: 300 });
    expect(calls).toBe(1);
    expect(carto.cacheSize).toBe(1);
  });

  it('does not reuse a cached area for a different radius', async () => {
    let calls = 0;
    const counting: MapSource = {
      name: 'counting',
      description: '',
      available: async () => true,
      fetch: async () => {
        calls++;
        return {
          features: SF_FEATURES, source: 'counting',
          truncated: false, elapsedMs: 1, warnings: [],
        };
      },
    };
    const carto = new SuperCarto({ sources: [counting] });
    await carto.maplet({ lat: 37.7749, lon: -122.4194, radiusM: 300 });
    await carto.maplet({ lat: 37.7749, lon: -122.4194, radiusM: 900 });
    expect(calls).toBe(2);
  });

  it('tries the next source when one fails', async () => {
    const carto = new SuperCarto({ sources: [new FailingSource(), new StubSource()] });
    const res = await carto.maplet({ lat: 37.7749, lon: -122.4194 });
    expect(res.fetchedFrom).toBe('stub');
  });

  it('reports an error when no source can serve', async () => {
    const carto = new SuperCarto({ sources: [new FailingSource()] });
    await expect(carto.maplet({ lat: 0, lon: 0 })).rejects.toThrow(/no source/);
  });

  it('emits SCR text for an area', async () => {
    const text = await stubCarto().scr({ west: -122.42, south: 37.77, east: -122.41, north: 37.78 });
    expect(text.startsWith('SCR 1')).toBe(true);
  });

  it('handles an empty area without throwing', async () => {
    const carto = stubCarto([]);
    const res = await carto.maplet({ lat: 0, lon: 0, budget: 300 });
    expect(res.yaml).toContain('nodes:');
    expect(res.graph.nodes).toHaveLength(0);
  });
});

// --- document recovery ------------------------------------------------------

describe('featuresFromDocument', () => {
  it('recovers GeoJSON from a compiled document', () => {
    const gj = { type: 'FeatureCollection' as const, features: SF_FEATURES };
    const doc = fromGeoJson(gj);
    const back = featuresFromDocument(doc);
    expect(back).toHaveLength(SF_FEATURES.length);
    const line = back.find((f) => f.geometry?.type === 'LineString');
    expect(line).toBeDefined();
    expect(line!.properties).toHaveProperty('name');
  });

  it('recovers point coordinates in WGS84', () => {
    const doc = fromGeoJson({ type: 'FeatureCollection', features: SF_FEATURES });
    const back = featuresFromDocument(doc);
    const cafe = back.find((f) => f.properties?.['name'] === 'Blue Bottle');
    const [lon, lat] = (cafe!.geometry! as { coordinates: number[] }).coordinates;
    expect(lat).toBeCloseTo(37.7750, 4);
    expect(lon).toBeCloseTo(-122.4170, 4);
  });
});

// --- binary -----------------------------------------------------------------

describe('SCR binary codec', () => {
  const gj = { type: 'FeatureCollection' as const, features: SF_FEATURES };

  it('round-trips geometry exactly', () => {
    const doc = fromGeoJson(gj);
    const back = decodeBinary(encodeBinary(doc));
    expect(back.features).toHaveLength(doc.features.length);
    expect(JSON.stringify(back.features.map((f) => f.geometry)))
      .toBe(JSON.stringify(doc.features.map((f) => f.geometry)));
  });

  it('round-trips the envelope, strings, classes and attribute sets', () => {
    const doc = fromGeoJson(gj);
    const back = decodeBinary(encodeBinary(doc));
    expect(back.envelope).toEqual(doc.envelope);
    expect(back.extent).toBe(doc.extent);
    expect([...back.strings]).toEqual([...doc.strings]);
    expect([...back.classes].map(([, c]) => c.name).sort())
      .toEqual([...doc.classes.values()].map((c) => c.name).sort());
    expect(back.attrSets.size).toBe(doc.attrSets.size);
  });

  it('is smaller than the text form', () => {
    const doc = fromGeoJson(gj);
    const text = Buffer.byteLength(encodeDocument(doc, { group: false }));
    const bin = encodeBinary(doc).length;
    expect(bin).toBeLessThan(text);
  });

  it('rejects a payload with the wrong magic', () => {
    const bad = new Uint8Array(16);
    expect(() => decodeBinary(bad)).toThrow(/magic/);
  });

  it('round-trips negative coordinate deltas', () => {
    const doc = fromGeoJson({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { highway: 'primary' },
        geometry: {
          type: 'LineString',
          coordinates: [[-122.42, 37.78], [-122.41, 37.77], [-122.40, 37.76]],
        },
      }],
    });
    const back = decodeBinary(encodeBinary(doc));
    expect(JSON.stringify(back.features[0]!.geometry))
      .toBe(JSON.stringify(doc.features[0]!.geometry));
  });
});

describe('SCR compression', () => {
  const doc = fromGeoJson({ type: 'FeatureCollection', features: SF_FEATURES });

  for (const codec of ['raw', 'gzip', 'brotli'] as const) {
    it(`round-trips through ${codec}`, () => {
      const back = decodeBinaryPacked(encodeBinaryPacked(doc, { codec }));
      expect(JSON.stringify(back.features.map((f) => f.geometry)))
        .toBe(JSON.stringify(doc.features.map((f) => f.geometry)));
    });
  }

  it('compresses the text form', () => {
    const text = Buffer.byteLength(encodeDocument(doc, { group: false }));
    const packed = encodeBinaryPacked(doc, { codec: 'brotli' }).length;
    expect(packed).toBeLessThan(text);
  });

  it('identifies its own payloads', () => {
    const bytes = encodeBinaryPacked(doc, { codec: 'gzip' });
    expect(isScrBinary(bytes)).toBe(true);
    expect(isScrBinary(new TextEncoder().encode('SCR 1\n'))).toBe(false);
  });

  it('rejects a truncated payload with a clear message', () => {
    const bytes = encodeBinaryPacked(doc, { codec: 'raw' });
    const cut = bytes.slice(0, bytes.length - 10);
    expect(() => decodeBinaryPacked(cut)).toThrow(/truncated|short/);
  });
});

// --- terrain ----------------------------------------------------------------

describe('elevationToHeat', () => {
  it('turns a grid into a sparse heat layer', () => {
    const grid = {
      bbox: SF_BBOX,
      width: 4, height: 4,
      values: new Float32Array([
        0, 10, 20, 30,
        0, 10, 20, 30,
        0, 10, 20, 30,
        100, 10, 20, 30,
      ]),
      min: 0, max: 100,
    };
    const heat = elevationToHeat(grid);
    expect(heat.name).toBe('elevation');
    expect(heat.encoding).toBe('sparse');
    expect(heat.minValue).toBe(0);
    expect(heat.maxValue).toBe(100);
    expect(heat.cells!.length).toBeGreaterThan(0);
    expect(heat.cells!.some((c) => c.value === 100)).toBe(true);
  });

  it('subsamples rather than emitting every cell', () => {
    const grid = {
      bbox: SF_BBOX,
      width: 64, height: 64,
      values: new Float32Array(64 * 64).fill(5),
      min: 5, max: 5,
    };
    const heat = elevationToHeat(grid);
    expect(heat.cells!.length).toBeLessThan(64 * 64);
  });
});

// --- MCP server -------------------------------------------------------------

describe('McpStdioServer', () => {
  function server() {
    const lines: string[] = [];
    const s = new McpStdioServer({
      carto: stubCarto(),
      write: (l) => lines.push(l),
    });
    return { s, lines };
  }

  async function call(s: McpStdioServer, req: unknown): Promise<any> {
    const res = await s.handle(req as never);
    return res;
  }

  it('answers initialize with server info', async () => {
    const { s } = server();
    const res = await call(s, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(res.result.serverInfo.name).toBe('supercarto');
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it('returns null for notifications, so strict clients are not confused', async () => {
    const { s } = server();
    expect(await call(s, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('lists every tool with a schema', async () => {
    const { s } = server();
    const res = await call(s, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = res.result.tools.map((t: { name: string }) => t.name);
    // `get_terrain` is conditional on an elevation source; see the dedicated
    // test for it being offered when one is configured.
    expect(names).toEqual(
      expect.arrayContaining(['get_maplet', 'route', 'search_places', 'expand_feature']),
    );
    for (const t of res.result.tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it('calls get_maplet and returns a graph', async () => {
    const { s } = server();
    const res = await call(s, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'get_maplet', arguments: { lat: 37.7749, lon: -122.4194, budget: 500 } },
    });
    const text = res.result.content[0].text as string;
    expect(text).toContain('nodes:');
    expect(text).toContain('# tokens');
  });

  it('honours the budget in get_maplet', async () => {
    const { s } = server();
    const res = await call(s, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'get_maplet', arguments: { lat: 37.7749, lon: -122.4194, budget: 200 } },
    });
    const text = res.result.content[0].text as string;
    const m = /# tokens (\d+)\/(\d+)/.exec(text);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(Number(m![2]));
  });

  it('clamps a budget above the server maximum', async () => {
    const lines: string[] = [];
    const s = new McpStdioServer({ carto: stubCarto(), maxTokens: 4096, write: (l) => lines.push(l) });
    const res = await s.handle({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'get_maplet', arguments: { lat: 37.7749, lon: -122.4194, budget: 10_000_000 } },
    });
    const text = (res as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    expect(text).toContain('/4096');
  });

  it('reports an unknown tool as a tool error, not a protocol error', async () => {
    const { s } = server();
    const res = await call(s, {
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'does_not_exist', arguments: {} },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/unknown tool/);
  });

  it('turns a thrown error into a tool error', async () => {
    const { s } = server();
    const res = await call(s, {
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'get_maplet', arguments: { lat: 'north', lon: 0 } },
    });
    expect(res.result.isError).toBe(true);
  });

  it('finds places by name with search_places', async () => {
    const { s } = server();
    const res = await call(s, {
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'search_places', arguments: { lat: 37.7749, lon: -122.4194, query: 'blue' } },
    });
    expect(res.result.content[0].text).toContain('Blue Bottle');
  });

  it('returns no match when the query is absent', async () => {
    const { s } = server();
    const res = await call(s, {
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'search_places', arguments: { lat: 37.7749, lon: -122.4194, query: 'zzzz' } },
    });
    expect(res.result.content[0].text).toMatch(/no named places/);
  });

  it('expands a feature to WKT', async () => {
    const { s } = server();
    const scr = encodeDocument(fromGeoJson({ type: 'FeatureCollection', features: SF_FEATURES }), { group: false });
    const res = await call(s, {
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'expand_feature', arguments: { scr, ids: [1] } },
    });
    expect(res.result.content[0].text).toMatch(/LINESTRING/);
  });

  it('errors on unparseable SCR rather than throwing', async () => {
    const { s } = server();
    const res = await call(s, {
      jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: { name: 'expand_feature', arguments: { scr: 'not scr', ids: [1] } },
    });
    expect(res.result.isError).toBe(true);
  });

  it('does not advertise get_terrain when no elevation source is configured', async () => {
    // Advertising a tool that can only ever fail teaches a model to call
    // something useless and costs it tokens every time.
    const { s } = server();
    const res = await call(s, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = (res.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).not.toContain('get_terrain');
  });

  it('advertises and answers get_terrain when an elevation source is configured', async () => {
    const grid = {
      bbox: SF_BBOX,
      width: 4, height: 4,
      values: new Float32Array(16).fill(120).map((_, i) => (i % 4) * 100),
      min: 0, max: 300,
    };
    const elevation: ElevationSource = {
      name: 'stub-terrain',
      fetch: async () => grid,
    };
    const lines: string[] = [];
    const s = new McpStdioServer({
      carto: new SuperCarto({ sources: [new StubSource()], elevation }),
      write: (l) => lines.push(l),
    });

    const list = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' } as never);
    const names = (list as { result: { tools: Array<{ name: string }> } }).result.tools.map(
      (t) => t.name,
    );
    expect(names).toContain('get_terrain');

    const res = await s.handle({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'get_terrain', arguments: { lat: 37.7749, lon: -122.4194 } },
    } as never);
    const text = (res as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    expect(text.isError).toBeFalsy();
    expect(text.content[0]!.text).toMatch(/min: 0\.0m/);
    expect(text.content[0]!.text).toMatch(/max: 300\.0m/);
  });

  it('rejects an unknown method with a protocol error', async () => {
    const { s } = server();
    const res = await call(s, { jsonrpc: '2.0', id: 13, method: 'nope/nope' });
    expect(res.error.code).toBe(-32601);
  });

  it('reads newline-delimited JSON-RPC from a stream', async () => {
    const { s, lines } = server();
    const input = Readable.from([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n',
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n',
    ]);
    await s.serve(input);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).id).toBe(1);
    expect(JSON.parse(lines[1]!).id).toBe(2);
  });

  it('reports a parse error with a null id', async () => {
    const { s, lines } = server();
    await s.serve(Readable.from(['{not json\n']));
    const res = JSON.parse(lines[0]!);
    expect(res.id).toBeNull();
    expect(res.error.code).toBe(-32700);
  });
});

// --- HTTP API ---------------------------------------------------------------

describe('MapApiServer', () => {
  async function withServer<T>(
    fn: (base: string) => Promise<T>,
    sources?: MapSource[],
  ): Promise<T> {
    const server = new MapApiServer({
      carto: new SuperCarto({ sources: sources ?? [new StubSource()] }),
    }).handler();
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    try {
      return await fn(`http://127.0.0.1:${port}`);
    } finally {
      server.close();
    }
  }

  it('answers /health', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/health`);
      expect(r.status).toBe(200);
      expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
    });
  });

  it('serves a maplet as yaml', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/maplet?lat=37.7749&lon=-122.4194&format=yaml`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/text\/yaml/);
      expect(await r.text()).toContain('nodes:');
    });
  });

  it('serves a maplet as json with metrics', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/maplet?lat=37.7749&lon=-122.4194&budget=400`);
      const body = (await r.json()) as { yaml: string; metrics: { budget: number } };
      expect(body.yaml).toContain('map:');
      expect(body.metrics.budget).toBe(400);
    });
  });

  it('rejects out-of-range coordinates', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/maplet?lat=999&lon=0`);
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toMatch(/lat must be/);
    });
  });

  it('requires coordinates', async () => {
    await withServer(async (base) => {
      expect((await fetch(`${base}/maplet`)).status).toBe(400);
    });
  });

  it('serves raw SCR', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/scr?bbox=-122.42,37.77,-122.41,37.78`);
      expect(await r.text()).toMatch(/^SCR 1/);
    });
  });

  it('rejects a malformed bbox', async () => {
    await withServer(async (base) => {
      expect((await fetch(`${base}/scr?bbox=nonsense`)).status).toBe(400);
    });
  });

  it('returns 404 with a route list for unknown paths', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/nope`);
      expect(r.status).toBe(404);
      expect(((await r.json()) as { routes: string[] }).routes).toBeDefined();
    });
  });

  it('answers CORS preflight', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/maplet`, { method: 'OPTIONS' });
      expect(r.status).toBe(204);
      expect(r.headers.get('access-control-allow-origin')).toBe('*');
    });
  });

  it('caps the radius so one request cannot fetch a continent', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/maplet?lat=37.7749&lon=-122.4194&radiusM=99999999`);
      expect(r.status).toBe(200);
    });
  });
});

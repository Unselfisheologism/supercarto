import { describe, expect, it } from 'vitest';
import {
  buildIndoorGraph,
  emptyIndoor,
  isMeaningfulIndoor,
  levelLabel,
  toMaplet,
  type GeoJsonFeature,
} from '../src/index.js';

/**
 * Indoor topology.
 *
 * This is the layer the incumbents do not have. Google builds indoor maps for
 * its own users and has no reason to hand a third-party agent a clean
 * floor-by-floor graph; Mapbox has nothing comparable; every MCP wrapper on top
 * returns the same flat GeoJSON.
 *
 * The tests concentrate on the failure mode that matters: emitting rooms an
 * agent cannot reach. A floor of disconnected polygons is worse than no floor,
 * because the agent will confidently route to a room it cannot enter.
 */

const BBOX = { west: -122.42, south: 37.77, east: -122.41, north: 37.78 };

/**
 * Grid-to-lon/lat helper.
 *
 * The fixtures below are authored in grid units because that is the only way to
 * place a room a precise number of metres from a corridor. Those units have to
 * be converted before ingestion or they land outside the envelope entirely -
 * which silently produces an empty graph rather than an error.
 *
 * The extent is matched to the bbox width so one grid unit is about 0.22m, which
 * puts a 20-unit room at roughly 4m across: a plausible shop.
 */
const GRID_PER_DEG = 4096 / (BBOX.east - BBOX.west);
const M_PER_UNIT = ((BBOX.east - BBOX.west) * 111320 * Math.cos(((BBOX.north + BBOX.south) / 2) * Math.PI / 180)) / 4096;

function gx(units: number): number {
  return BBOX.west + units / GRID_PER_DEG;
}

function gy(units: number): number {
  return BBOX.north - units / GRID_PER_DEG;
}

/** A room polygon, ~4m square, at a grid position. */
function room(
  id: number,
  x: number,
  y: number,
  level: number,
  name?: string,
  indoor = 'room',
): GeoJsonFeature {
  const w = 20;
  const h = 20;
  return {
    type: 'Feature',
    id,
    properties: {
      indoor,
      level: String(level),
      ...(name ? { name } : {}),
      class: 'area.generic',
    },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [gx(x), gy(y)],
          [gx(x + w), gy(y)],
          [gx(x + w), gy(y + h)],
          [gx(x), gy(y + h)],
          [gx(x), gy(y)],
        ],
      ],
    },
  };
}

/** A corridor, 200 units (~43m) long and 20 units (~4m) wide. */
function corridor(
  id: number,
  x: number,
  y: number,
  level: number,
  w = 200,
  h = 20,
  name?: string,
): GeoJsonFeature {
  return {
    type: 'Feature',
    id,
    properties: {
      indoor: 'corridor',
      level: String(level),
      ...(name ? { name } : {}),
      class: 'area.generic',
    },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [gx(x), gy(y)],
          [gx(x + w), gy(y)],
          [gx(x + w), gy(y + h)],
          [gx(x), gy(y + h)],
          [gx(x), gy(y)],
        ],
      ],
    },
  };
}

function shaft(
  id: number,
  x: number,
  y: number,
  level: number,
  indoor: 'lift' | 'stairs' = 'lift',
): GeoJsonFeature {
  return {
    type: 'Feature',
    id,
    properties: { indoor, level: String(level), class: 'area.generic' },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [gx(x), gy(y)],
          [gx(x + 10), gy(y)],
          [gx(x + 10), gy(y + 10)],
          [gx(x), gy(y + 10)],
          [gx(x), gy(y)],
        ],
      ],
    },
  };
}

describe('indoor graph', () => {
  it('connects rooms to the corridor on the same storey', () => {
    const g = toMaplet(
      [corridor(1, 0, 0, 0), room(2, 50, 0, 0, 'Blue Bottle'), room(3, 200, 0, 0, 'Pharmacy')],
      { bbox: BBOX, budget: 4000 },
    ).graph.indoor;

    expect(g.multiStorey).toBe(false);
    expect(g.levels).toHaveLength(1);

    const ground = g.levels[0]!;
    const named = ground.nodes.filter((n) => n.name !== undefined);
    expect(named.map((n) => n.name).sort()).toEqual(['Blue Bottle', 'Pharmacy']);

    // Every room must have an edge, or it is a name the agent cannot act on.
    const touched = new Set(ground.edges.flatMap((e) => [e.from, e.to]));
    for (const n of named) {
      expect(touched.has(n.id)).toBe(true);
    }
  });

  it('never links a room on one floor to a corridor on another', () => {
    // The defect this prevents: a straight line through a concrete slab. An
    // agent that believes it can walk from level 0 to level 2 without a lift
    // will send someone through a floor.
    const g = toMaplet(
      [
        corridor(1, 0, 0, 0),
        room(2, 50, 0, 0, 'Ground Shop'),
        corridor(3, 0, 0, 2),
        room(4, 50, 0, 2, 'Upper Office'),
      ],
      { bbox: BBOX, budget: 4000 },
    ).graph.indoor;

    for (const level of g.levels) {
      for (const e of level.edges) {
        expect(e.level).toBe(level.level);
      }
    }
    expect(g.levels).toHaveLength(2);
  });

  it('collapses the same lift across storeys into one vertical link', () => {
    // OSM gives lifts a stable ref and nearly the same coordinates on every
    // floor. Treating each as a separate feature would give an agent three
    // lifts and no way to know which one to use.
    const g = toMaplet(
      [
        corridor(1, 0, 0, 0),
        shaft(2, 90, 40, 0),
        corridor(3, 0, 0, 1),
        shaft(4, 90, 40, 1),
        corridor(5, 0, 0, 2),
        shaft(6, 90, 40, 2),
      ],
      { bbox: BBOX, budget: 8000 },
    ).graph.indoor;

    expect(g.multiStorey).toBe(true);
    expect(g.vertical).toHaveLength(1);
    expect(g.vertical[0]!.kind).toBe('lift');
    expect(g.vertical[0]!.levels.sort()).toEqual([0, 1, 2]);
  });

  it('keeps two lifts in different places apart', () => {
    // Co-located merging is the point; merging lifts 60m apart would invent a
    // shaft that does not exist.
    const g = toMaplet(
      [
        corridor(1, 0, 0, 0),
        shaft(2, 10, 40, 0),
        shaft(3, 400, 40, 0),
        corridor(4, 0, 0, 1),
        shaft(5, 10, 40, 1),
        shaft(6, 400, 40, 1),
      ],
      { bbox: BBOX, budget: 8000 },
    ).graph.indoor;

    expect(g.vertical).toHaveLength(2);
    for (const v of g.vertical) {
      expect(v.levels.sort()).toEqual([0, 1]);
    }
  });

  it('reports untagged storeys rather than inventing them', () => {
    // Levels 0 and 2 tagged with nothing on 1 almost always means untagged, not
    // absent. Saying "level 1 is missing" stops an agent inventing a cafe there.
    const g = toMaplet(
      [corridor(1, 0, 0, 0), corridor(2, 0, 0, 2), shaft(3, 50, 40, 0), shaft(4, 50, 40, 2)],
      { bbox: BBOX, budget: 8000 },
    ).graph.indoor;

    expect(g.missingLevels).toEqual([1]);
  });

  it('emits no indoor block for an outdoor-only map', () => {
    // An empty `indoor:` key is a thing the model has to read and reason about
    // for nothing, so it must not be emitted at all.
    const features: GeoJsonFeature[] = [
      {
        type: 'Feature',
        id: 1,
        properties: { highway: 'residential', name: 'Mission St' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [-122.42, 37.77],
            [-122.41, 37.78],
          ],
        },
      },
    ];
    const out = toMaplet(features, { bbox: BBOX, budget: 2000 });
    expect(out.graph.indoor.levels).toHaveLength(0);
    expect(out.yaml).not.toContain('indoor:');
  });

  it('declines to claim indoor navigation from one tagged corridor', () => {
    // One hallway is not an indoor map. Telling an agent a building has indoor
    // navigation when all that exists is a single corridor would be a claim the
    // data does not support.
    const g = toMaplet([corridor(1, 0, 0, 0)], { bbox: BBOX, budget: 2000 }).graph.indoor;
    expect(g.levels).toHaveLength(0);
    expect(isMeaningfulIndoor(g)).toBe(false);
  });

  it('emits the levels block with distances in metres', () => {
    const out = toMaplet(
      [
        corridor(1, 0, 0, 0),
        room(2, 50, 0, 0, 'Cafe'),
        shaft(3, 200, 40, 0),
        corridor(4, 0, 0, 1),
        shaft(5, 200, 40, 1),
        room(6, 50, 0, 1, 'Office'),
      ],
      { bbox: BBOX, budget: 8000 },
    );

    expect(out.yaml).toContain('indoor:');
    expect(out.yaml).toContain('storeys: 0,1');
    expect(out.yaml).toContain('multi_storey: true');
    // Metres, never grid units: a model cannot use `dist: 800u`.
    expect(out.yaml).toMatch(/dist: \d+m/);
    expect(out.yaml).not.toMatch(/dist: \d+u/);
    // The lift is stated once, with the levels it serves.
    expect(out.yaml).toContain('levels: [0,1]');
  });

  it('names storeys the way a person would', () => {
    // "level 0" is a fact about the OSM tag, not about the building: ground
    // floor in London, first floor in the US. Only the sign and zero cases are
    // certain, so those are stated and the rest left numeric.
    expect(levelLabel(0)).toBe('ground');
    expect(levelLabel(-1)).toBe('basement');
    expect(levelLabel(-2)).toBe('basement 2');
    expect(levelLabel(3)).toBe('3');
  });

  it('keeps a room more than 40m from any corridor unattached', () => {
    // A connection that far out is a straight line through intervening walls.
    // Better to omit the edge than to hand the agent a path that does not exist.
    // The corridor ends at x=200, so a room at x=900 is ~150m clear of it.
    //
    // Called on the builder rather than through the pipeline: a two-node floor
    // is below the threshold at which the pipeline claims a building has indoor
    // navigation at all, which would hide what is being tested here.
    expect(M_PER_UNIT).toBeLessThan(1);
    const g = buildIndoorGraph(
      [
        { id: 1, level: 0, indoor: 'corridor', x: 100, y: 10 },
        { id: 2, level: 0, indoor: 'room', room: true, name: 'Far Room', x: 900, y: 10 },
      ],
      { metresPerUnit: M_PER_UNIT },
    );

    const ground = g.levels[0]!;
    const far = ground.nodes.find((n) => n.name === 'Far Room');
    expect(far).toBeDefined();
    const touched = new Set(ground.edges.flatMap((e) => [e.from, e.to]));
    expect(touched.has(far!.id)).toBe(false);
  });

  it('attaches a room inside the 40m threshold', () => {
    // The complement of the test above, so the threshold is pinned from both
    // sides rather than only proving the negative case.
    const g = buildIndoorGraph(
      [
        { id: 1, level: 0, indoor: 'corridor', x: 100, y: 10 },
        { id: 2, level: 0, indoor: 'room', room: true, name: 'Near Room', x: 140, y: 10 },
      ],
      { metresPerUnit: M_PER_UNIT },
    );
    const ground = g.levels[0]!;
    const near = ground.nodes.find((n) => n.name === 'Near Room');
    const touched = new Set(ground.edges.flatMap((e) => [e.from, e.to]));
    expect(touched.has(near!.id)).toBe(true);
  });

  it('handles a building with no corridors by reporting nothing', () => {
    // Rooms with no circulation between them are a floor of disconnected boxes.
    const g = toMaplet([room(1, 0, 0, 0, 'A'), room(2, 500, 0, 0, 'B')], {
      bbox: BBOX,
      budget: 4000,
    }).graph.indoor;
    expect(g.levels).toHaveLength(0);
  });

  it('returns an empty graph rather than throwing on no input', () => {
    expect(buildIndoorGraph([], { metresPerUnit: 1 })).toEqual(emptyIndoor());
  });
});

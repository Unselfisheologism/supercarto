import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SuperCarto } from '../src/index.js';
import { buildContext, groundTruth } from '../src/bench/runner.js';
import {
  buildTasks,
  SYNTHETIC_AREA,
  SYNTHETIC_HEAT_AREA,
  TASK_AREAS,
} from '../src/bench/tasks.js';
import { metresApart, scoreHeat } from '../src/bench/score.js';
import { scoreArchived } from '../src/bench/rescore.js';
import { fromGeoJson } from '../src/ingest/geojson.js';
import type { GeoJsonFeatureCollection } from '../src/ingest/geojson.js';
import type { Exchange } from '../src/bench/archive.js';

/**
 * The heat track: benefit #3 of the planning doc, unified vector+scalar.
 *
 * GeoJSON has no heat concept, so a vector-only fixture cannot express the
 * scalar half of the stream. The fixture carries a top-level `heat` member
 * read by the ingest heat convention; the maplet renders it as
 * max/mean/hotspots, and the question asks for the peak value and location.
 * Expected outcome is parity with a token ratio, not separation: unlike
 * omission, nothing here is unsayable in raw form - the raw arm parses four
 * cells and converts indices to coordinates.
 */
const fixture = JSON.parse(
  readFileSync('fixtures/bench/synthetic-heat.geojson', 'utf8'),
) as GeoJsonFeatureCollection;

const deadRouter = {
  name: 'dead',
  async available(): Promise<never> {
    throw new Error('reference router consulted');
  },
  async route(): Promise<never> {
    throw new Error('reference router consulted');
  },
} as never;

const offlineCart = {
  async maplet(): Promise<never> {
    throw new Error('live fetch attempted');
  },
  async route(): Promise<never> {
    throw new Error('reference router consulted');
  },
} as unknown as SuperCarto;

const fixtures = { 'synthetic-heat': fixture };
const task = buildTasks([SYNTHETIC_HEAT_AREA])[0]!;

describe('the heat task exists, and only where it is measurable', () => {
  it('generates exactly one kind for the heat area', () => {
    expect(buildTasks([SYNTHETIC_HEAT_AREA]).map((t) => t.kind)).toEqual(['heat']);
    expect(task.id).toBe('synthetic-heat/heat');
    expect(task.groundTruth).toBe('self-consistent');
  });

  it('adds nothing to any other area', () => {
    expect(buildTasks([SYNTHETIC_AREA]).map((t) => t.kind).sort()).toEqual([
      'connectivity',
      'nearest',
      'omission',
    ]);
    const real = TASK_AREAS.find((a) => a.id === 'sf-cbd')!;
    expect(buildTasks([real]).map((t) => t.kind).sort()).toEqual([
      'connectivity',
      'nearest',
      'route',
      'turns',
    ]);
  });
});

describe('heat ingest', () => {
  it('carries the scalar layer into the document', () => {
    const doc = fromGeoJson(fixture);
    expect(doc.heat.length).toBe(1);
    expect(doc.heat[0]!.name).toBe('crowd');
    expect(doc.heat[0]!.cells!.length).toBe(4);
  });

  it('fails loudly on a malformed heat member', () => {
    const point = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: {},
    } as any;
    expect(() =>
      fromGeoJson({ type: 'FeatureCollection', features: [point], heat: [{ name: 'x' }] } as any),
    ).toThrow(/invalid heat layer/);
  });
});

describe('heat ground truth', () => {
  it('reports the peak value and location from the emitted summary, offline', async () => {
    const truth = await groundTruth(task, deadRouter, offlineCart, fixtures, 'supercarto', 1024);
    expect(truth.peak).toBe(200);
    expect(truth.peakAt).toBeDefined();
    // Cell (5,2) of an 8-wide grid over the task bbox: east-northeast of centre.
    expect(truth.peakAt!.lon).toBeGreaterThan(-150.02);
    expect(truth.peakAt!.lat).toBeGreaterThan(44.02);
  });
});

describe('the heat prompt', () => {
  it('renders the scalar stream as max/mean/hotspots', async () => {
    const ctx = await buildContext(task, 'supercarto', 1024, offlineCart, () => {}, undefined, fixtures);
    expect(ctx.text).toMatch(/crowd/);
    expect(ctx.text).toMatch(/max: 200/);
    expect(ctx.text).toMatch(/at: "/);
  });

  it('gives the geojson arm the raw grid', async () => {
    const ctx = await buildContext(task, 'geojson', 1024, offlineCart, () => {}, undefined, fixtures);
    expect(ctx.text).toContain('"heat"');
    expect(ctx.text).toContain('"value":200');
  });
});

describe('scoring heat', () => {
  const at = { lat: 44.021, lon: -150.019 };

  it('passes value and location together', () => {
    const s = scoreHeat('Peak 200 at 44.021, -150.019.', 200, at);
    expect(s.correct).toBe(true);
    expect(s.flags).toEqual([]);
  });

  it('fails a wrong value even at the right place', () => {
    const s = scoreHeat('Peak 90 at 44.021, -150.019.', 200, at);
    expect(s.correct).toBe(false);
    expect(s.flags.join(' ')).toMatch(/stated peak 90/);
  });

  it('fails the right value at the wrong place', () => {
    const s = scoreHeat('Peak 200 at 44.0, -150.0.', 200, at);
    expect(s.correct).toBe(false);
    expect(s.flags.join(' ')).toMatch(/from truth/);
  });

  it('accepts the hotspot among context coordinates', () => {
    // Measured: a step-5 answer stated the hotspot exactly but quoted the map
    // centre first, and first-match grading failed it as 224m off. Any pair
    // within tolerance counts.
    const s = scoreHeat(
      'The peak is 200 at 44.02181, -150.01875, north-east of the centre (44.02, -150.02).',
      200,
      { lat: 44.02181, lon: -150.01875 },
    );
    expect(s.correct).toBe(true);
  });

  it('reads word-separated coordinates', () => {
    // The same answer in "latitude X, longitude Y" phrasing: no adjacent
    // comma pair exists for the hotspot, so the comma pattern alone sees
    // only the centre and fails a correct answer.
    const s = scoreHeat(
      'The maximum occurs at latitude 44.02181, longitude -150.01875, north-east of the centre (44.02, -150.02). Peak 200.',
      200,
      { lat: 44.02181, lon: -150.01875 },
    );
    expect(s.correct).toBe(true);
  });

  it('does not mine coordinates for a fake value', () => {
    // "44.021" must not read as 44: standalone integers only.
    const s = scoreHeat('The peak is at 44.021, -150.019.', 200, at);
    expect(s.correct).toBe(false);
    expect(s.flags.join(' ')).toMatch(/no peak value stated/);
  });

  it('measures metres sanely', () => {
    expect(metresApart({ lat: 44, lon: -150 }, { lat: 44, lon: -150 })).toBe(0);
    const d = metresApart({ lat: 44.02, lon: -150.02 }, { lat: 44.021, lon: -150.019 });
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(200);
  });

  it('re-scores from the archive', () => {
    const exchange = {
      key: 'k',
      taskId: 'synthetic-heat/heat',
      representation: 'supercarto',
      budget: 1024,
      seed: 0,
      model: 'm',
      system: '',
      user: '',
      promptHash: 'h',
      answer: 'Peak 200 at 44.021, -150.019.',
      inputTokens: 1,
      outputTokens: 1,
      at: '',
    } as Exchange;
    const row = scoreArchived(exchange, 'heat', { peak: 200, peakAt: at });
    expect(row.correct).toBe(true);
  });
});

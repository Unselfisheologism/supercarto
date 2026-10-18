import { describe, expect, it } from 'vitest';
import { fromGeoJson, moveMaplet, encodeDocument } from '../src/index.js';
import type { GeoJsonFeature } from '../src/ingest/geojson.js';

/**
 * The agent moves: session views over one envelope.
 *
 * The walk is the airport story in miniature: an agent walks down a hall and
 * each step's view replaces the previous one. The session must report only
 * what changed - a moved cafe is `~ geometry`, a renamed or re-tagged one is
 * `~ attributes`, a departed one is `-`, a newcomer is `+` - and its LLM
 * context never re-pays for the places it already knows.
 */

// One shared, fixed envelope for the whole session: every view quantizes on
// it, which is what makes the geometry diff exact rather than noisy.
const ENVELOPE = { type: 'bbox' as const, west: 2.0, south: 41.38, east: 2.01, north: 41.385 };

const hall = (id: number, lon: number, name: string, tags: Record<string, string> = {}) =>
  ({
    type: 'Feature' as const,
    id,
    properties: { name, amenity: 'cafe', ...tags },
    geometry: { type: 'Point' as const, coordinates: [lon, 41.3805] },
  }) satisfies GeoJsonFeature;

const collection = (features: GeoJsonFeature[]) => ({ type: 'FeatureCollection' as const, features });

describe('session views for a moving agent', () => {
  const initial = collection([
    hall(10, 2.001, 'Espresso Bar'),
    hall(11, 2.004, 'Coffee Corner'),
    hall(12, 2.007, 'Arrival Cafe'),
  ]);

  it('opens a session from a plain maplet and reports a no-change move', () => {
    const first = fromGeoJson(initial, { envelope: ENVELOPE });
    expect(first.features).toHaveLength(3);
    const scr = encodeDocument(first, { group: false });

    // Same view again: nothing changed, so the report is empty and the map
    // the agent holds is already correct.
    const moved = moveMaplet(scr, initial, { envelope: ENVELOPE });
    expect(moved.report).toBe('');
    expect(moved.counts).toEqual({ added: 0, removed: 0, updated: 0 });
    expect(moved.view.center.length).toBeGreaterThan(0);
  });

  it('reports a walk as +/-/~ deltas, never the whole map', () => {
    const first = fromGeoJson(initial, { envelope: ENVELOPE });
    const scr = encodeDocument(first, { group: false });

    // Step 2: one move, one departure, one arrival. The ids recycle across
    // documents because ingest prefers the source's own id, so the diff
    // tracks the places through the shuffle.
    const step2 = collection([
      hall(10, 2.001, 'Espresso Bar'), // unchanged
      hall(11, 2.0055, 'Coffee Corner'), // moved
      hall(13, 2.008, 'Departures Cafe',{ indoor: 'level1' }), // newcomer
    ]);

    const moved = moveMaplet(scr, step2, { envelope: ENVELOPE });
    expect(moved.counts).toEqual({ added: 1, removed: 1, updated: 1 });
    expect(moved.report).toBe(
      [
        '~ 11 Coffee Corner (poi) (geometry)',
        '- 12 Arrival Cafe (poi)',
        '+ 13 Departures Cafe (poi)',
      ].join('\n'),
    );

    // Step 3 reuses the returned state: the agent keeps the last view's SCR,
    // and the session continues without any re-fit of coordinates.
    const step3 = collection([
      hall(10, 2.001, 'Espresso Bar'),
      hall(13, 2.008, 'Departures Cafe', { indoor: 'level1' }),
    ]);
    const next = moveMaplet(moved.scr, step3, { envelope: ENVELOPE });
    expect(next.counts).toEqual({ added: 0, removed: 1, updated: 0 });
    expect(next.report).toBe('- 11 Coffee Corner (poi)');
  });

  it('returns a formattable state: an SCR the next move reads back directly', () => {
    const first = fromGeoJson(initial, { envelope: ENVELOPE });
    const scr = encodeDocument(first, { group: false });
    const step2 = collection([
      hall(10, 2.001, 'Espresso Bar'),
      hall(11, 2.0055, 'Coffee Corner'),
      hall(13, 2.008, 'Departures Cafe', { indoor: 'level1' }),
    ]);
    const moved = moveMaplet(scr, step2, { envelope: ENVELOPE });
    // The compact state is a real SCR string: decoding is the agent's move
    // entry point, so a corrupt return here would break the walk instead of
    // the test run.
    expect(() => moveMaplet(moved.scr, step2, { envelope: ENVELOPE })).not.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { featuresFromDocument, toMaplet } from '../src/index.js';
import type { GeoJsonFeatureCollection } from '../src/index.js';
import { buildTasks, TASK_AREAS, TURN_OFFSET_M } from '../src/bench/tasks.js';
import {
  connectedComponents,
  distanceCorrect,
  scoreConnectivity,
  scoreNames,
} from '../src/bench/score.js';

const fixture = JSON.parse(
  readFileSync('fixtures/bench/sf-cbd.geojson', 'utf8'),
) as GeoJsonFeatureCollection;

/**
 * The raw baseline has to actually be raw.
 *
 * The geojson arm used to serialise `result.graph.nodes` - the *compiled* graph -
 * which had already dropped every name and all geometry. Every arm then measured
 * the harness's projection step rather than the compiler: on this fixture the old
 * arm was 66 features with 0 names and 0 geometries, against a 720-feature source
 * with 336 names. This is the ABC outcome-validity failure in its purest form,
 * because a model could not answer the question from the data it was given.
 */
describe('geojson baseline arm', () => {
  const doc = toMaplet(fixture, {
    budget: 1024,
    radiusLabel: '400m',
    capabilities: { elevation: false, weather: false, traffic: false },
  });
  const raw = featuresFromDocument(doc.doc);

  it('carries the names the source has', () => {
    const named = raw.filter(
      (f) => typeof (f.properties as Record<string, unknown> | null)?.name === 'string',
    );
    expect(named.length).toBeGreaterThan(300);
  });

  it('carries geometry, which the compiled projection dropped entirely', () => {
    // The specific regression: `"geometry":null` on every single feature.
    expect(raw.filter((f) => f.geometry != null).length).toBe(raw.length);
  });

  it('loses no named feature relative to the source', () => {
    const inSource = new Set(
      fixture.features
        .map((f) => (f.properties as Record<string, unknown> | null)?.name)
        .filter((n): n is string => typeof n === 'string'),
    );
    const inRaw = new Set(
      raw
        .map((f) => (f.properties as Record<string, unknown> | null)?.name)
        .filter((n): n is string => typeof n === 'string'),
    );
    const lost = [...inSource].filter((n) => !inRaw.has(n));
    expect(lost).toEqual([]);
  });
});

/**
 * Ground truth must describe the question that was asked.
 *
 * Two separate mismatches, both of which made correct answers score wrong:
 *
 *  - the turn-by-turn prompt asked for a 200m walk while truth was routed to
 *    `area.radiusM` (400m, or 2000m in rural Montana)
 *  - connectivity truth was compiled at budget 4000 while the model was shown
 *    budget 1024, and the component count is a property of the graph: 8 at 1024,
 *    33 at 4000
 */
/**
 * A hallucination metric that cries wolf measures nothing.
 *
 * The name extractor had no way to represent a lowercase connector, so
 * "University of Phoenix" was split into "University" and "Phoenix" and both were
 * reported as invented places. A real run flagged "University", "Phoenix",
 * "Beckett", "Robb", "Boudin Bakery" and "Cafe" - six hallucinations - in an
 * answer that named ten genuine businesses, every one of them in the fixture.
 * Every arm therefore scored zero for hallucinating, and a detector that reports
 * a false positive on every answer is worse than no detector at all.
 */
describe('hallucination detection does not invent false positives', () => {
  const KNOWN = [
    'University of Phoenix',
    'Salesforce Park Cable Car',
    'Boudin Bakery & Cafe',
    'Beckett & Robb',
    'Pokéworks',
    'Osha Thai',
    'Sushi Kinta',
    'Allen Edmonds',
    'City Bank',
    'Concentra Urgent Care',
  ];

  it('does not flag a correct answer naming real multi-word places', () => {
    const answer =
      'The named places are: Salesforce Park Cable Car (attraction), Pokéworks (restaurant), ' +
      'University of Phoenix (university), Concentra Urgent Care (clinic), Beckett & Robb (clothes), ' +
      'Osha Thai (restaurant), Boudin Bakery & Cafe (restaurant), City Bank (bank), ' +
      'Sushi Kinta (fast food), and Allen Edmonds (shoes).';
    const s = scoreNames(KNOWN, answer);
    expect(s.hallucinations).toEqual([]);
    expect(s.recall).toBe(1);
  });

  it('still flags a name that is genuinely absent', () => {
    const s = scoreNames(KNOWN, 'You can visit Starbucks Coffee and also Zzyzx Books.');
    expect(s.hallucinations).toContain('Starbucks Coffee');
  });

  it('still flags a plausible invented shop', () => {
    // A title-cased bare brand with no place word is still a place claim.
    const s = scoreNames(KNOWN, 'Head north to Barstool Pizza, it is worth the walk.');
    expect(s.hallucinations.length).toBeGreaterThan(0);
  });

  it('still flags invented names whose only place word is retail', () => {
    // Regression guard. A candidate carrying no word from the place list is
    // discarded before matching ever happens, so a missing noun is a hallucination
    // the detector is structurally unable to see. "Zzyzx Books" and "Marek Tlusty
    // Bakery" both went unreported until the retail nouns were added.
    const s = scoreNames(
      KNOWN,
      'Try Zzyzx Books, then Marek Tlusty Bakery, then Starbucks Reserve Roastery.',
    );
    expect(s.hallucinations).toContain('Zzyzx Books');
    expect(s.hallucinations).toContain('Marek Tlusty Bakery');
  });

  it('does not flag a name that is a fragment of a real one', () => {
    // The qualifier case. OSM names carry qualifiers models drop and fragments
    // they keep: "Lookout, Inc." -> "Lookout", "Purism SPC" -> "Purism",
    // "The UPS Store" -> "Store", "Taxi Stand at Hotel Vitale" -> "Hotel Vitale".
    //
    // Before this, one real answer describing the map accurately was reported as
    // twenty invented places, all twenty traceable to names in the data - and
    // because hallucination is a hard failure, that arm scored zero for being
    // correct.
    const messy = [
      'Lookout, Inc.',
      'Purism SPC',
      'The UPS Store',
      'Taxi Stand at Hotel Vitale',
      'STK Steakhouse',
      'Flywheel Coffee Roasters',
      'University of San Francisco - Folger Building',
    ];
    const answer =
      'Lookout, Purism, The UPS Store, Hotel Vitale, STK Steakhouse, ' +
      'Flywheel Coffee Roasters and University of San Francisco are all present.';
    expect(scoreNames(messy, answer).hallucinations).toEqual([]);
  });

  it('does not treat a parenthetical type as part of the name', () => {
    const s = scoreNames(KNOWN, 'Osha Thai (restaurant) is open.');
    expect(s.hallucinations).toEqual([]);
  });

  it('keeps recall at 1 when every real name is present', () => {
    const s = scoreNames(KNOWN, KNOWN.join(', '));
    expect(s.recall).toBe(1);
    expect(s.hallucinations).toEqual([]);
  });
});

/**
 * The pass condition has to be reachable.
 *
 * Recall was measured against every named feature in the area - 336 for sf-cbd -
 * while a 1024-token maplet carries about ten. Every arm scored 0% on a task
 * where the model was in fact reporting its data accurately, which is
 * indistinguishable from the task being impossible. Recall is now measured
 * against the names the arm was shown.
 */
describe('the recall pass condition is reachable', () => {
  it('measures shown names, which the supercarto arm can actually cover', () => {
    const doc = toMaplet(fixture, {
      budget: 1024,
      radiusLabel: '400m',
      capabilities: { elevation: false, weather: false, traffic: false },
    });
    const shown = [
      ...new Set(doc.graph.nodes.filter((n) => n.name).map((n) => n.name!)),
    ];
    const all = [
      ...new Set(
        fixture.features
          .map((f) => (f.properties as Record<string, unknown> | null)?.name)
          .filter((n): n is string => typeof n === 'string' && n.length > 0),
      ),
    ];

    // The budget really does cut names down, which is why full-list recall was
    // not a reachable target.
    expect(shown.length).toBeLessThan(all.length);

    // Reporting every shown name, inventing nothing, now passes.
    const s = scoreNames(shown, shown.join(', '));
    expect(s.recall).toBeGreaterThanOrEqual(0.5);
    expect(s.hallucinations).toEqual([]);
  });
});

/**
 * A perfect solver must score 100%.
 *
 * This is the check whose absence let the recall bug ship. Given the ground truth
 * and asked to state it, a solver that emits the truth verbatim has to pass every
 * task. When it does not, the pass condition is wrong - not the model.
 */
describe('an oracle solver scores 100%', () => {
  const oracleNames = (names: string[]): string => names.join(', ');

  it('passes the nearest task when it reports every shown name', () => {
    const doc = toMaplet(fixture, {
      budget: 1024,
      radiusLabel: '400m',
      capabilities: { elevation: false, weather: false, traffic: false },
    });
    const shown = [...new Set(doc.graph.nodes.filter((n) => n.name).map((n) => n.name!))];
    const s = scoreNames(shown, oracleNames(shown));
    expect(s.recall).toBe(1);
    expect(s.hallucinations).toEqual([]);
  });

  it('recovers essentially all of the area when the oracle names everything', () => {
    // Weaker than exact, deliberately. Real OSM names contain commas, ampersands
    // and initials - "Steven S. Miyake, Esq.", "University of San Francisco -
    // Folger Building", "Ahmet's Barber and Hair Styling" - so a comma-separated
    // rendering of 181 names is genuinely ambiguous text, and a free-text
    // extractor cannot recover every one of them from it. On this fixture it
    // recovers all 181 for recall and mis-segments 23.
    //
    // The point of the check is the pass condition is reachable, not that the
    // extractor is exact. Asserting zero false positives here would mean deleting
    // a test that found a real defect in exchange for a number that cannot hold.
    const all = [
      ...new Set(
        fixture.features
          .map((f) => (f.properties as Record<string, unknown> | null)?.name)
          .filter((n): n is string => typeof n === 'string' && n.length > 0),
      ),
    ];
    const s = scoreNames(all, oracleNames(all));
    expect(s.recall).toBe(1);
    expect(s.hallucinations.length / all.length).toBeLessThan(0.15);
  });

  it('passes the distance task when it states the true distance', () => {
    expect(distanceCorrect(480, 480)).toBe(true);
    // And the tolerance is symmetric, so an oracle rounding either way still passes.
    expect(distanceCorrect(450, 480)).toBe(true);
    expect(distanceCorrect(510, 480)).toBe(true);
  });

  it('passes connectivity when it states the graph truthfully', () => {
    const doc = toMaplet(fixture, {
      budget: 1024,
      radiusLabel: '400m',
      capabilities: { elevation: false, weather: false, traffic: false },
    });
    const isolated = connectedComponents(doc.graph) > 1;
    const truthful = isolated
      ? 'Some of the places are isolated; there is no path between them.'
      : 'All of the places are connected to each other by walkable paths.';
    expect(scoreConnectivity(doc.graph, truthful)).toBe(true);
  });
});

describe('ground truth matches the prompt', () => {
  it('states the turn offset once, and the prompt uses it', () => {
    for (const area of TASK_AREAS) {
      const turns = buildTasks([area]).find((t) => t.kind === 'turns')!;
      expect(turns.offsetM).toBe(TURN_OFFSET_M);
      expect(turns.question).toContain(`${TURN_OFFSET_M}m`);
    }
  });

  it('does not silently fall back to the area radius for routing', () => {
    // rural-montana has a 2000m radius, so a radius-derived offset would be 10x
    // the offset the prompt names.
    const montana = TASK_AREAS.find((a) => a.id === 'rural-montana')!;
    expect(montana.radiusM).toBe(2000);
    for (const kind of ['route', 'turns'] as const) {
      const task = buildTasks([montana]).find((t) => t.kind === kind)!;
      expect(task.offsetM).toBe(TURN_OFFSET_M);
      expect(task.offsetM).not.toBe(montana.radiusM);
    }
  });

  it('scores connectivity against the graph at the shown budget', () => {
    const at1024 = toMaplet(fixture, {
      budget: 1024,
      radiusLabel: '400m',
      capabilities: { elevation: false, weather: false, traffic: false },
    });
    const at4000 = toMaplet(fixture, {
      budget: 4000,
      radiusLabel: '400m',
      capabilities: { elevation: false, weather: false, traffic: false },
    });
    // If these were equal, the budget mismatch would be invisible and the test
    // below would pass for the wrong reason.
    expect(connectedComponents(at1024.graph)).not.toBe(connectedComponents(at4000.graph));
  });
});
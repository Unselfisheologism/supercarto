import { describe, expect, it } from 'vitest';
import {
  acknowledgesOmission,
  connectedComponents,
  distanceCorrect,
  extractDistanceM,
  isRefusal,
  median,
  scoreConnectivity,
  scoreNames,
  summarise,
  type ScoredTask,
} from '../src/bench/score.js';
import { buildTasks, EVAL_PROTOCOL, PANEL, TASK_AREAS } from '../src/bench/tasks.js';
import { emptyIndoor, toMaplet, type GeoJsonFeature } from '../src/index.js';

/**
 * The benchmark's own machinery.
 *
 * A benchmark that cannot be shown to grade correctly is worse than no
 * benchmark, because it produces numbers that get cited. These tests pin the
 * scoring rules, and in particular the several places where a lenient
 * implementation would inflate supercarto's score.
 */

describe('distanceCorrect', () => {
  it('accepts a street distance close to the true one', () => {
    // 250m along streets against a 240m truth is right. The tolerance is
    // relative because a walk is always longer than the crow flies.
    expect(distanceCorrect(250, 240)).toBe(true);
    expect(distanceCorrect(215, 240)).toBe(true);
  });

  it('rejects a straight-line distance', () => {
    // The failure this catches: a model that reads the map's centre and reports
    // the radius back, having reasoned about nothing.
    expect(distanceCorrect(200, 240)).toBe(false);
  });

  it('rejects nonsense rather than passing it', () => {
    expect(distanceCorrect(Number.NaN, 240)).toBe(false);
    expect(distanceCorrect(0, 240)).toBe(false);
    expect(distanceCorrect(240, 0)).toBe(false);
    expect(distanceCorrect(-50, 240)).toBe(false);
  });
});

describe('extractDistanceM', () => {
  it('reads metres and kilometres', () => {
    expect(extractDistanceM('you walk about 250m')).toBe(250);
    expect(extractDistanceM('roughly 1.2 km')).toBe(1200);
    expect(extractDistanceM('about 240 meters')).toBe(240);
  });

  it('does not read the m in a street name as a unit', () => {
    // Mission St contains an "s" and "Mission" ends in "n", but a name like
    // "1000m Rd" or an initialism would fool a looser pattern.
    expect(extractDistanceM('head down Mission St')).toBeUndefined();
  });

  it('returns undefined rather than guessing', () => {
    // An answer with no number cannot be scored on distance, and inventing one
    // would make every such answer look like a wild guess scored against the
    // truth.
    expect(extractDistanceM('the route is short')).toBeUndefined();
  });
});

describe('scoreNames', () => {
  it('measures recall against the real data', () => {
    const s = scoreNames(['Blue Bottle', 'Walgreens'], 'There is Blue Bottle here.');
    expect(s.recall).toBeCloseTo(0.5);
    expect(s.hallucinations).toEqual([]);
  });

  it('flags a place that is not in the data', () => {
    // The worst outcome this library could produce: a confident, plausible,
    // fictional shop. It is scored as a failure even when recall is perfect.
    const s = scoreNames(['Blue Bottle'], 'You can visit Blue Bottle and Starbucks.');
    expect(s.hallucinations).toContain('Starbucks');
  });

  it('does not treat a partial reference as an invention', () => {
    const s = scoreNames(['Powell Street Station'], 'Powell St Station is nearby.');
    expect(s.hallucinations).toEqual([]);
  });

  it('scores an empty expected set as full recall', () => {
    // An area with no named places should not make every answer look wrong.
    expect(scoreNames([], 'nothing here').recall).toBe(1);
  });
});

describe('connectivity and omission', () => {
  const isolated = {
    meta: { center: '0,0' },
    nodes: [
      { id: 'n1', kind: 'intersection' as const, features: [] },
      { id: 'n2', kind: 'intersection' as const, features: [] },
      { id: 'n3', kind: 'poi' as const, name: 'A', features: [] },
    ],
    edges: [
      { from: 'n1', to: 'n2', dist: 1, dx: 1, dy: 0, dir: 'east' as const, features: [] },
    ],
    obstacles: [],
    heat: [],
    indoor: emptyIndoor(),
    omitted: [],
    tools: [],
    pinned: [],
    partial: false,
  };

  it('counts weakly connected components', () => {
    expect(connectedComponents(isolated)).toBe(2);
  });

  it('rewards an answer that reports isolation when there is some', () => {
    expect(scoreConnectivity(isolated, 'Some places are isolated from the others.')).toBe(true);
  });

  it('rejects an answer that claims full connectivity when there is none', () => {
    // The specific failure: an agent that says "everything is connected" when
    // a place is stranded will send someone somewhere unreachable.
    expect(scoreConnectivity(isolated, 'All are connected by walking paths.')).toBe(false);
  });

  it('recognises an explicit statement about omissions', () => {
    // The behaviour supercarto is built around: saying the map is partial is
    // correct, and saying a missing feature does not exist is not.
    expect(acknowledgesOmission('The map is incomplete, 137 buildings omitted.')).toBe(true);
    expect(acknowledgesOmission('There is no cafe here.')).toBe(false);
  });

  it('recognises a refusal', () => {
    expect(isRefusal('I cannot determine this from the data.')).toBe(true);
    expect(isRefusal('No map data was provided.')).toBe(true);
    expect(isRefusal('The nearest cafe is Blue Bottle, 40m north.')).toBe(false);
  });
});

describe('summarise', () => {
  function row(over: Partial<ScoredTask>): ScoredTask {
    return {
      taskId: 't',
      representation: 'supercarto',
      model: 'm',
      seed: 0,
      correct: true,
      scoredBy: 'exact',
      inputTokens: 1000,
      outputTokens: 100,
      wallMs: 500,
      answer: '',
      ...over,
    };
  }

  it('reports completion separately from accuracy', () => {
    // This is the distinction that keeps a benchmark honest. A model that
    // answered two of thirty and got both right must not score 100%.
    const s = summarise(
      [...Array(28).fill(0), ...Array(2).fill(0)].map((_, i) =>
        i < 28 ? row({ correct: null, error: 'timeout' }) : row({ correct: true }),
      ),
      'supercarto',
      'm',
    );
    expect(s.accuracy).toBe(1);
    expect(s.completion).toBeCloseTo(0.067);
  });

  it('reports the spread across seeds rather than a single number', () => {
    // Providers are not bit-deterministic even at temperature 0, so one run is
    // noise. A harness that hides this makes small differences look real.
    const s = summarise(
      [
        row({ seed: 0, correct: true }),
        row({ seed: 0, correct: false }),
        row({ seed: 1, correct: true }),
        row({ seed: 1, correct: true }),
      ],
      'supercarto',
      'm',
    );
    expect(s.accuracy).toBe(0.75);
    expect(s.accuracySpread).toBeCloseTo(0.5);
  });

  it('uses a median for token cost', () => {
    // A mean is dragged by one enormous prompt, which is exactly the outlier a
    // median exists to ignore.
    expect(median([10, 10, 10, 10_000])).toBe(10);
    expect(median([5, 10, 20])).toBe(10);
  });

  it('returns null accuracy when nothing was answered', () => {
    const s = summarise([row({ correct: null, error: 'x' })], 'supercarto', 'm');
    expect(s.accuracy).toBeNull();
    expect(s.completion).toBe(0);
  });
});

describe('task set', () => {
  it('covers latitudes that break Mercator assumptions', () => {
    // A benchmark run only at 37N measures one case and hides every sign error
    // toward the poles. These are the areas that would catch one.
    const lats = TASK_AREAS.map((a) => Math.abs(a.center.lat));
    expect(Math.max(...lats)).toBeGreaterThan(60);
    expect(Math.min(...lats)).toBeLessThan(5);
    const signs = new Set(TASK_AREAS.map((a) => Math.sign(a.center.lat)));
    expect(signs.has(1)).toBe(true);
    expect(signs.has(-1)).toBe(true);
  });

  it('includes areas expected to break naive approaches', () => {
    expect(TASK_AREAS.some((a) => a.adversarial)).toBe(true);
    expect(TASK_AREAS.every((a) => a.rationale.length > 0)).toBe(true);
  });

  it('generates every task kind for every area', () => {
    const tasks = buildTasks(TASK_AREAS);
    const perArea = tasks.length / TASK_AREAS.length;
    expect(perArea).toBe(4);
    for (const area of TASK_AREAS) {
      const kinds = new Set(tasks.filter((t) => t.id.startsWith(area.id)).map((t) => t.kind));
      expect(kinds.size).toBe(4);
    }
  });

  it('states where every answer comes from', () => {
    // A score without a stated provenance cannot be audited.
    for (const t of buildTasks(TASK_AREAS)) {
      expect(['osrm', 'source-data', 'self-consistent']).toContain(t.groundTruth);
    }
  });
});

describe('evaluation protocol', () => {
  it('pins temperature and requires multiple seeds', () => {
    expect(EVAL_PROTOCOL.temperature).toBe(0);
    expect(EVAL_PROTOCOL.seeds).toBeGreaterThanOrEqual(3);
    expect(EVAL_PROTOCOL.disableCaches).toBe(true);
    expect(EVAL_PROTOCOL.judgeFromDifferentFamily).toBe(true);
  });

  it('spans model families and includes a small model', () => {
    const providers = new Set(PANEL.map((p) => p.provider));
    expect(providers.size).toBeGreaterThanOrEqual(3);
    // Winning on a 7B model is the one claim a token benchmark cannot fake, so
    // a panel without one is not a panel.
    expect(PANEL.some((p) => p.small)).toBe(true);
  });
});

describe('benchmark ground truth', () => {
  it('can score connectivity from a real compiled graph', () => {
    // A wiring check on the two functions the runner depends on: if these do
    // not compose with the real graph type, every connectivity row in a
    // published run would be meaningless.
    const features: GeoJsonFeature[] = [
      {
        type: 'Feature',
        id: 1,
        properties: { highway: 'residential', name: 'Main St' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [-122.42, 37.775],
            [-122.415, 37.775],
            [-122.41, 37.775],
          ],
        },
      },
      {
        type: 'Feature',
        id: 2,
        properties: { amenity: 'cafe', name: 'Cafe' },
        geometry: { type: 'Point', coordinates: [-122.4175, 37.775] },
      },
    ];
    const graph = toMaplet(features, {
      bbox: { west: -122.42, south: 37.77, east: -122.41, north: 37.78 },
      budget: 2000,
    }).graph;

    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(connectedComponents(graph)).toBe(1);
    expect(scoreConnectivity(graph, 'All the places are connected by walkways.')).toBe(true);
  });
});

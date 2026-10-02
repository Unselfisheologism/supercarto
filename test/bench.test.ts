import { describe, expect, it } from 'vitest';
import {
  distanceCorrect,
  extractDistanceM,
  scoreNames,
  isRefusal,
  acknowledgesOmission,
  connectedComponents,
  scoreConnectivity,
  median,
  summarise,
  failures,
} from '../src/bench/score.js';
import { buildTasks, TASK_AREAS, SYSTEM_PROMPT } from '../src/bench/tasks.js';
import type { ScoredTask } from '../src/bench/score.js';
import type { SpatialGraph } from '../src/compile/graph.js';

/**
 * Benchmark scoring and task construction.
 *
 * The harness had no tests at all. That matters more than ordinary coverage: the
 * scorer's output is the entire basis for any claim that supercarto helps an
 * agent, so a scorer that quietly inflates accuracy would produce a
 * confident, publishable, wrong conclusion. The tests below are mostly about
 * the ways a scorer can lie.
 *
 * No API key is involved. `ModelClient` is an interface and the runner takes
 * injected clients, so the harness is testable end to end offline.
 */

function scored(over: Partial<ScoredTask> = {}): ScoredTask {
  return {
    taskId: 't',
    representation: 'supercarto',
    model: 'fake',
    seed: 0,
    correct: true,
    scoredBy: 'exact',
    inputTokens: 100,
    outputTokens: 20,
    wallMs: 50,
    answer: '',
    ...over,
  };
}

describe('distance scoring', () => {
  it('accepts a value within tolerance', () => {
    expect(distanceCorrect(250, 250)).toBe(true);
    expect(distanceCorrect(260, 250)).toBe(true); // +4%
    expect(distanceCorrect(240, 250)).toBe(true); // -4%
  });

  it('rejects a value outside tolerance', () => {
    expect(distanceCorrect(400, 250)).toBe(false);
    expect(distanceCorrect(100, 250)).toBe(false);
  });

  it('scales tolerance to magnitude rather than using a fixed band', () => {
    // 15% of 250m is 37m, about a block. 15% of 5km is 750m. A fixed absolute
    // band would make short walks impossible to judge and long ones trivial.
    expect(distanceCorrect(5700, 5000)).toBe(true); // +14%
    expect(distanceCorrect(4300, 5000)).toBe(true); // -14%
    // -20% is outside tolerance at either magnitude.
    expect(distanceCorrect(4000, 5000)).toBe(false);
    expect(distanceCorrect(200, 250)).toBe(false); // -20%
  });

  it('refuses nonsense rather than scoring it', () => {
    // These are the cases where a lenient scorer would report a wrong answer as
    // correct because NaN comparisons are false in the flattering direction.
    expect(distanceCorrect(NaN, 250)).toBe(false);
    expect(distanceCorrect(Infinity, 250)).toBe(false);
    expect(distanceCorrect(250, 0)).toBe(false);
    expect(distanceCorrect(250, NaN)).toBe(false);
  });

  it('extracts a distance from free text', () => {
    expect(extractDistanceM('you walk about 240m')).toBe(240);
    expect(extractDistanceM('roughly 240 m')).toBe(240);
    expect(extractDistanceM('about 1.2km')).toBe(1200);
    expect(extractDistanceM('around 0.4 km')).toBe(400);
    expect(extractDistanceM('1.5 kilometers')).toBeUndefined();
  });

  it('does not read a street name as a unit', () => {
    // The "m" in "Market St" is not metres. Without word boundaries the scorer
    // would pull a number out of a street name and judge the answer on it.
    expect(extractDistanceM('head north on Market St for 3 blocks')).toBeUndefined();
  });

  it('prefers kilometres when both units appear', () => {
    expect(extractDistanceM('1km, or about 1000m')).toBe(1000);
  });

  it('returns undefined when no distance is stated', () => {
    expect(extractDistanceM('it is a short walk')).toBeUndefined();
    expect(extractDistanceM('')).toBeUndefined();
  });
});

describe('name scoring', () => {
  it('measures recall of expected names', () => {
    const s = scoreNames(['Blue Bottle', 'Powell St', 'Ferry Building'], 'You can visit Blue Bottle and Powell St.');
    expect(s.recall).toBeCloseTo(2 / 3);
    expect(s.hallucinations).toHaveLength(0);
  });

  it('scores an empty expectation as complete', () => {
    // Nothing to find is not a failure, but it is also not evidence of skill.
    expect(scoreNames([], 'anything at all').recall).toBe(1);
  });

  it('flags a named place that is not in the data', () => {
    // This is the failure that matters: an agent sending someone to a shop that
    // does not exist is worse than one that names nothing.
    const s = scoreNames(['Blue Bottle'], 'Visit Blue Bottle Cafe and Philz Coffee here.');
    expect(s.recall).toBe(1);
    expect(s.hallucinations).toContain('Philz Coffee');
    expect(s.hallucinations).not.toContain('Blue Bottle Cafe');
  });

  it('flags a quoted name with no place word in it', () => {
    // Quotation marks are taken as an explicit claim of a name, so no place word
    // is needed for the check to fire.
    const s = scoreNames(['Blue Bottle'], 'Try "Philz Coffee".');
    expect(s.hallucinations).toContain('Philz Coffee');
  });

  it('does not count an abbreviation of a real name as invented', () => {
    // "Powell St Station" is the same place as "Powell Street Station".
    const s = scoreNames(['Powell Street Station'], 'The Powell St Station is close by.');
    expect(s.hallucinations).toHaveLength(0);
  });
});

describe('refusal and omission detection', () => {
  it('recognises a refusal', () => {
    expect(isRefusal("I cannot determine this from the data")).toBe(true);
    expect(isRefusal("there is no map data available")).toBe(true);
    expect(isRefusal('the distance is 240m')).toBe(false);
  });

  it('recognises an acknowledgement that the map is partial', () => {
    // Omission records exist so the agent says "this is partial" rather than
    // presenting a truncated map as complete.
    expect(acknowledgesOmission('some features were omitted')).toBe(true);
    expect(acknowledgesOmission('this map is incomplete')).toBe(true);
    expect(acknowledgesOmission('here is everything in the area')).toBe(false);
  });
});

describe('connected components', () => {
  function graph(nodes: string[], edges: [string, string][]): SpatialGraph {
    return {
      meta: { center: '0, 0' },
      nodes: nodes.map((id) => ({ id, kind: 'intersection', features: [] })),
      edges: edges.map(([from, to]) => ({ from, to })),
      heat: [],
      omitted: [],
      indoor: null,
      tools: [],
      pinned: [],
    } as unknown as SpatialGraph;
  }

  it('counts one component for a connected graph', () => {
    expect(connectedComponents(graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]))).toBe(1);
  });

  it('counts each island separately', () => {
    expect(connectedComponents(graph(['a', 'b', 'c'], [['a', 'b']]))).toBe(2);
  });

  it('counts isolated nodes as their own component', () => {
    expect(connectedComponents(graph(['a', 'b', 'c'], []))).toBe(3);
  });

  it('ignores an edge naming a node that is not in the graph', () => {
    // A malformed edge must not throw or invent a component.
    expect(connectedComponents(graph(['a'], [['a', 'ghost']]))).toBe(1);
  });

  it('agrees with the answer when it matches the graph it was shown', () => {
    const g = graph(['a', 'b'], [['a', 'b']]);
    expect(scoreConnectivity(g, 'these are all connected')).toBe(true);
    expect(scoreConnectivity(g, 'some are isolated from the rest')).toBe(false);
  });

  it('requires a positive claim when the graph is connected', () => {
    // The case that lets a refusal through. Silence is not agreement: an answer
    // that states nothing about connectivity must not score as correct just
    // because the graph happens to be connected.
    const g = graph(['a', 'b'], [['a', 'b']]);
    expect(scoreConnectivity(g, 'I cannot determine this')).toBe(false);
    expect(scoreConnectivity(g, 'some things are here')).toBe(false);
    expect(scoreConnectivity(g, '')).toBe(false);
  });

  it('requires a positive claim when the graph is disconnected too', () => {
    const g = graph(['a', 'b'], []);
    expect(scoreConnectivity(g, 'I cannot determine this')).toBe(false);
    expect(scoreConnectivity(g, 'they are all connected')).toBe(false);
    expect(scoreConnectivity(g, 'one is isolated')).toBe(true);
  });
});

describe('median', () => {
  it('takes the middle value of an odd set', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the middle pair of an even set', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('handles empty and single sets', () => {
    expect(median([])).toBe(0);
    expect(median([7])).toBe(7);
  });

  it('is not dragged by one enormous value', () => {
    // The reason for a median: one run with a 200k-token context would move a
    // mean far enough to misreport the cost of a representation.
    expect(median([10, 10, 10, 10, 100_000])).toBe(10);
  });
});

describe('summarise', () => {
  it('reports accuracy over answered tasks only', () => {
    const s = summarise(
      [scored({ correct: true }), scored({ correct: false }), scored({ correct: null, scoredBy: 'failed' })],
      'supercarto',
      'fake',
    );
    // Two scorable tasks, one right. The failure must not count as wrong, or a
    // broken harness would look like a failing model.
    expect(s.accuracy).toBe(0.5);
    // Rounded to three places for a stable report, so compare with a tolerance
    // rather than to the exact fraction.
    expect(s.completion).toBeCloseTo(2 / 3, 3);
  });

  it('reports null accuracy when nothing was scorable', () => {
    // A run where every task errored must not publish 0% accuracy. That reads
    // as "the model failed" when the truth is "the harness failed".
    const s = summarise([scored({ correct: null, scoredBy: 'failed' })], 'supercarto', 'fake');
    expect(s.accuracy).toBeNull();
    expect(s.completion).toBe(0);
  });

  it('reports null for an empty task list', () => {
    const s = summarise([], 'supercarto', 'fake');
    expect(s.accuracy).toBeNull();
    expect(s.completion).toBeNull();
  });

  it('measures spread across seeds', () => {
    const s = summarise(
      [
        scored({ seed: 0, correct: true }),
        scored({ seed: 0, correct: true }),
        scored({ seed: 1, correct: true }),
        scored({ seed: 1, correct: false }),
      ],
      'supercarto',
      'fake',
    );
    // Seed 0 scored 1.0, seed 1 scored 0.5. Averaging would hide that a single
    // number is not the whole story.
    expect(s.accuracySpread).toBeCloseTo(0.5);
  });

  it('totals input tokens across answered tasks only', () => {
    const s = summarise(
      [scored({ inputTokens: 100 }), scored({ correct: null, inputTokens: 999_999 })],
      'supercarto',
      'fake',
    );
    expect(s.totalInputTokens).toBe(100);
  });

  it('carries the representation and model through', () => {
    const s = summarise([scored()], 'geojson', 'model-x');
    expect(s.representation).toBe('geojson');
    expect(s.model).toBe('model-x');
  });
});

describe('failures', () => {
  it('lists unscoreable and errored tasks', () => {
    const list = failures([
      scored(),
      scored({ correct: null }),
      scored({ error: 'timeout' }),
    ]);
    expect(list).toHaveLength(2);
  });

  it('returns nothing when every task succeeded', () => {
    expect(failures([scored(), scored()])).toHaveLength(0);
  });
});

describe('task construction', () => {
  it('builds several task kinds per area', () => {
    const tasks = buildTasks(TASK_AREAS);
    expect(tasks.length).toBeGreaterThan(TASK_AREAS.length);
    const kinds = new Set(tasks.map((t) => t.kind));
    expect(kinds.has('route')).toBe(true);
    expect(kinds.has('nearest')).toBe(true);
    expect(kinds.has('connectivity')).toBe(true);
  });

  it('gives every task a unique id', () => {
    // Ids key the detail rows, so a collision would silently merge two
    // different measurements into one.
    const tasks = buildTasks(TASK_AREAS);
    const ids = tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('asks the distance question in a way that distinguishes streets from straight lines', () => {
    // The whole point of the route task: a model answering "400m" from the
    // radius has not measured anything. The wording has to make the distinction
    // explicit or the benchmark rewards the wrong behaviour.
    const route = buildTasks(TASK_AREAS).find((t) => t.kind === 'route');
    expect(route!.question).toMatch(/along streets/i);
    expect(route!.question).toMatch(/straight line/i);
  });

  it('warns the model not to invent places', () => {
    const nearest = buildTasks(TASK_AREAS).find((t) => t.kind === 'nearest');
    expect(nearest!.question).toMatch(/do not invent/i);
  });

  it('builds nothing for an empty area list', () => {
    expect(buildTasks([])).toEqual([]);
  });

  it('gives every task a usable centre and radius', () => {
    for (const t of buildTasks(TASK_AREAS)) {
      expect(Number.isFinite(t.center.lat)).toBe(true);
      expect(Number.isFinite(t.center.lon)).toBe(true);
      expect(t.radiusM).toBeGreaterThan(0);
      expect(t.question.length).toBeGreaterThan(10);
    }
  });

  it('uses a system prompt that tells the model what it is looking at', () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(50);
  });
});
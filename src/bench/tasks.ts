/**
 * The task set.
 *
 * `supercarto bench` measures token count. Token count is not the claim. The
 * claim is that an agent given a supercarto maplet answers correctly *and*
 * cheaply, where the same agent given raw GeoJSON does one or the other. That
 * needs tasks with known answers, and this file is where they live.
 *
 * Ground truth comes from OSRM, which supercarto already depends on and which is
 * the reference pedestrian and driving router. That gives three kinds of
 * question that can be scored exactly rather than by a judge:
 *
 * - routing: distance and duration, known to the metre
 * - proximity: which named place is nearest, known from the source data
 * - connectivity: are two places in the same walkable network, known from the
 *   compiled graph itself
 *
 * Questions that cannot be scored exactly are deliberately absent. A benchmark
 * full of "summarise this neighbourhood" turns into an LLM-judged leaderboard
 * where the judge is the thing under test.
 */

import type { LatLon } from './types.js';

export type TaskKind = 'route' | 'nearest' | 'connectivity' | 'turns';

export interface BenchmarkTask {
  id: string;
  kind: TaskKind;
  /** The question, phrased the way a user would phrase it. */
  question: string;
  /** Centre of the area to fetch. */
  center: LatLon;
  radiusM: number;
  mode: 'walk' | 'bike' | 'drive';
  /** Extra context appended to the question, e.g. a destination name. */
  context?: string;
  /**
   * Where the answer comes from.
   *
   * Recorded rather than assumed, because a score without a stated provenance
   * is a score nobody can audit.
   */
  groundTruth: 'osrm' | 'source-data' | 'self-consistent';
}

export interface TaskArea {
  id: string;
  label: string;
  center: LatLon;
  radiusM: number;
  /**
   * Why this area is in the set.
   *
   * A benchmark of uniformly dense mid-size cities measures one case well and
   * misses the rest. These areas are chosen to span the cases that break
   * approaches: extreme latitude, a dense CBD, a sparse suburb, a city with
   * poor OSM coverage, and a place with indoor mapping.
   */
  rationale: string;
  /** Set true when the area is expected to break a naive approach. */
  adversarial?: boolean;
}

/**
 * The areas.
 *
 * Deliberately international and deliberately awkward. A benchmark run only on
 * San Francisco measures Web Mercator at 37°N and nothing else, which is how a
 * distance bug that only appears toward the poles survives to production.
 */
export const TASK_AREAS: readonly TaskArea[] = [
  {
    id: 'sf-cbd',
    label: 'San Francisco downtown',
    center: { lat: 37.7936, lon: -122.3958 },
    radiusM: 400,
    rationale: 'Dense CBD: maximum feature count, tight budget pressure.',
  },
  {
    id: 'oslo',
    label: 'Oslo central',
    center: { lat: 59.9111, lon: 10.7529 },
    radiusM: 400,
    rationale: 'High latitude, where a wrong Mercator scale shows up as a metres error.',
  },
  {
    id: 'singapore',
    label: 'Singapore Marina Bay',
    center: { lat: 1.2838, lon: 103.8591 },
    radiusM: 500,
    rationale: 'Near-equatorial, where longitude degrees are longest.',
  },
  {
    id: 'tokyo-shimbashi',
    label: 'Tokyo Shimbashi',
    center: { lat: 35.6833, lon: 139.762 },
    radiusM: 400,
    rationale: 'Non-Latin place names, which stress the emitter quoting.',
  },
  {
    id: 'sydney',
    label: 'Sydney CBD',
    center: { lat: -33.8688, lon: 151.2093 },
    radiusM: 400,
    rationale: 'Southern hemisphere, so a sign error in the y axis inverts the map.',
  },
  {
    id: 'reykjavik',
    label: 'Reykjavik centre',
    center: { lat: 64.1466, lon: -21.9426 },
    radiusM: 500,
    rationale: 'Sparse, low-rise, and cold: few named places to survive a small budget.',
    adversarial: true,
  },
  {
    id: 'rural-montana',
    label: 'Rural Montana',
    center: { lat: 46.4, lon: -110.7 },
    radiusM: 2000,
    rationale: 'Sparse rural geometry at a wide radius, where most approaches return nothing useful.',
    adversarial: true,
  },
  {
    id: 'kuala-lumpur',
    label: 'Kuala Lumpur',
    center: { lat: 3.139, lon: 101.6869 },
    radiusM: 400,
    rationale: 'Complex road hierarchy and inconsistent tagging.',
    adversarial: true,
  },
];

/**
 * Tasks per area.
 *
 * Generated rather than hand-written so every area gets the same treatment. A
 * hand-written set drifts toward the areas its author found interesting.
 */
export function buildTasks(areas: readonly TaskArea[] = TASK_AREAS): BenchmarkTask[] {
  const out: BenchmarkTask[] = [];
  for (const area of areas) {
    out.push({
      id: `${area.id}/route-distance`,
      kind: 'route',
      question:
        `Starting from the centre of this area and walking ${area.radiusM}m in the ` +
        'north direction, roughly how far do you actually travel along streets, ' +
        'as opposed to in a straight line?',
      center: area.center,
      radiusM: area.radiusM,
      mode: 'walk',
      groundTruth: 'osrm',
    });

    out.push({
      id: `${area.id}/nearest-poi`,
      kind: 'nearest',
      question:
        'List the named places here with the type of thing each one is. ' +
        'Do not invent any that are not in the data.',
      center: area.center,
      radiusM: area.radiusM,
      mode: 'walk',
      groundTruth: 'source-data',
    });

    out.push({
      id: `${area.id}/turn-by-turn`,
      kind: 'turns',
      question:
        'If someone is standing at the centre of this area and wants to walk 200m ' +
        'north along the street network, what street names would they walk on, ' +
        'and which direction do they face at each turn?',
      center: area.center,
      radiusM: area.radiusM,
      mode: 'walk',
      groundTruth: 'osrm',
    });

    out.push({
      id: `${area.id}/connectivity`,
      kind: 'connectivity',
      question:
        'Are the places in this map connected to each other by walkable paths in ' +
        'the data, or are some of them isolated? Answer from the graph.',
      center: area.center,
      radiusM: area.radiusM,
      mode: 'walk',
      groundTruth: 'self-consistent',
    });
  }
  return out;
}

/**
 * The prompt every model sees, so the comparison is about the map and not about
 * the wording.
 *
 * Identical across representations. The only thing that changes between runs is
 * what gets put in the context window, which is the entire point.
 */
export const SYSTEM_PROMPT = `You answer questions about a place using map data.

You may be given map data in one of several formats: a YAML graph, raw GeoJSON,
or nothing beyond a description. Work with whatever you are given. Do not
invent place names, street names, or distances that are not present.

If the data says some features were omitted, say the map is incomplete rather
than concluding a missing feature does not exist.

Answer in one short paragraph. Give distances in metres. Give directions as
compass words (north, south-east, and so on).`;

/** Models to evaluate. Chosen to span families, not to flatter one. */
export interface ModelSpec {
  id: string;
  provider: 'anthropic' | 'openai' | 'google' | 'openai-compatible';
  model: string;
  /** Env var holding the credential. */
  keyEnv: string;
  /**
   * Whether this model is small enough to self-host.
   *
   * The small model is not an afterthought. Winning with a 7B model is the
   * strongest available proof of the efficiency argument, because it is the one
   * result a token-count benchmark cannot fake.
   */
  small?: boolean;
}

export const PANEL: readonly ModelSpec[] = [
  {
    id: 'claude-sonnet',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    keyEnv: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'gpt',
    provider: 'openai',
    model: 'gpt-4.1',
    keyEnv: 'OPENAI_API_KEY',
  },
  {
    id: 'gemini',
    provider: 'google',
    model: 'gemini-2.5-pro',
    keyEnv: 'GEMINI_API_KEY',
  },
  {
    id: 'small-local',
    provider: 'openai-compatible',
    model: 'qwen2.5-7b-instruct',
    keyEnv: 'SUPERCARTO_LOCAL_LLM',
    small: true,
  },
];

/**
 * Why temperature 0 and three seeds.
 *
 * Temperature 0 makes a single run reproducible, but providers are not
 * bit-deterministic: batching, kernel selection, and floating-point reduction
 * order all move logit ties. Reporting one run as the score therefore reports
 * noise as a result. Three seeds and a reported spread costs three times as much
 * and makes the number mean something.
 */
export const EVAL_PROTOCOL = {
  temperature: 0,
  seeds: 3,
  /** Caches must be off. A cached response is a free run that never happened. */
  disableCaches: true,
  /** Score with a model from a different family than the one under test. */
  judgeFromDifferentFamily: true,
  reportSpread: true,
} as const;

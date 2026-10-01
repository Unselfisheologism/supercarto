import type { BenchmarkTask } from './tasks.js';
import type { SpatialGraph } from '../index.js';

/**
 * Scoring.
 *
 * The rule here is that a score must be checkable without trusting a language
 * model's opinion of another language model's opinion. Where a task has an exact
 * answer - a distance from OSRM, a name from the source data - it is compared
 * programmatically. Only the genuinely open-ended tasks fall back to a judge,
 * and those are marked so a reader knows which numbers are softer.
 */

export interface ScoredTask {
  taskId: string;
  representation: Representation;
  model: string;
  seed: number;
  /** True or false. Null when the run failed outright. */
  correct: boolean | null;
  /** Programmatic where possible; `judge` where not. */
  scoredBy: 'exact' | 'judge' | 'failed';
  /** Tokens the model was actually billed for, from its own tokenizer. */
  inputTokens: number;
  outputTokens: number;
  wallMs: number;
  answer: string;
  error?: string;
  /** Judge's reasoning, when there was one. */
  rationale?: string;
}

/**
 * What gets put in the context window.
 *
 * `none` is included deliberately. Without it, a run can look good simply
 * because a model refused rather than because it reasoned well, and refusal is
 * cheap. It is also the honest floor: a human with no map cannot answer.
 */
export type Representation = 'supercarto' | 'geojson' | 'none';

export interface RunOutcome {
  tasks: ScoredTask[];
  summary: {
    representation: Representation;
    model: string;
    /** Fraction correct over tasks that produced an answer. Null if none did. */
    accuracy: number | null;
    /** Fraction over all tasks, counting failures as wrong. */
    completion: number | null;
    medianInputTokens: number;
    totalInputTokens: number;
    meanWallMs: number;
    /** Spread across seeds. Zero when every seed agreed. */
    accuracySpread: number;
  };
}

/** Compare a stated distance to the true one, within a relative tolerance. */
export function distanceCorrect(stated: number, truth: number, tolerance = 0.15): boolean {
  if (!Number.isFinite(stated) || !Number.isFinite(truth)) return false;
  if (truth <= 0) return false;
  // A 200m walk along streets is typically 220-260m. Judging on the ratio
  // rather than an absolute band is what makes the tolerance meaningful at both
  // ends of the scale: 15% of 250m is 37m, which is about one block.
  const ratio = stated / truth;
  return ratio >= 1 - tolerance && ratio <= 1 + tolerance;
}

/** Extract the first plausible distance from a free-text answer, in metres. */
export function extractDistanceM(text: string): number | undefined {
  // Matches "240m", "240 m", "1.2km", "0.4 km". Word boundaries matter or the
  // "m" in a street name is read as a unit.
  const km = /\b(\d+(?:\.\d+)?)\s*km\b/i.exec(text);
  if (km) return Number(km[1]) * 1000;
  const m = /\b(\d+(?:\.\d+)?)\s*m(?:eters?|etres?)?\b/i.exec(text);
  if (m) return Number(m[1]);
  return undefined;
}

/**
 * Whether a named place in the source data appears in the answer.
 *
 * Recalled and hallucinated are both measured, because an agent that names
 * three real cafes and one imaginary one is worse than one that names none: the
 * user will walk to the imaginary one.
 */
export interface NameScore {
  recall: number;
  /** Named things that are not in the data. */
  hallucinations: string[];
}

export function scoreNames(expected: string[], answer: string): NameScore {
  const haystack = answer.toLowerCase();
  const found = expected.filter((n) => haystack.includes(n.toLowerCase()));
  const recall = expected.length === 0 ? 1 : found.length / expected.length;

  // Hallucination detection needs a candidate list, which a free-text answer
  // does not cleanly provide. The check that matters most is the inverse: does
  // the answer name anything with a recognisable place-like suffix that is not
  // in the data? That catches the common failure of inventing a plausible shop.
  const claimed = extractQuotedOrTitled(answer);
  const known = expected.map((n) => n.toLowerCase());
  const hallucinations = claimed.filter((c) => {
    const norm = c.toLowerCase();
    if (known.includes(norm)) return false;
    // An abbreviation of a real name is a legitimate partial reference, not an
    // invention: "Powell St Station" is the same place as "Powell Street
    // Station". Comparing word sets rather than substrings is what makes that
    // work, since neither string contains the other.
    const claimedWords = new Set(norm.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    for (const k of known) {
      const knownWords = k.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      if (
        knownWords.length > 0 &&
        knownWords.every((w) => claimedWords.has(w) || isAbbrev(w, claimedWords))
      ) {
        return false;
      }
    }
    return true;
  });

  return { recall, hallucinations };
}

/**
 * Whether a known word is an abbreviation of something the answer said.
 *
 * "street" and "st", "avenue" and "ave", and so on. A per-word allowance rather
 * than a fuzzy string distance, because string distance would also excuse
 * "Starbucks" against "Starbunks", which is precisely the error being measured.
 */
const ABBREVIATIONS: Record<string, Set<string>> = {
  street: new Set(['st']),
  avenue: new Set(['ave', 'av']),
  road: new Set(['rd']),
  boulevard: new Set(['blvd', 'blv']),
  drive: new Set(['dr']),
  lane: new Set(['ln']),
  court: new Set(['ct']),
  place: new Set(['pl']),
  square: new Set(['sq']),
  terrace: new Set(['ter']),
  parkway: new Set(['pkwy']),
  north: new Set(['n']),
  south: new Set(['s']),
  east: new Set(['e']),
  west: new Set(['w']),
  station: new Set(['stn', 'sta']),
  building: new Set(['bldg']),
  centre: new Set(['ctr']),
  center: new Set(['ctr']),
};

function isAbbrev(known: string, claimed: Set<string>): boolean {
  const forms = ABBREVIATIONS[known];
  if (!forms) return false;
  for (const form of forms) if (claimed.has(form)) return true;
  return false;
}

/**
 * Candidate place names in a free-text answer.
 *
 * Quoted strings are unambiguous. Bare Title Case is not: a sentence-initial
 * "There" or "Head" looks identical to a shop name by capitalisation alone, so
 * capitalisation is only accepted when the candidate also carries a word that
 * actually marks a place. Without that filter every answer in the benchmark
 * would be reported as hallucinating, which is the fastest way to make a
 * hallucination metric worthless.
 */
const PLACE_SUFFIXES = new Set([
  'street', 'st', 'road', 'rd', 'avenue', 'ave', 'boulevard', 'blvd', 'lane', 'ln',
  'drive', 'dr', 'court', 'ct', 'way', 'place', 'pl', 'square', 'sq', 'terrace',
  'walk', 'close', 'crescent', 'parade', 'highway', 'hwy',
  'station', 'cafe', 'coffee', 'restaurant', 'bar', 'pub', 'hotel', 'shop', 'store',
  'market', 'marketplace', 'museum', 'library', 'park', 'garden', 'centre', 'center',
  'hall', 'tower', 'building', 'plaza', 'gallery', 'bakery', 'pharmacy', 'clinic',
  'hospital', 'school', 'university', 'church', 'temple', 'bridge', 'terminal',
  'airport', 'stadium', 'theatre', 'theater', 'cinema', 'office', 'mall',
]);

function extractQuotedOrTitled(answer: string): string[] {
  const out: string[] = [];

  for (const m of answer.matchAll(/"([^"]{2,60})"/g)) out.push(m[1]!.trim());

  for (const m of answer.matchAll(/\b([A-Z][a-z]+(?:[ \-][A-Z0-9][a-z0-9]+){0,3})\b/g)) {
    const candidate = m[1]!.trim();
    if (candidate.length < 3) continue;
    // Quoted names are taken on trust; unquoted ones need a place word in them.
    if (hasPlaceWord(candidate)) out.push(candidate);
  }

  return [...new Set(out)];
}

/**
 * Common capitalised words that begin sentences or instructions.
 *
 * Needed because "Starbucks" alone is a legitimate place claim while "There"
 * alone is not, and both are Title Case. There is no way to tell them apart
 * from capitalisation, so the ones that are common English are listed. This list
 * being incomplete only costs recall on unusual openings; it never invents a
 * hallucination, which is the direction that matters.
 */
const SENTENCE_STARTERS = new Set([
  'there', 'here', 'this', 'that', 'these', 'those', 'the', 'a', 'an',
  'head', 'walk', 'walking', 'walking north', 'start', 'starting', 'go', 'going',
  'you', 'your', 'it', 'if', 'when', 'while', 'from', 'to', 'toward', 'towards',
  'near', 'next', 'then', 'turn', 'turning', 'continue', 'straight', 'north',
  'south', 'east', 'west', 'approximately', 'roughly', 'about', 'around',
  'some', 'several', 'no', 'not', 'yes', 'one', 'two', 'three', 'first',
  'second', 'main', 'street', 'road', 'avenue', 'lane', 'place', 'area',
  'map', 'data', 'list', 'note', 'notes', 'distance', 'direction', 'directions',
]);

function hasPlaceWord(candidate: string): boolean {
  const words = candidate.toLowerCase().split(/[ \-]+/);
  const filtered = words.filter((w) => !SENTENCE_STARTERS.has(w));
  if (filtered.length === 0) return false;
  // A bare brand with no place word is still a place claim: "Starbucks" on its
  // own names a shop.
  if (words.length === 1) return /^[A-Z][a-z]+$/.test(candidate) && candidate.length >= 4;
  return words.some((w) => PLACE_SUFFIXES.has(w.replace(/\.$/, '')));
}

/** True when the answer declines or says it cannot tell. */
export function isRefusal(answer: string): boolean {
  return /\b(cannot|can't|unable|no (map|data|information)|not (enough|available)|insufficient)\b/i.test(
    answer,
  );
}

/** Whether the answer claims the map is incomplete, which is the desired behaviour. */
export function acknowledgesOmission(answer: string): boolean {
  return /\b(omitted|incomplete|not shown|partial|may be missing|only includes)\b/i.test(answer);
}

/**
 * Connectivity, judged against the graph the model was shown.
 *
 * Self-consistent rather than absolute truth: if the graph says two nodes are
 * in separate components, an answer saying "some are isolated" is correct *about
 * the data it was given*. The alternative would require knowing the true
 * connected components of the real world, which the task does not have.
 */
export function scoreConnectivity(graph: SpatialGraph, answer: string): boolean {
  const components = connectedComponents(graph);
  const isolated = components > 1;
  const claimsIsolated = /\b(isolated|not connected|no path|separate)\b/i.test(answer);
  const claimsAllConnected = /\b(all (are )?connected|every one is|fully connected)\b/i.test(
    answer,
  );

  if (isolated) return claimsIsolated && !claimsAllConnected;
  return !claimsIsolated;
}

/** Weakly-connected component count over the emitted graph. */
export function connectedComponents(graph: SpatialGraph): number {
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let root = a;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = a;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  for (const n of graph.nodes) parent.set(n.id, n.id);
  for (const e of graph.edges) {
    if (!parent.has(e.from) || !parent.has(e.to)) continue;
    parent.set(find(e.from), find(e.to));
  }
  return new Set([...parent.values()].map(find)).size;
}

/** Median, because a mean over token counts is dragged by one enormous run. */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 0 ? Math.round((s[mid - 1]! + s[mid]!) / 2) : s[mid]!;
}

/**
 * Group scored tasks into per-configuration summaries.
 *
 * The accuracy figure is over tasks that produced an answer, and `completion`
 * reports failures separately. Collapsing the two is how a benchmark ends up
 * crediting a model that answered two questions out of thirty, because the other
 * twenty-eight errored and errors are not scored as wrong.
 */
export function summarise(
  tasks: ScoredTask[],
  representation: Representation,
  model: string,
): RunOutcome['summary'] {
  const answered = tasks.filter((t) => t.correct !== null);
  const correct = answered.filter((t) => t.correct === true).length;

  // Per-seed accuracy, so the spread is real and not an artefact of averaging.
  const bySeed = new Map<number, { ok: number; n: number }>();
  for (const t of tasks) {
    const s = bySeed.get(t.seed) ?? { ok: 0, n: 0 };
    s.n++;
    if (t.correct === true) s.ok++;
    bySeed.set(t.seed, s);
  }
  const perSeed = [...bySeed.values()].map((s) => (s.n === 0 ? 0 : s.ok / s.n));
  const spread = perSeed.length === 0 ? 0 : Math.max(...perSeed) - Math.min(...perSeed);

  return {
    representation,
    model,
    accuracy: answered.length === 0 ? null : round3(correct / answered.length),
    completion: tasks.length === 0 ? null : round3(answered.length / tasks.length),
    medianInputTokens: median(answered.map((t) => t.inputTokens)),
    totalInputTokens: answered.reduce((a, t) => a + t.inputTokens, 0),
    meanWallMs: Math.round(
      tasks.length === 0 ? 0 : tasks.reduce((a, t) => a + t.wallMs, 0) / tasks.length,
    ),
    accuracySpread: round3(spread),
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Which tasks in a run failed outright, for the error table in the report. */
export function failures(tasks: ScoredTask[]): ScoredTask[] {
  return tasks.filter((t) => t.correct === null || t.error !== undefined);
}

export type { BenchmarkTask };

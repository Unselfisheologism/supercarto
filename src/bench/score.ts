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

  // Fallback for digit-adjacent units, where no word boundary exists because
  // the character before the number is itself a word character. Models emit
  // these constantly: "240m" inside a token like "DISTANCE_IS_240m", or
  // "(240m)", or "≈240m". Requiring a boundary alone means a confidently wrong
  // "no distance stated" verdict on an answer that plainly stated one, which is
  // the worst kind of scoring error: it penalises the model for its formatting.
  //
  // The guard against reading a street name as a unit still holds, because the
  // looser pattern requires digits immediately before the "m".
  const gluedKm = /(\d+(?:\.\d+)?)\s*km\b/i.exec(text);
  if (gluedKm) return Number(gluedKm[1]) * 1000;
  const gluedM = /(\d+(?:\.\d+)?)\s*m(?:eters?|etres?)?\b/i.exec(text);
  if (gluedM) return Number(gluedM[1]);
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

  /**
   * Every name string the data legitimately answers to.
   *
   * `expected` holds the `name` tag, but OSM records the other names a place goes
   * by in `alt_name`, `old_name`, `official_name`, `short_name` and `loc_name`. A
   * model quoting one of those has not invented anything.
   *
   * This is not hypothetical. A real answer reported two invented plazas -
   * "Justin Herman Plaza" and "S.D. Bechtel Plaza" - and both are in the fixture
   * as the `old_name` and `alt_name` of Embarcadero Plaza and 50 Beale Street
   * Plaza. The answer was better than the scorer could represent.
   *
   * Aliases are collected where the caller can supply them and simply absent
   * otherwise, so `scoreNames` keeps its signature and stays usable on a bare list
   * of names.
   */
  const aliases = (expected as { aliases?: string[] }).aliases ?? [];
  const allNames = [...known, ...aliases.map((a) => a.toLowerCase())];

  /**
   * Whether a claimed run refers to something in the data.
   *
   * Four ways, loosest last. The run is often longer or shorter than the real
   * name because the extractor had to guess a boundary in prose, so demanding an
   * exact match flags real places - which is how a correct answer gets reported as
   * invented businesses.
   */
  const refersToKnown = (norm: string): boolean => {
    if (allNames.includes(norm)) return true;
    // A known name sits inside the run: the run swallowed a list separator, so
    // "Cable Car, Boudin Bakery" contains "Boudin Bakery".
    if (allNames.some((k) => containsWord(norm, k))) return true;
    // The run sits inside a known name. This is the case that decides whether the
    // metric works at all, because OSM names routinely carry a qualifier the model
    // drops or a fragment it keeps: "Lookout, Inc." -> "Lookout", "Purism SPC" ->
    // "Purism", "STK Steakhouse" -> "Steakhouse", "Taxi Stand at Hotel Vitale" ->
    // "Hotel Vitale", "The UPS Store" -> "Store".
    //
    // Without it, one real answer describing the map accurately was reported as
    // twenty invented places, all twenty traceable to names in the data. Since
    // hallucination is a hard failure, that arm scored zero for being correct.
    //
    // Erring toward "not a hallucination" is deliberate. A missed invention costs
    // detection power; a count that flags real places costs the whole metric, and
    // the documentation already states the figure is an upper bound.
    if (allNames.some((k) => containsWord(k, norm))) return true;
    // Every word of a known name is present in the run, allowing abbreviation.
    // This is what makes "The Powell St Station" match "Powell Street Station",
    // where an exact or substring comparison fails in both directions.
    const claimedWords = new Set(norm.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    for (const k of allNames) {
      const knownWords = k.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      if (
        knownWords.length > 0 &&
        knownWords.every((w) => claimedWords.has(w) || isAbbrev(w, claimedWords))
      ) {
        return true;
      }
    }
    return false;
  };

  const hallucinations = claimed.filter((c) => !refersToKnown(c.toLowerCase()));

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
 * Words that mark a candidate as naming a place.
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
  // Food and retail, because that is what most of the named features in an urban
  // extract actually are. Without these, an invented restaurant is not detected:
  // "Barstool Pizza" carries no word from the list above, so the whole candidate
  // was discarded and the hallucination went unreported.
  'pizza', 'restaurant', 'grill', 'kitchen', 'bakery', 'deli', 'cafe', 'coffee',
  'bar', 'pub', 'brewery', 'taqueria', 'sushi', 'noodle', 'ramen', 'diner',
  'bistro', 'brasserie', 'trattoria', 'steakhouse', 'buffet', 'food', 'foods',
  'market', 'supermarket', 'grocery', 'grocer', 'bakery', 'butcher', 'deli',
  'shop', 'store', 'marketplace', 'boutique', 'outfitters', 'goods', 'mart',
  'hotel', 'motel', 'inn', 'hostel', 'lodge', 'resort',
  'bank', 'atm', 'pharmacy', 'clinic', 'hospital', 'dentist', 'vet',
  'school', 'college', 'university', 'academy', 'institute', 'kindergarten',
  'church', 'mosque', 'temple', 'synagogue', 'chapel', 'cathedral',
  'theater', 'cinema', 'gallery', 'museum', 'aquarium', 'zoo',
  'park', 'garden', 'square', 'plaza', 'market', 'centre', 'center',
  'tower', 'house', 'hall', 'lodge', 'inn', 'club', 'lounge', 'bar',
  'salon', 'spa', 'salon', 'barber', 'studio', 'gallery',
  'library', 'museum', 'theatre', 'arena', 'centre', 'depot', 'terminal',
  // More retail and service nouns. The list is long on purpose: a candidate with
  // no place word in it is discarded before matching, so a missing word is a
  // hallucination the detector can never see. "Zzyzx Books" and "Starbucks
  // Reserve" were both invented in a probe and both went unreported for exactly
  // this reason.
  'books', 'bookstore', 'records', 'record', 'shop', 'stores', 'florist', 'florists',
  'flowers', 'jewellers', 'jewelers', 'jewellery', 'jewelry', 'optician',
  'opticians', 'shoes', 'clothing', 'clothes', 'apparel', 'boutique', 'outlet',
  'furniture', 'hardware', 'garden', 'nursery', 'pets', 'pet', 'toys', 'toy',
  'tailor', 'tailors', 'shoe', 'cleaners', 'drycleaners', 'laundry', 'pharmacies',
  'physio', 'physiotherapy', 'chiropractic', 'optometrist', 'midwife',
  'gallery', 'galleries', 'studio', 'studios', 'salon', 'spa', 'barber', 'barbers',
  'gym', 'fitness', 'yoga', 'pilates', 'martial', 'karate', 'climbing',
  'bakery', 'bakeries', 'butchers', 'greengrocer', 'newsagent', 'post',
  'postoffice', 'atm', 'banking', 'currency', 'exchange', 'nails', 'tattoo',
  'tattoos', 'massage', 'reflexology', 'sauna', 'onsen', 'hostel', 'campsite',
  'restaurant', 'restaurants', 'eatery', 'trattoria', 'pizzeria', 'patisserie',
  'chocolaterie', 'creperie', 'bagel', 'donuts', 'doughnuts', 'icecream',
  'brewery', 'winery', 'distillery', 'tasting', 'roastery', 'tea', 'teahouse',
]);

/**
 * Lowercase words that sit *inside* a place name.
 *
 * "University of Phoenix", "House of Prime Rib", "Cafe de Flore". The extractor
 * has to let these through or it splits the name at the connector, and then flags
 * both halves as invented places. A run of this benchmark's answers reported
 * "University", "Phoenix", "Cafe" and "Robb" as hallucinations when the model had
 * named four real businesses, all of them present in the fixture.
 */
/**
 * Lowercase words that sit *inside* a place name.
 *
 * "University of Phoenix", "House of Prime Rib". `&` is handled separately because
 * it behaves differently: "Beckett & Robb" is one name, while "Blue Bottle Cafe and
 * Philz Coffee" is two names in a list. `and` is therefore *not* a connector here,
 * since treating it as one fused unrelated shops into a single candidate and lost
 * the second one entirely.
 */
const NAME_CONNECTORS = new Set(['of', 'the', 'de', 'del', 'la', 'le', 'du', 'da']);

/**
 * A candidate is allowed to end at a place word.
 *
 * "Osha Thai (restaurant)" must yield "Osha Thai" and not swallow "restaurant".
 * But a name can *legitimately* end at one: "Salesforce Park" is a real place and
 * "park" is a place word, so terminating there truncates a real name and reports
 * it as invented. Terminating is therefore only the right behaviour when the word
 * continues into something that is clearly not part of the name - which is what
 * the bracket check below decides.
 */

/**
 * Capitalised words that open a clause rather than a name.
 *
 * Only consulted before a run has started, so this cannot damage a name that
 * legitimately begins with one of them. "Visit Blue Bottle Cafe" loses "Visit";
 * "The Embarcadero" does not lose "The", because "The" is a name connector and
 * is handled before this check.
 */
const SENTENCE_FURNITURE =
  /^(Visit|Go|Try|Head|Walk|Continue|Turn|Start|Begin|Meet|Find|Look|Ask|See|Note|Listed|Named|Near|Around|From|With|There|Here|The following|Named places|Places|Also|Plus|And|But|So|Then|Now|You|Check|Explore|Since|Unless|Because|However|Although|Therefore|Instead|Otherwise|Meanwhile|Furthermore|Additionally|In|On|At|For|By|As|It|They|We|I|If|When|While|Before|After|Until|Till|Once|Though)\b/;

/**
 * Lowercase words that carry no place claim even when capitalised mid-sentence.
 *
 * The furniture list above only applies before a run has started, because "The"
 * and "In" can legitimately open a name. A capitalised word in the middle of a
 * sentence is a different case: "it reports 2,286 features and 21 landmarks were
 * omitted" capitalises nothing, but "Named places in the data:" is a heading and
 * "Since the absence of data isn't" is a clause. Both were reported as invented
 * places.
 *
 * A run consisting only of these words is not a place claim. A run that contains
 * one alongside real words is fine - "Union Square Hotel" keeps "Square".
 */
const NON_PLACE_WORDS = new Set([
  'feature', 'features', 'landmark', 'landmarks', 'named', 'since', 'note',
  'notes', 'data', 'map', 'maps', 'list', 'lists', 'total', 'area', 'omitted',
  'shown', 'provided', 'available', 'missing', 'partial', 'following',
  'answer', 'question', 'result', 'results', 'detail', 'details', 'summary',
  'example', 'examples', 'above', 'below', 'here', 'there', 'overall',
  'approx', 'approximately', 'roughly', 'about', 'around', 'including',
  'based', 'using', 'according', 'per', 'via', 'along', 'near', 'next',
  'previous', 'first', 'second', 'third', 'last', 'same', 'other', 'another',
  'such', 'each', 'every', 'some', 'many', 'most', 'few', 'all', 'both',
]);

/** Whether every word of a candidate is a word that names no place. */
function allWordsNonPlace(text: string): boolean {
  const words = text
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  return words.length > 0 && words.every((w) => NON_PLACE_WORDS.has(w));
}

/**
 * Words that end a candidate rather than continue it.
 *
 * A place word at the end of a title-case run means the name is finished - "Osha
 * Thai (restaurant)" should yield "Osha Thai", not "Osha Thai Restaurant". These
 * are the words that reliably terminate a name.
 */
const PLACE_SUFFIXES_FOR_TERMINATION = new Set([
  'street', 'st', 'road', 'rd', 'avenue', 'ave', 'boulevard', 'blvd', 'lane', 'ln',
  'drive', 'dr', 'court', 'ct', 'way', 'place', 'pl', 'square', 'sq', 'terrace',
  'walk', 'close', 'crescent', 'parade', 'highway', 'hwy', 'station', 'terminal',
  'mall', 'plaza', 'park', 'garden', 'bridge', 'stadium', 'airport',
]);

/**
 * Candidate place names in a free-text answer.
 *
 * Built by scanning forward from each capitalised word and greedily taking the
 * longest run that stays a plausible name, rather than by matching a fixed
 * Title Case shape. The fixed shape is what broke: it had no way to represent a
 * lowercase connector, so every multi-word name was cut in half and each half was
 * then reported to the caller as an invented place.
 *
 * Where two candidates overlap - "Osha Thai (restaurant)" produces both "Osha
 * Thai" and "Restaurant" - the longer one wins, because a name that contains
 * another candidate is the real claim and the inner one is a word of it.
 */
function extractQuotedOrTitled(answer: string): string[] {
  const out: string[] = [];

  // Quotation is taken as an explicit claim of a name, so a quoted string needs no
  // place word to be checked. The exception is a quoted *word* rather than a name:
  // a maplet header says features were omitted from the "feature" and "landmark"
  // layers, and quoting a layer name is not a claim that a place exists.
  for (const m of answer.matchAll(/"([^"]{2,60})"/g)) {
    const quoted = m[1]!.trim();
    if (allWordsNonPlace(quoted)) continue;
    out.push(quoted);
  }

  // Runs of capitalised words, split on anything that cannot be part of a name.
  //
  // This used to try to reconstruct exact name boundaries and then require the
  // reconstruction to match the data exactly. That is the wrong shape for the job:
  // these are comma-separated lists of prose, and every boundary rule guessed here
  // was wrong somewhere - swallowing the next item in a list, stopping halfway
  // through a real name, splitting at "of". The measured cost was six invented
  // places reported in an answer that named ten genuine businesses.
  //
  // So the run is deliberately generous and the *matching* is tolerant: a run is a
  // hallucination only when no known name sits inside it and no known name's words
  // are all present in it. An over-long run therefore costs nothing, where an
  // over-tight one invented failures.
  const words = answer.split(/\s+/);
  let parts: string[] = [];

  const flush = (): void => {
    if (parts.length === 0) return;
    const text = parts.join(' ');
    parts = [];
    if (text.length < 3) return;
    if (allWordsNonPlace(text)) return;
    if (hasPlaceWord(text)) out.push(text);
  };

  for (let i = 0; i < words.length; i++) {
    const raw = words[i]!;

    // An opening bracket or a dash starts something that is not a name.
    if (/^[[({—–]/.test(raw)) {
      flush();
      continue;
    }

    // A capitalised word that is plainly sentence furniture does not begin a name:
    // "Visit Blue Bottle Cafe" must yield "Blue Bottle Cafe", not "Visit Blue
    // Bottle Cafe". Leading furniture is dropped only while no name has started,
    // so "The Embarcadero" keeps its article.
    if (parts.length === 0 && SENTENCE_FURNITURE.test(raw)) {
      continue;
    }

    const word = stripPunctuation(raw);
    if (word === '') {
      flush();
      continue;
    }

    // Punctuation *trailing* a word ends the run after that word, not before it.
    // "Thai," is the last word of "Osha Thai", so flushing on the comma rather
    // than after it reported "Osha" and invented the rest.
    const endsRun = /[,;:)\]}.!?—–]$/.test(raw);

    const isCapitalised = /^[A-Z0-9][a-z0-9'’-]*$/.test(word);
    // "&" joins the halves of a name exactly as "of" does: "Beckett & Robb",
    // "Boudin Bakery & Cafe".
    const isConnector =
      (NAME_CONNECTORS.has(word.toLowerCase()) || word === '&') &&
      parts.length > 0 &&
      i + 1 < words.length;

    if (isCapitalised) {
      parts.push(word);
    } else if (isConnector) {
      const after = stripPunctuation(words[i + 1] ?? '');
      // A connector only continues a name if a capitalised word follows it.
      if (/^[A-Z0-9][a-z0-9'’-]*$/.test(after)) {
        parts.push(word, after);
        i++;
      } else {
        flush();
      }
    } else {
      flush();
    }

    if (endsRun) flush();
    // A run longer than this is prose, not a place name.
    else if (parts.length >= 6) flush();
  }
  flush();

  return [...new Set(out)];
}

/**
 * Trailing punctuation and brackets, which are not part of a name.
 *
 * `&` is kept wherever it appears, because it is a name connector rather than
 * decoration: "Beckett & Robb" and "Boudin Bakery & Cafe" are single names, and
 * stripping the ampersand split both in half and then reported each half as an
 * invented place.
 */
function stripPunctuation(word: string): string {
  return word.replace(/^[^\p{L}\p{N}&]+|[^\p{L}\p{N}%&'-]+$/gu, '');
}

/** Whether `needle` begins `haystack` on a word boundary. */
function startsWithWord(haystack: string, needle: string): boolean {
  if (needle === '' || !haystack.startsWith(needle)) return false;
  const rest = haystack.slice(needle.length);
  return rest === '' || /^[^\p{L}\p{N}]/u.test(rest);
}

/** Whether `needle` appears inside `haystack` on word boundaries. */
function containsWord(haystack: string, needle: string): boolean {
  if (needle === '') return false;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const before = at === 0 ? '' : haystack.slice(at - 1, at);
    const after = haystack.slice(at + needle.length);
    const okBefore = before === '' || /[^\p{L}\p{N}]/u.test(before);
    const okAfter = after === '' || /^[^\p{L}\p{N}]/u.test(after);
    if (okBefore && okAfter) return true;
    from = at + 1;
  }
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

/**
 * True when the answer declines or says it cannot tell.
 *
 * Matches refusal *shapes*, not refusal *words*. The old version fired on the
 * bare word "cannot" anywhere in a paragraph, so a real answer on the omission
 * task - "a missing feature here cannot be taken as proof of absence" - was scored
 * as a refusal. It is the most common English hedge in technical writing and
 * carries almost no evidence of declining to answer.
 *
 * What distinguishes a refusal here is the subject of the inability: the model
 * saying it cannot answer, rather than describing something that cannot be
 * concluded. So the patterns require a first-person or imperative frame, or the
 * specific stock phrases.
 *
 * Deliberately still broad in the other direction. A missed refusal is a false
 * negative in a metric that errs toward under-reporting elsewhere, and this
 * function's job is only to catch the obvious "I cannot tell you" answers.
 */
export function isRefusal(answer: string): boolean {
  const text = answer.toLowerCase();

  // Stock phrases with no grammatical frame to rely on.
  if (/\bnot (?:enough|sufficient) (?:information|data|detail)\b/.test(text)) return true;
  // "no map data available", "no map data was provided", "no information is
  // present". The copula is optional because "available" is an adjective that
  // stands alone here, which is the commonest phrasing in practice.
  if (
    /\bno (?:map|data|information)\b\s*(?:is |are |was |were |has been |have been )?\b(?:provided|given|supplied|available|present|included|shown)?\b/.test(
      text,
    )
  )
    return true;
  if (/\b(?:the )?(?:map|data) (?:is|was) (?:absent|missing|unavailable|not (?:provided|given))\b/.test(text))
    return true;
  if (/\bwithout (?:any )?(?:map|data) data\b/.test(text)) return true;

  // "I cannot tell", "I can't determine", "unable to answer from this".
  // The subject has to be the model, not the world.
  if (/\b(?:i|we) (?:cannot|can't|can not|am unable to|'m unable to)\b[^.!?]{0,40}\b(?:tell|determine|determine|answer|say|confirm|verify|establish|assess|know|be sure)\b/.test(text))
    return true;
  if (/\b(?:i|we) am (?:not able|unable)\b/.test(text)) return true;
  if (/\bunable to (?:answer|determine|tell|say|confirm|verify)\b/.test(text)) return true;

  // A refusal is usually short. A long paragraph that happens to contain "cannot"
  // is an answer, not a decline.
  const sentences = answer.split(/[.!?]+\s/).filter((s) => s.trim().length > 0);
  if (sentences.length > 3) {
    const last = sentences.slice(-2).join(' ');
    return /\b(?:i|we) (?:cannot|can't|am unable to)\b/i.test(last);
  }

  // Short answer: the hedge is the whole content.
  return /\b(?:cannot|can't|can not|unable to)\s+(?:tell|determine|answer|say|confirm|verify|establish|assess|know)\b/.test(
    text,
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
  /**
   * A refusal makes no connectivity claim, even when it names one.
   *
   * Measured on the synthetic area: the no-map arm answered "whether places are
   * connected by walkable paths or isolated cannot be determined", which contains
   * the word "isolated" inside a refusal and passed against a 20-component graph.
   * Two of three refusals passed that way; the third failed only because it used
   * different words. An unstated position is not agreement, in either direction.
   */
  if (isRefusal(answer)) return false;

  const components = connectedComponents(graph);
  const isolated = components > 1;
  const claimsIsolated = /\b(isolated|not connected|no path|separate)\b/i.test(answer);
  const claimsAllConnected = /\b(all (are )?connected|every one is|fully connected)\b/i.test(
    answer,
  );

  if (isolated) return claimsIsolated && !claimsAllConnected;

  // Answering "yes, they are all connected" is required, not merely the absence
  // of a contrary claim. Defaulting to correct when the answer says neither is
  // how a refusal, an empty answer, or an unrelated sentence scores as a pass:
  // the text "I cannot determine this" makes no connectivity claim at all, and
  // an unstated position is not agreement.
  return claimsAllConnected && !claimsIsolated;
}

/**
 * Whether an answer reported what the maplet left out.
 *
 * This is the only task that tests the protocol rather than the map, and the only
 * one a truncated file cannot pass by accident. A raw GeoJSON cut short is
 * *silently* incomplete: nothing in it says data is missing, so the natural
 * reading is "this area holds only what I can see". A maplet that says
 * `omitted: - {layer: feature, count: 3973}` gives the model something to report,
 * and reporting it is the capability.
 *
 * Two things are required, and the second is the one that catches a fluent,
 * confident wrong answer: it must acknowledge the gap, and it must not conclude
 * the area is bare. "This area appears empty apart from a few places" reports no
 * gap and reads as if it did.
 */
export function scoreOmission(
  answer: string,
  omitted: readonly { layer: string; count: number }[],
  emittedNodes: number,
): { correct: boolean; flags: string[] } {
  const total = omitted.reduce((n, o) => n + o.count, 0);
  const flags: string[] = [];

  if (total <= 0) return { correct: false, flags: ['nothing was actually omitted'] };

  /**
   * Does the answer assert the data is complete?
   *
   * Checked first, and failing, because it is the claim this task exists to
   * detect. The scorer was polarity-blind: "nothing in it states that any features
   * were left out" contains the word "truncation" in a negated frame and was
   * scored as an acknowledgement. Three of three geojson answers passed while
   * saying the opposite - two of them "no omission is flagged anywhere in this
   * data" - and the run reported a clean 100%.
   *
   * So the check is for the *assertion*, not for the vocabulary.
   */
  const claimsComplete =
    /\b(?:appears?|seems?|is|was|looks?)\s+(?:to\s+be\s+)?(?:fully\s+)?complet(?:e|ion)\b/i.test(
      answer,
    ) ||
    /\bno\s+(?:omission|omissions|features?\s+(?:were|have\s+been)?\s*(?:left\s+out|omitted|dropped|excluded))\b/i.test(
      answer,
    ) ||
    /\bnothing\b[^.!?]{0,60}\b(?:left\s+out|omitted|dropped|excluded|truncated)\b/i.test(answer) ||
    /\bfound\s+none\b/i.test(answer) ||
    /\b(?:runs?|numbering|counts?|sequences?)\b[^.!?]{0,40}\b(?:without\s+gaps?|unbroken|consecutive|contiguous)\b/i.test(
      answer,
    ) ||
    /\ball\b[^.!?]{0,30}\b(?:accounted\s+for|present|there)\b/i.test(answer);

  if (claimsComplete) flags.push('asserted the data is complete despite a declared omission');

  /**
   * Acknowledging the gap, in a positive frame.
   *
   * Now that completeness is handled above, a bare vocabulary match is safe
   * enough: an answer that says "omitted" and does not claim completeness is
   * reporting the gap.
   */
  const acknowledges =
    /\b(omitted|left out|not shown|excluded|dropped|removed|truncated|not included|partial|incomplete|only (?:part|some))\b/i.test(
      answer,
    ) || acknowledgesOmission(answer);

  const claimsBare =
    /\b(bare|deserted|nothing (?:else )?(?:here|nearby)|no (?:other )?(?:features|buildings|places|trees)|empty of)\b/i.test(
      answer,
    );

  if (!acknowledges) flags.push('did not acknowledge anything was left out');
  if (claimsBare) flags.push('described the area as bare despite a declared omission');

  /**
   * Sizing the gap is reported, not required.
   *
   * A model that says "several thousand features were left out" has understood
   * the point. Demanding an exact integer punishes honest approximation, and the
   * number it would be compared against is itself an artefact of the budget, not
   * a fact about the area.
   */
  const thousands = Math.floor(total / 1000);
  const citesAmount =
    /\b(thousand|thousands)\b/i.test(answer) ||
    (thousands >= 1 && new RegExp(`\\b${thousands},?\\d{3}\\b`).test(answer)) ||
    new RegExp(`\\b${Math.round(total / 100) / 10}k\\b`, 'i').test(answer);

  if (acknowledges && !citesAmount && emittedNodes > 0) {
    flags.push('acknowledged the gap without sizing it');
  }

  /**
   * Did the answer name *what* was omitted, not merely that something was?
   *
   * Without this the task does not discriminate at all. Measured: given no map
   * data, two of three models answered it correctly - "any features that exist in
   * this area have been left out entirely, meaning the map is incomplete" - which
   * is a true statement available to every arm. The capability measured was
   * "notice incompleteness", not "use the omission record".
   *
   * Requiring a category that appears in the record separates them. The no-map arm
   * cannot produce "trees" or "roads" or a count of them, because it has never
   * seen them; only an answer that read the record, or a raw file complete enough
   * to enumerate them, can.
   *
   * A magnitude citation also counts, for a source that reports a count without
   * naming its category.
   */
  const layers = [...new Set(omitted.map((o) => o.layer))];
  const omissionWord =
    /\b(omitted|left\s+out|dropped|excluded|not\s+shown|removed|truncated|clipped|missing)\b/i;

  const namesCategory = layers.some((l) =>
    new RegExp(`\\b${l.replace(/[^A-Za-z0-9]/g, '')}s?\\b`, 'i').test(answer),
  );

  /**
   * A count, and it has to be *this* count.
   *
   * The first version accepted any three-to-five-digit number next to an omission
   * word, which matched "longitude -150" in an answer that had never seen a tree
   * in its life. Two of three no-map answers were passing on that.
   *
   * Now the number must be within 20% of the recorded total, or the answer must
   * say "thousands" outright. A distance in kilometres no longer qualifies.
   */
  const totalOmitted = omitted.reduce((n, o) => n + o.count, 0);
  const lo = totalOmitted * 0.8;
  const hi = totalOmitted * 1.2;
  const citesThousands = /\b(?:thousands?|several\s+thousand|many\s+thousand)/i.test(answer);
  const citesNumber = omissionWord.test(answer) &&
    [...answer.matchAll(/\b(\d{1,3}(?:,\d{3})+|\d{3,6})\b/g)].some((m) => {
      const n = Number(m[1]!.replace(/,/g, ''));
      return n >= lo && n <= hi;
    });

  const namesWhat = namesCategory || citesThousands || citesNumber;

  if (!namesWhat) {
    flags.push('acknowledged a gap without naming what was omitted');
  }

  return { correct: !claimsBare && !claimsComplete && acknowledges && namesWhat, flags };
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
  // The even case averages the two middle values and must not round. Rounding
  // turned a median of 2.5 into 3, which is a 20% error on the token-cost figure
  // - the number the whole cost comparison rests on.
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
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

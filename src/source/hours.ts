/**
 * Opening hours.
 *
 * `opening_hours` is in OSM and has been ingested into the wire document since
 * the first version. It never reached the graph, which is a defect rather than a
 * missing feature: an agent asked "is the pharmacy open" would read a name, a
 * tag, and no hours, and then guess. It usually guesses open, because that is
 * the answer that sounds helpful. A closed pharmacy is a wasted trip at 2am.
 *
 * The grammar is also where this earns its place. OSM's `opening_hours` is a
 * small language with weekday selectors, ranges, exceptions, "open" and "closed"
 * literals, and 24/7. A naive `split('-')` gets most of it wrong, and the
 * failure is silent: it returns a confidently wrong hour.
 *
 * Everything here is evaluated against an explicit timestamp rather than "now",
 * so the same answer is reproducible in a test, in a replay, or on a server whose
 * clock disagrees with the caller's.
 */

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export interface OpenState {
  /** True when open at the evaluated instant. */
  open: boolean;
  /** Opening and closing time on that day, when the rule is a simple range. */
  opensAt?: string;
  closesAt?: string;
  /**
   * A rule that cannot be reduced to a range: overnight hours, multiple windows,
   * or a `sunrise`-style variable. Present so the agent can be told "the hours
   * are unusual here" rather than given a fabricated pair of times.
   */
  rule?: string;
  /**
   * True when the source gave no usable hours at all.
   *
   * Distinct from `open: false`. "Unknown" must never render as "closed": an
   * agent that reports unknown as shut will tell someone a place is unusable
   * when nobody ever recorded its hours.
   */
  unknown: boolean;
}

interface Window {
  /** Minutes from midnight. Values above 1440 represent past-midnight close. */
  from: number;
  to: number;
  /**
   * True when the window ends on the following day, e.g. `18:00-02:00`.
   *
   * Recorded at parse time, because it cannot be recovered from `from` and
   * `to` once the overflow has been folded into `to`.
   */
  crossesMidnight: boolean;
}

/**
 * Weekday spellings.
 *
 * OSM uses the two-letter forms (`Mo`, `Tu`, `Su`) and most writers use the
 * three-letter ones (`Mon`, `Tue`, `Sun`). Both appear in real data, and a
 * lookup that misses one returns `undefined` rather than an error - so a missed
 * spelling silently turns every rule for that day into "no hours listed", and
 * a pharmacy open nine hours a day reads as unconstrained. Both families are
 * therefore present, and the input is lowercased before lookup.
 */
const DAY_TOKENS: Record<string, number> = {
  su: 0, sun: 0, sunday: 0,
  mo: 1, mon: 1, monday: 1,
  tu: 2, tue: 2, tues: 2, tuesday: 2,
  we: 3, wed: 3, weds: 3, wednesday: 3,
  th: 4, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fr: 5, fri: 5, friday: 5,
  sa: 6, sat: 6, saturday: 6,
};

/**
 * Evaluate an `opening_hours` string at an instant.
 *
 * Supports the subset an agent actually acts on: weekday lists and ranges
 * (`Mo-Fr`), time ranges (`09:00-17:00`), the `24/7` literal, `off`/`closed`,
 * and public holidays. Anything it cannot parse returns `unknown`, which is the
 * correct answer for an unrecognised grammar rather than a default-open guess.
 *
 * @param at The instant to evaluate.
 * @param utcOffsetMinutes The place's offset from UTC in minutes, e.g. `-420`
 *   for Pacific Daylight Time. Opening hours are a property of the place, not of
 *   the machine doing the arithmetic, so this must be the local offset where
 *   the shop is. Passing nothing falls back to the host's own timezone, which is
 *   correct only when the host and the place agree - otherwise a server in one
 *   country reports a shop in another as open at 3am, or shut at noon.
 */
export function evaluateOpeningHours(
  spec: string | undefined,
  at: Date,
  utcOffsetMinutes?: number,
): OpenState {
  if (!spec || spec.trim() === '') return unknownState();

  const raw = spec.trim();
  const lower = raw.toLowerCase();

  // The two literals that short-circuit everything else.
  if (lower === '24/7') {
    return { open: true, opensAt: '00:00', closesAt: '24:00', unknown: false };
  }
  if (lower === 'off' || lower === 'closed') {
    return { open: false, rule: 'always closed', unknown: false };
  }

  // Shift the instant into the place's local frame and read the clock with UTC
  // getters. Calling `getHours()` directly would read the host's clock, which
  // is the bug this indirection exists to prevent.
  const offset = utcOffsetMinutes ?? -at.getTimezoneOffset();
  const localMs = at.getTime() + offset * 60000;
  const weekday = new Date(localMs).getUTCDay() as Weekday;
  const minutes =
    new Date(localMs).getUTCHours() * 60 + new Date(localMs).getUTCMinutes();

  // The rule governing today. Absence means unconstrained, which most people
  // read as open - but reporting times we do not have would be a fabrication,
  // so the state is open with the rule recorded and no times.
  const applicable = ruleFor(lower, weekday);
  if (applicable === null) {
    return { open: true, rule: 'no hours listed for this day', unknown: true };
  }

  if (applicable === 'off' || applicable === 'closed') {
    return { open: false, rule: 'closed on this day', unknown: false };
  }

  const windows = parseWindows(applicable);
  if (windows.length === 0) {
    return { open: true, rule: applicable, unknown: true };
  }

  // Yesterday's rule, because a window can run past midnight and the spillover
  // is the reason someone is standing outside a bar at 1am.
  //
  // A `Fr-Sa 18:00-02:00` rule means Friday 18:00 to *Saturday* 02:00. So the
  // early hours of a day are governed by the previous day's rule, not this
  // one. Checking only today's rule would close the place at 18:00 sharp and
  // report it shut to someone standing inside it.
  const yesterday = ruleFor(lower, ((weekday + 6) % 7) as Weekday);
  const spillover =
    yesterday === null ? [] : parseWindows(yesterday).filter((w) => w.crossesMidnight);

  // Today's window, as it applies to today. When it crosses midnight, only the
  // part from the opening time onward belongs to today - the after-midnight
  // segment is tomorrow's. Widening today's window to include it would report
  // a bar open at 1am on Friday, because Friday's 18:00-02:00 window has a
  // small after-midnight remainder that has not happened yet.
  const openNow = (w: Window): boolean =>
    w.crossesMidnight
      ? minutes >= w.from
      : minutes >= w.from && minutes < w.to;
  // Yesterday's overnight window is still running during today's early hours.
  const openFromSpill = (w: Window): boolean => minutes < w.to - 1440;

  // A single window that neither crosses midnight nor has yesterday's spillover
  // in play is the common case, and worth stating as an exact pair of times.
  if (windows.length === 1 && spillover.length === 0 && !windows[0]!.crossesMidnight) {
    const w = windows[0]!;
    return {
      open: openNow(w),
      opensAt: formatMinutes(w.from),
      closesAt: formatMinutes(w.to),
      unknown: false,
    };
  }

  // Otherwise the rule is too complex to reduce to one pair of times without
  // being wrong at one end: several windows, or a window crossing midnight.
  // The rule is reported verbatim so the agent can reason about it.
  const open = windows.some(openNow) || spillover.some(openFromSpill);
  return { open, rule: applicable, unknown: false };
}

/**
 * The rule governing a given weekday, last match winning.
 *
 * `null` when no selector mentions the day, which is different from a rule that
 * explicitly closes it.
 */
function ruleFor(spec: string, weekday: Weekday): string | null {
  let found: string | null = null;
  for (const part of splitRules(spec)) {
    if (part.selector === null) continue;
    if (!selectorMatches(part.selector, weekday)) continue;
    found = part.rule;
  }
  return found;
}

function unknownState(): OpenState {
  return { open: true, unknown: true, rule: 'no opening hours recorded' };
}

/**
 * Split on semicolons, except inside a parenthesised exception group.
 *
 * `Mo-Fr 09:00-17:00; Sa 10:00-14:00 (PH off)` is one rule with an exception,
 * and splitting it at the last semicolon turns the exception into a weekday
 * selector that matches nothing.
 */
function splitRules(text: string): { selector: string | null; rule: string }[] {
  const out: { selector: string | null; rule: string }[] = [];
  let depth = 0;
  let current = '';

  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) {
      pushRule(out, current);
      current = '';
    } else {
      current += ch;
    }
  }
  pushRule(out, current);
  return out;
}

function pushRule(
  out: { selector: string | null; rule: string }[],
  text: string,
): void {
  const trimmed = text.trim();
  if (trimmed === '') return;

  // Drop a parenthesised exception: it applies conditionally, and evaluating it
  // unconditionally would close a shop on a holiday it is actually open.
  const withoutException = trimmed.replace(/\([^)]*\)/g, ' ').trim();

  const spaceAt = withoutException.indexOf(' ');
  if (spaceAt <= 0) {
    out.push({ selector: null, rule: withoutException });
    return;
  }
  out.push({
    selector: withoutException.slice(0, spaceAt),
    rule: withoutException.slice(spaceAt + 1).trim(),
  });
}

/** Whether a weekday selector covers today. */
function selectorMatches(selector: string, weekday: number): boolean {
  for (const token of selector.split(',')) {
    const t = token.trim();
    if (t === '') continue;
    if (t === 'PH' || t === 'SH') continue;

    // A bare weekday, or a range like `mo-fr` or `Mo-We,Su`.
    const dash = t.indexOf('-');
    if (dash > 0) {
      const from = DAY_TOKENS[t.slice(0, dash).trim()];
      const to = DAY_TOKENS[t.slice(dash + 1).trim()];
      if (from === undefined || to === undefined) continue;
      // Ranges may wrap: `Sa-Mo` means Saturday through Monday.
      if (from <= to) {
        if (weekday >= from && weekday <= to) return true;
      } else if (weekday >= from || weekday <= to) return true;
      continue;
    }

    const d = DAY_TOKENS[t];
    if (d !== undefined && d === weekday) return true;
  }
  return false;
}

/** Pull `HH:MM-HH:MM` pairs out of a rule body. */
function parseWindows(rule: string): Window[] {
  const out: Window[] = [];
  const re = /(\d{1,2}):?(\d{2})\s*-\s*(\d{1,2}):?(\d{2})/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(rule)) !== null) {
    const from = Number(m[1]) * 60 + Number(m[2]);
    const rawTo = Number(m[3]) * 60 + Number(m[4]);
    // A closing time at or below the opening time means the window runs past
    // midnight. The end is stored as an absolute offset (past 1440) so the
    // window stays a single contiguous range, and `crossesMidnight` is kept
    // alongside it.
    //
    // The flag is not redundant. Folding the overflow into `to` and then
    // re-deriving "does this cross midnight" by comparing `to <= from` can never
    // succeed, because the folded value is always larger. That silently loses
    // every overnight window, which is how a bar came to be reported shut at
    // 1am on a Friday.
    const crossesMidnight = rawTo <= from;
    const to = crossesMidnight ? rawTo + 1440 : rawTo;
    out.push({ from, to, crossesMidnight });
  }
  return out;
}

function formatMinutes(m: number): string {
  const wrapped = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const min = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Whether a place is open right now, as a short phrase for a graph node.
 *
 * Three states, never two. "unknown" is separated from "closed" because the
 * two lead to opposite advice: one means go and find out, the other means go
 * somewhere else.
 */
export function openingPhrase(
  spec: string | undefined,
  at: Date,
  utcOffsetMinutes?: number,
): string | undefined {
  const s = evaluateOpeningHours(spec, at, utcOffsetMinutes);
  if (s.unknown) return s.rule ?? 'hours unknown';
  if (!s.open) return s.rule ?? 'closed';
  if (s.opensAt && s.closesAt) return `${s.opensAt}-${s.closesAt}`;
  return 'open';
}

/** `is_open: true` with no hours is a claim about *now*, so it needs a clock. */
export const HOURS_TIMESTAMP_NOTE =
  'open/closed evaluated at request time; call get_opening_hours for the parsed rule';
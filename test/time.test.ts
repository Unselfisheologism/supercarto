import { describe, expect, it } from 'vitest';
import { evaluateOpeningHours, openingPhrase } from '../src/source/hours.js';
import { sunPosition, needsLight } from '../src/source/sun.js';
import { toMaplet, type GeoJsonFeature } from '../src/index.js';

/**
 * Opening hours and sun position.
 *
 * These two are in the same file because they are the same feature from the
 * agent's side: knowing a place exists is not enough when the question is
 * "can I go there now" and "will I be able to see where I am going".
 *
 * Both were previously ingested and never emitted. That is the specific class
 * of bug these tests exist to prevent: a field that is parsed, stored, and
 * silently dropped, so the model has to guess.
 */

const BBOX = { west: -122.42, south: 37.77, east: -122.41, north: 37.78 };

/** A local-time instant, so weekday assertions are not timezone-dependent. */
function local(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

/**
 * A UTC instant.
 *
 * Sun tests use this rather than `local`, because solar position is a function
 * of an absolute instant. A test that reads the machine's local clock asserts
 * something about the developer's timezone, not about the astronomy, and passes
 * in one city while failing in another.
 */
function utc(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
}

function poi(id: number, props: Record<string, unknown>): GeoJsonFeature {
  return {
    type: 'Feature',
    id,
    properties: props,
    geometry: { type: 'Point', coordinates: [-122.4175, 37.775] },
  };
}

describe('opening hours', () => {
  it('reads a weekday range', () => {
    // Wednesday, midday.
    const at = local(2026, 10, 7, 12);
    expect(evaluateOpeningHours('Mo-Fr 09:00-17:00', at).open).toBe(true);
  });

  it('reports closed outside the window', () => {
    // The specific failure this prevents: an agent telling someone a closed
    // pharmacy is open at 2am.
    const at = local(2026, 10, 7, 2);
    expect(evaluateOpeningHours('Mo-Fr 09:00-17:00', at).open).toBe(false);
  });

  it('handles 24/7', () => {
    const at = local(2026, 10, 7, 3);
    const s = evaluateOpeningHours('24/7', at);
    expect(s.open).toBe(true);
    expect(s.opensAt).toBe('00:00');
    expect(s.closesAt).toBe('24:00');
  });

  it('distinguishes unrecorded from closed', () => {
    // This is the whole reason the field is omitted rather than defaulted.
    // `unknown` must never read as `closed`: an agent told a place is shut will
    // send someone elsewhere when nobody ever recorded its hours.
    const at = local(2026, 10, 7, 12);
    const missing = evaluateOpeningHours(undefined, at);
    expect(missing.unknown).toBe(true);

    const closed = evaluateOpeningHours('off', at);
    expect(closed.unknown).toBe(false);
    expect(closed.open).toBe(false);
  });

  it('keeps a bar open past midnight', () => {
    // `Fr-Sa 18:00-02:00` means Friday 18:00 to Saturday 02:00, so the
    // early hours of Saturday are governed by Friday's rule. Checking only
    // today's rule would report the bar shut at 19:00 to someone standing
    // inside it, which is the exact failure this guards against.
    const fridayEvening = local(2026, 10, 2, 19); // Friday
    expect(evaluateOpeningHours('Fr-SA 18:00-02:00', fridayEvening).open).toBe(true);

    // Past closing on the following day.
    const saturdayLate = local(2026, 10, 3, 2, 30);
    expect(evaluateOpeningHours('Fr-Sa 18:00-02:00', saturdayLate).open).toBe(false);
  });

  it('treats the early hours as belonging to the previous day', () => {
    // Friday 01:00 is not covered by Friday's 18:00-02:00, because the rule
    // opens at 18:00 on Friday and runs to 02:00 on Saturday.
    const fridayEarly = local(2026, 10, 2, 1);
    expect(evaluateOpeningHours('Fr-Sa 18:00-02:00', fridayEarly).open).toBe(false);

    // Saturday 01:00 *is*, via Friday's spillover.
    const saturdayEarly = local(2026, 10, 3, 1);
    expect(evaluateOpeningHours('Fr-Sa 18:00-02:00', saturdayEarly).open).toBe(true);
  });

  it('cannot reduce an overnight window to a single pair of times', () => {
    // 18:00-02:00 is not expressible as one open/close pair on the day it
    // starts, so the rule is reported instead of a misleading "18:00-02:00"
    // that an agent would read as 18:00 to 02:00 the same evening.
    const s = evaluateOpeningHours('Fr-Sa 18:00-02:00', local(2026, 10, 2, 19));
    expect(s.rule).toContain('18:00-02:00');
    expect(s.opensAt).toBeUndefined();
    expect(s.closesAt).toBeUndefined();
  });

  it('spells out a multiple-window rule rather than faking one pair of times', () => {
    // 09:00-12:00 and 13:00-17:00 cannot be reduced to a single open/close pair
    // without being wrong at one end. The rule is reported instead.
    const at = local(2026, 10, 7, 10);
    const s = evaluateOpeningHours('Mo-Fr 09:00-12:00,13:00-17:00', at);
    expect(s.open).toBe(true);
    expect(s.rule).toBeTruthy();
    expect(s.opensAt).toBeUndefined();
  });

  it('ignores a holiday exception rather than applying it unconditionally', () => {
    // A spec with an exception applies the exception only on that date.
    // Evaluating it always would close the shop every day of the year.
    const ordinary = local(2026, 10, 7, 12);
    expect(evaluateOpeningHours('Mo-Fr 09:00-17:00 (PH off)', ordinary).open).toBe(true);
  });

  it('respects the last matching rule when several apply', () => {
    // OSM override semantics: a later rule beats an earlier one.
    const at = local(2026, 10, 7, 12); // Wednesday
    expect(evaluateOpeningHours('Mo-Su 09:00-17:00; We off', at).open).toBe(false);
  });

  it('handles a wrapping weekday range', () => {
    // Saturday to Monday runs past the end of the week, so Monday has to be
    // included. A parser that assumes `from <= to` drops it and leaves a shop
    // that is open on Sunday reading as unrecorded.
    const sunday = local(2026, 10, 4, 12);
    expect(evaluateOpeningHours('Sa-Mo 10:00-14:00', sunday).open).toBe(true);
    const tuesday = local(2026, 10, 6, 12);
    expect(evaluateOpeningHours('Sa-Mo 10:00-14:00', tuesday).unknown).toBe(true);
  });

  it('reports unknown for a grammar it does not understand', () => {
    // An unrecognised spec must produce unknown, not a default-open guess.
    const at = local(2026, 10, 7, 12);
    const s = evaluateOpeningHours('sunrise-sunset', at);
    expect(s.unknown).toBe(true);
  });

  it('phrases a closed shop as closed and an open one with its hours', () => {
    expect(openingPhrase('Mo-Fr 09:00-17:00', local(2026, 10, 7, 12))).toBe('09:00-17:00');
    // Known hours, currently shut. Distinct from an unrecorded bench.
    expect(openingPhrase('Mo-Fr 09:00-17:00', local(2026, 10, 7, 22))).toBe('closed');
    // Unrecorded is reported as unknown, never as closed.
    expect(openingPhrase(undefined, local(2026, 10, 7, 22))).toMatch(/no opening hours/);
  });
});

describe('sun position', () => {
  // Each case is stated at solar noon for that longitude, which is the only
  // instant at which "the sun is at its highest" is a meaningful comparison.
  // Solar noon is 12:00 UTC minus four minutes per degree of east longitude.

  it('reports the sun above the horizon at midday', () => {
    // Equinox at the prime meridian: the sun passes almost overhead.
    const s = sunPosition(0, 0, utc(2026, 3, 20, 12));
    expect(s.daylight).toBe(true);
    expect(s.twilight).toBe('day');
    expect(s.elevationDeg).toBeGreaterThan(80);
  });

  it('reports the sun below the horizon at midnight', () => {
    const s = sunPosition(0, 0, utc(2026, 3, 20, 0));
    expect(s.daylight).toBe(false);
    expect(s.twilight).toBe('night');
  });

  it('separates twilight from full night', () => {
    // The case a daylight-only boolean gets wrong: shortly before a June
    // sunrise in London it is dark enough to want a light, but nowhere near
    // night. Reporting a single boolean would force it to one extreme or the
    // other, and would warn someone about a walk that is perfectly ordinary.
    const s = sunPosition(51.5, -0.12, utc(2026, 6, 21, 3));
    expect(s.daylight).toBe(false);
    expect(s.twilight).not.toBe('day');
    expect(s.twilight).not.toBe('night');
  });

  it('reports polar night rather than a fabricated sunrise', () => {
    // Inside the Arctic circle in December the sun does not rise. Emitting a
    // sunrise time there would put a wrong fact in the agent's answer.
    const s = sunPosition(78.2, 15.6, utc(2026, 12, 21, 11));
    expect(s.polar).toBe('night');
    expect(s.sunrise).toBeUndefined();
    expect(s.daylight).toBe(false);
  });

  it('reports polar day rather than a fabricated sunset', () => {
    const s = sunPosition(78.2, 15.6, utc(2026, 6, 21, 11));
    expect(s.polar).toBe('day');
    expect(s.sunset).toBeUndefined();
    expect(s.daylight).toBe(true);
  });

  it('puts sunrise and sunset on the right calendar date', () => {
    // Sunrise is emitted as an absolute instant, so the date has to be the one
    // the reference falls on. A version that anchored this to the epoch gave
    // every sunrise a date in 1970, which is technically an instant and
    // completely useless as an answer.
    const s = sunPosition(37.77, -122.42, utc(2026, 6, 21, 20)); // solar noon, SF
    expect(s.sunrise).toMatch(/^2026-06-2\dT/);
    expect(s.sunset).toMatch(/^2026-06-2\dT/);
  });

  it('is symmetric about solar noon', () => {
    // Sunrise and sunset sit either side of solar noon. An error in the
    // equation of time shifts both together and breaks the spacing, which is
    // how a fifteen-minute sunrise error shows up as a nonsense clock time.
    const s = sunPosition(37.77, -122.42, utc(2026, 6, 21, 20));
    expect(s.elevationDeg).toBeGreaterThan(60);
    const rise = Date.parse(s.sunrise!);
    const set = Date.parse(s.sunset!);
    expect(set - rise).toBeGreaterThan(13 * 3600_000); // a June day is long
    expect(set - rise).toBeLessThan(15.5 * 3600_000);
  });

  it('knows when a torch is worth mentioning', () => {
    const noon = sunPosition(0, 0, utc(2026, 3, 20, 12));
    const midnight = sunPosition(0, 0, utc(2026, 3, 20, 0));
    expect(needsLight(noon)).toBe(false);
    expect(needsLight(midnight)).toBe(true);
  });

  it('works in the southern hemisphere', () => {
    // A sign error in declination would put Sydney's June noon at night.
    const s = sunPosition(-33.87, 151.21, utc(2026, 6, 21, 2)); // solar noon, Sydney
    expect(s.daylight).toBe(true);
    expect(s.elevationDeg).toBeGreaterThan(20);
  });

  it('works at high latitude in winter', () => {
    // Oslo at solar noon on the solstice. The sun only just clears the
    // horizon: 90 - 59.91 - 23.44 = 6.65 degrees. Getting this as a clearly
    // negative number would mean the declination sign was flipped, but a test
    // that assumes "December means dark everywhere above the tropic" would
    // wrongly fail on a correct implementation.
    const noon = sunPosition(59.91, 10.75, utc(2026, 12, 21, 11));
    expect(noon.elevationDeg).toBeGreaterThan(3);
    expect(noon.elevationDeg).toBeLessThan(10);

    // Local midnight, the same day, is well under the horizon.
    const midnight = sunPosition(59.91, 10.75, utc(2026, 12, 21, 23));
    expect(midnight.daylight).toBe(false);
    expect(midnight.elevationDeg).toBeLessThan(-30);
  });
});

describe('hours reach the agent', () => {
  const withHours = [
    {
      type: 'Feature' as const,
      id: 1,
      properties: { highway: 'residential', name: 'Main St' },
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [-122.42, 37.775],
          [-122.41, 37.775],
        ],
      },
    },
    poi(2, { amenity: 'pharmacy', name: 'Central Pharmacy', opening_hours: 'Mo-Fr 09:00-17:00' }),
    poi(3, { amenity: 'cafe', name: 'Blue Bottle', brand: 'Blue Bottle Coffee', opening_hours: '24/7' }),
    poi(4, { amenity: 'bench', name: 'Some Bench' }),
  ];

  it('puts opening hours and brand on the node', () => {
    // 19:00 UTC on a Wednesday is 12:00 in San Francisco, so the pharmacy's
    // 09:00-17:00 window is open. The offset is stated explicitly because
    // opening hours are local to the place, and this test has to give the same
    // answer on a machine set to any timezone.
    const out = toMaplet(withHours, {
      bbox: BBOX,
      budget: 4000,
      compile: { now: utc(2026, 10, 7, 19), utcOffsetMinutes: -420 },
    });

    expect(out.yaml).toMatch(/Central Pharmacy.*hours: 09:00-17:00/);
    expect(out.yaml).toMatch(/Blue Bottle.*brand: Blue Bottle Coffee/);
    // A bench with no recorded hours must not be given a fabricated value.
    expect(out.yaml).not.toMatch(/Some Bench.*hours:/);
  });

  it('marks a closed shop as closed out of hours', () => {
    // 04:00 Pacific. The pharmacy's hours are known and it is shut, which is a
    // different statement from the bench's hours being unknown.
    const out = toMaplet(withHours, {
      bbox: BBOX,
      budget: 4000,
      compile: { now: utc(2026, 10, 7, 11), utcOffsetMinutes: -420 },
    });
    expect(out.yaml).toMatch(/Central Pharmacy.*hours: closed/);
  });

  it('judges the place by its own clock, not the server one', () => {
    // The same instant, read as two places on opposite sides of the date line.
    // 19:00 UTC is 12:00 in San Francisco and 06:00 the next morning in Sydney,
    // so a shop open 09:00-17:00 is open in one and shut in the other. Judging
    // both by the host's clock would make one of these two wrong.
    const at = utc(2026, 10, 7, 19);

    const sanFrancisco = toMaplet(withHours, {
      bbox: BBOX,
      budget: 4000,
      compile: { now: at, utcOffsetMinutes: -420 },
    });
    expect(sanFrancisco.yaml).toMatch(/Central Pharmacy.*hours: 09:00-17:00/);

    const sydney = toMaplet(withHours, {
      bbox: BBOX,
      budget: 4000,
      compile: { now: at, utcOffsetMinutes: 660 },
    });
    expect(sydney.yaml).toMatch(/Central Pharmacy.*hours: closed/);
  });

  it('includes sun in the map header', () => {
    // 04:00 UTC is 21:00 in San Francisco: the sun is a few degrees below the
    // horizon and it is properly dark, but not night. A test pinned exactly at
    // 6.0 degrees of elevation would sit on the day/twilight boundary and pass
    // or fail depending on rounding.
    const out = toMaplet(withHours, {
      bbox: BBOX,
      budget: 4000,
      compile: { now: utc(2026, 6, 21, 4) },
    });
    expect(out.yaml).toMatch(/sun: down/);
    expect(out.yaml).toMatch(/elevation: -?\d/);
    // Three states, not two.
    expect(out.yaml).toMatch(/twilight: (civil|nautical|night)/);
  });

  it('can be switched off for a reproducible compile', () => {
    const out = toMaplet(withHours, {
      bbox: BBOX,
      budget: 4000,
      compile: { now: local(2026, 10, 7, 12), sun: false },
    });
    expect(out.yaml).not.toMatch(/twilight:/);
  });
});
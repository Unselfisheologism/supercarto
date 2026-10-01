/**
 * Solar position.
 *
 * "Will it be dark when I get there" is a question people ask and agents cannot
 * answer from a map. An agent planning a walk, a delivery, or a pickup needs to
 * know whether that will happen in daylight, at twilight, or at 2am in the rain.
 *
 * This is computed rather than fetched. Sun position needs no API key, no data
 * provider, and no network: it is a function of latitude, longitude, and time.
 * That makes it one of the few genuinely free enrichments available, and free
 * in the sense that matters - it cannot fail, time out, or need a key.
 *
 * The algorithm is the standard NOAA approximation. It is accurate to roughly
 * a minute of time over the modern era, which is far beyond what "is it light
 * out" requires. Exact sunrise to the second would need ephemeris tables and
 * buy nothing.
 */

export interface SunState {
  /** Degrees above the horizon. Negative means the sun is below it. */
  elevationDeg: number;
  /** Compass bearing the sun is in. */
  azimuthDeg: number;
  /** True when the sun is above the horizon. */
  daylight: boolean;
  /**
   * Civil twilight, and the three states around it.
   *
   * Distinct from daylight because a person can walk at 6am in June. -6 to +6
   * degrees is the band where the sky is dim but the ground is still visible,
   * and it is exactly when street lighting matters.
   */
  twilight: 'day' | 'civil' | 'nautical' | 'night';
  /** Iso timestamps, or undefined in polar day/night. */
  sunrise?: string;
  sunset?: string;
  /**
   * True when the sun neither rises nor sets on this date at this latitude.
   *
   * Real, and not an edge case worth ignoring: inside the Arctic circle in
   * December there is no sunrise at all. Reporting a fabricated one would put a
   * wrong time in an agent's answer.
   */
  polar: 'day' | 'night' | false;
}

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/**
 * Sun position for a coordinate and instant.
 *
 * @param at Evaluation time. Default now. Pass an explicit time to get a
 *   reproducible answer, which is what makes this testable.
 */
export function sunPosition(lat: number, lon: number, at: Date = new Date()): SunState {
  const jd = toJulianDay(at);

  // Days since the J2000.0 epoch, 2000-01-01T12:00Z. This single value drives
  // both the equation of time and the declination, and it must be the same for
  // both: computing them against different time bases puts sunrise hours away
  // from the hour angle the elevation was computed with, which is exactly the
  // bug this was written to avoid.
  const d = jd - 2451545.0;

  // Mean anomaly of the sun, degrees. 357.5291 is the value at J2000.0 and
  // 0.98560028 the daily advance.
  const meanAnomaly = (357.5291 + 0.98560028 * d) * RAD;

  // Obliquity of the ecliptic, degrees. Slowly decreasing.
  const obliquity = 23.439 - 0.0000004 * d;

  // Sun's ecliptic longitude, degrees.
  const eclipticLongitude = (280.459 + 0.98564736 * d) * RAD;

  // Declination of the sun, degrees. Uses the corrected longitude rather than
  // the mean one, which matters by up to a degree and shows up as a sunrise
  // that is several minutes off through the year.
  const declination =
    Math.asin(Math.sin(obliquity * RAD) * Math.sin(eclipticLongitude)) * DEG;

  // Equation of time, minutes. y is the tangent of half the obliquity; the two
  // tangent terms are what carry the eccentricity and obliquity contributions,
  // and dropping either one costs up to ten minutes.
  const y = Math.tan((obliquity / 2) * RAD) ** 2;
  const eqOfTime =
    4 *
    DEG *
    (y * Math.sin(2 * meanAnomaly) -
      2 * 0.016708634 * Math.sin(meanAnomaly) +
      4 * 0.016708634 * y * Math.sin(meanAnomaly) * Math.cos(2 * meanAnomaly) -
      0.5 * y * y * Math.sin(4 * meanAnomaly) -
      1.25 * 0.016708634 ** 2 * Math.sin(2 * meanAnomaly));

  // True solar time, minutes past local solar midnight.
  //
  // The time-of-day term must be the *fraction* of the Julian day, not the
  // whole value: 86400 is an exact multiple of 1440, so `(jd - 0.5) * 86400 %
  // 1440` discards the time of day entirely and leaves solar noon at
  // midnight. `jd + 0.5` is used because a Julian day rolls over at noon, not
  // midnight, so the fraction is measured from midnight.
  const dayFraction = ((jd + 0.5) % 1 + 1) % 1;
  const trueSolarTime = (dayFraction * 1440 + eqOfTime + 4 * lon + 2880) % 1440;

  const hourAngle = trueSolarTime / 4 - 180;

  const latR = lat * RAD;
  const decR = declination * RAD;
  const haR = hourAngle * RAD;

  const cosZenith =
    Math.sin(latR) * Math.sin(decR) + Math.cos(latR) * Math.cos(decR) * Math.cos(haR);
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZenith))) * DEG;
  const elevation = 90 - zenith;

  // Azimuth, clockwise from north.
  let azimuth: number;
  const denom = Math.cos(latR) * Math.sin(zenith * RAD);
  if (Math.abs(denom) > 1e-9) {
    let cosAz =
      (Math.sin(latR) * Math.cos(zenith * RAD) - Math.sin(decR)) / denom;
    cosAz = Math.max(-1, Math.min(1, cosAz));
    azimuth = Math.acos(cosAz) * DEG;
    if (hourAngle > 0) azimuth = 360 - azimuth;
  } else {
    // At the poles the azimuth is degenerate; the elevation still decides
    // daylight, so a placeholder here does not affect the answer that matters.
    azimuth = lat >= 0 ? 180 : 0;
  }

  const daylight = elevation > 0;
  const twilight: SunState['twilight'] =
    elevation > 6 ? 'day' : elevation > -0.833 ? 'civil' : elevation > -12 ? 'nautical' : 'night';

  // Sunrise and sunset need the hour angle at which the sun crosses -0.833
  // degrees, accounting for refraction and the solar disc's radius.
  const cosHA =
    (Math.sin(-0.833 * RAD) - Math.sin(latR) * Math.sin(decR)) /
    (Math.cos(latR) * Math.cos(decR));
  let polar: SunState['polar'] = false;
  let sunrise: string | undefined;
  let sunset: string | undefined;

  if (cosHA > 1) {
    polar = 'night';
  } else if (cosHA < -1) {
    polar = 'day';
  } else {
    // The sunrise hour angle, in degrees. This is the sun's distance from the
    // meridian at the moment it crosses the horizon, so it converts to minutes
    // at four minutes per degree like any other hour angle.
    const ha = Math.acos(cosHA) * DEG;
    const haMinutes = 4 * ha;
    // Solar noon, in minutes past UTC midnight. Both terms matter: longitude
    // moves noon by four minutes per degree, and the equation of time by up to
    // sixteen more.
    const noonMinutes = 720 - 4 * lon - eqOfTime;
    sunrise = isoFromMinutes(noonMinutes - haMinutes, at);
    sunset = isoFromMinutes(noonMinutes + haMinutes, at);
  }

  return {
    elevationDeg: round(elevation, 1),
    azimuthDeg: round(azimuth, 0),
    daylight,
    twilight,
    ...(sunrise ? { sunrise } : {}),
    ...(sunset ? { sunset } : {}),
    polar,
  };
}

function toJulianDay(at: Date): number {
  return at.getTime() / 86400000 + 2440587.5;
}

/**
 * Minutes past UTC midnight on the reference date to an iso timestamp.
 *
 * The date comes from the reference's *UTC* components, not its local ones.
 * Sunrise and sunset are absolute instants, so anchoring them to the local
 * calendar date would shift the answer by the machine's timezone and make the
 * same map return a different sunrise in Oslo than in Auckland.
 *
 * Wrapping is left to `Date`, which rolls the day over correctly. That matters
 * at high longitude, where solar noon can fall on the previous or next UTC day
 * and a timestamp that refused to roll would put sunrise on the wrong date.
 */
function isoFromMinutes(minutes: number, reference: Date): string {
  const base = Date.UTC(
    reference.getUTCFullYear(),
    reference.getUTCMonth(),
    reference.getUTCDate(),
  );
  const shifted = new Date(base + Math.round(minutes) * 60000);
  return shifted.toISOString().replace(/\.\d+Z$/, 'Z');
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Whether it is dark enough to want artificial light.
 *
 * A separate predicate because "daylight" and "you might want a torch" are
 * different questions, and the answer to the second is what an agent should
 * actually advise on.
 */
export function needsLight(sun: SunState): boolean {
  return sun.elevationDeg < 6;
}
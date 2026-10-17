"""Solar position — port of ``src/source/sun.ts``.

The algorithm is the standard NOAA approximation. It is accurate to roughly a
minute of time over the modern era, which is far beyond what "is it light out"
requires. Exact sunrise to the second would need ephemeris tables and buy
nothing.

Computed rather than fetched: sun position needs no API key, no data provider,
and no network. Free in the sense that matters - it cannot fail, time out, or
need a key, so the map metadata can always include it.
"""

from __future__ import annotations

import datetime as _dt
import math
import re
from dataclasses import dataclass

_RAD = math.pi / 180
_DEG = 180 / math.pi

_ISO_TRIM = re.compile(r"\.\d+Z$")


@dataclass
class SunState:
    #: Degrees above the horizon. Negative means the sun is below it.
    elevationDeg: float
    #: Compass bearing the sun is in.
    azimuthDeg: float
    #: True when the sun is above the horizon.
    daylight: bool
    #: Civil twilight band, and the states around it.
    twilight: str
    #: ISO timestamps, or None in polar day/night.
    sunrise: str | None
    sunset: str | None
    #: Set when the sun does not rise or set today: polar day or polar night.
    polar: str | bool


def sun_position(
    lat: float,
    lon: float,
    at: _dt.datetime | None = None,
) -> SunState:
    """Sun position for a coordinate and instant.

    Pass an explicit time to get a reproducible answer, which is what makes
    this testable; the default is the current instant.
    """
    at = at if at is not None else _dt.datetime.now(_dt.timezone.utc)
    jd = to_julian_day(at)

    # Days since the J2000.0 epoch, 2000-01-01T12:00Z. This single value drives
    # both the equation of time and the declination, and it must be the same
    # for both: computing them against different time bases puts sunrise hours
    # away from the hour angle the elevation was computed with.
    d = jd - 2451545.0

    # Mean anomaly of the sun, degrees. 357.5291 is the value at J2000.0 and
    # 0.98560028 the daily advance.
    mean_anomaly = (357.5291 + 0.98560028 * d) * _RAD

    # Obliquity of the ecliptic, degrees. Slowly decreasing.
    obliquity = 23.439 - 0.0000004 * d

    # Sun's ecliptic longitude, degrees.
    ecliptic_longitude = (280.459 + 0.98564736 * d) * _RAD

    # Declination of the sun, degrees. Uses the corrected longitude rather
    # than the mean one, which matters by up to a degree and shows up as a
    # sunrise that is several minutes off through the year.
    declination = math.asin(math.sin(obliquity * _RAD) * math.sin(ecliptic_longitude)) * _DEG

    # Equation of time, minutes. y is the tangent of half the obliquity; the
    # two tangent terms carry the eccentricity and obliquity contributions,
    # and dropping either one costs up to ten minutes.
    y = math.tan((obliquity / 2) * _RAD) ** 2
    eq_of_time = 4 * _DEG * (
        y * math.sin(2 * mean_anomaly)
        - 2 * 0.016708634 * math.sin(mean_anomaly)
        + 4 * 0.016708634 * y * math.sin(mean_anomaly) * math.cos(2 * mean_anomaly)
        - 0.5 * y * y * math.sin(4 * mean_anomaly)
        - 1.25 * 0.016708634**2 * math.sin(2 * mean_anomaly)
    )

    # True solar time, minutes past local solar midnight.
    #
    # The time-of-day term must be the *fraction* of the Julian day, not the
    # whole value: 86400 is an exact multiple of 1440, so `(jd - 0.5) * 86400
    # % 1440` discards the time of day entirely and leaves solar noon at
    # midnight. `jd + 0.5` is used because a Julian day rolls over at noon,
    # not midnight, so the fraction is measured from midnight.
    day_fraction = ((jd + 0.5) % 1 + 1) % 1
    true_solar_time = (day_fraction * 1440 + eq_of_time + 4 * lon + 2880) % 1440

    hour_angle = true_solar_time / 4 - 180

    lat_r = lat * _RAD
    dec_r = declination * _RAD
    ha_r = hour_angle * _RAD

    cos_zenith = math.sin(lat_r) * math.sin(dec_r) + math.cos(lat_r) * math.cos(dec_r) * math.cos(ha_r)
    zenith = math.acos(max(-1, min(1, cos_zenith))) * _DEG
    elevation = 90 - zenith

    # Azimuth, clockwise from north.
    denom = math.cos(lat_r) * math.sin(zenith * _RAD)
    if abs(denom) > 1e-9:
        cos_az = (math.sin(lat_r) * math.cos(zenith * _RAD) - math.sin(dec_r)) / denom
        cos_az = max(-1, min(1, cos_az))
        azimuth = math.acos(cos_az) * _DEG
        if hour_angle > 0:
            azimuth = 360 - azimuth
    else:
        # At the poles the azimuth is degenerate; the elevation still decides
        # daylight, so a placeholder here does not affect the answer that
        # matters.
        azimuth = 180 if lat >= 0 else 0

    daylight = elevation > 0
    if elevation > 6:
        twilight = "day"
    elif elevation > -0.833:
        twilight = "civil"
    elif elevation > -12:
        twilight = "nautical"
    else:
        twilight = "night"

    # Sunrise and sunset need the hour angle at which the sun crosses -0.833
    # degrees, accounting for refraction and the solar disc's radius.
    cos_ha = (
        math.sin(-0.833 * _RAD) - math.sin(lat_r) * math.sin(dec_r)
    ) / (math.cos(lat_r) * math.cos(dec_r))
    polar: str | bool = False
    sunrise: str | None = None
    sunset: str | None = None

    if cos_ha > 1:
        polar = "night"
    elif cos_ha < -1:
        polar = "day"
    else:
        # The sunrise hour angle, in degrees. This is the sun's distance from
        # the meridian at the moment it crosses the horizon, so it converts to
        # minutes at four minutes per degree like any other hour angle.
        ha = math.acos(cos_ha) * _DEG
        ha_minutes = 4 * ha
        # Solar noon, in minutes past UTC midnight. Both terms matter:
        # longitude moves noon by four minutes per degree, and the equation of
        # time by up to sixteen more.
        noon_minutes = 720 - 4 * lon - eq_of_time
        sunrise = _iso_from_minutes(noon_minutes - ha_minutes, at)
        sunset = _iso_from_minutes(noon_minutes + ha_minutes, at)

    return SunState(
        elevationDeg=_round2(elevation, 1),
        azimuthDeg=_round2(azimuth, 0),
        daylight=daylight,
        twilight=twilight,
        sunrise=sunrise,
        sunset=sunset,
        polar=polar,
    )


def to_julian_day(at: _dt.datetime) -> float:
    return _epoch_ms(at) / 86400000 + 2440587.5


def _iso_from_minutes(minutes: float, reference: _dt.datetime) -> str:
    """Minutes past UTC midnight on the reference date to an iso timestamp.

    The date comes from the reference's *UTC* components, not its local ones:
    sunrise and sunset are absolute instants, so anchoring them to the local
    calendar date would shift the answer by the machine's timezone.
    """
    base = _dt.datetime(
        reference.year, reference.month, reference.day, tzinfo=_dt.timezone.utc
    ).timestamp() * 1000
    shifted = base + _round2(minutes, 0) * 60000
    t = _dt.datetime(1970, 1, 1, tzinfo=_dt.timezone.utc) + _dt.timedelta(milliseconds=shifted)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _round2(n: float, places: float) -> float:
    f = 10**places
    return math.floor(n * f + 0.5) / f


def _epoch_ms(at: _dt.datetime) -> int:
    if at.tzinfo is None:
        at = at.replace(tzinfo=_dt.timezone.utc)
    return int(at.timestamp() * 1000)


def needs_light(sun: SunState) -> bool:
    """Whether it is dark enough to want artificial light.

    A separate predicate because "daylight" and "you might want a torch" are
    different questions, and the answer to the second is what an agent should
    actually advise on.
    """
    return sun.elevationDeg < 6

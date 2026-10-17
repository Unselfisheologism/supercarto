"""Opening hours — port of ``src/source/hours.ts``.

Everything is evaluated against an explicit timestamp rather than "now", so
the same answer is reproducible in a test, in a replay, or on a server whose
clock disagrees with the caller's.

Three states, never two. "unknown" is separated from "closed" because the two
lead to opposite advice: one means go and find out, the other means go
somewhere else.
"""

from __future__ import annotations

import datetime as _dt
import re
from dataclasses import dataclass

_WEEKDAY_NAMES = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
]

#: Weekday spellings. OSM uses the two-letter forms (`Mo`, `Tu`, `Su`) and
#: most writers use the three-letter ones (`Mon`, `Tue`, `Sun`). Both appear
#: in real data, and a lookup that misses one returns None rather than an
#: error - so a missed spelling silently turns every rule for that day into
#: "no hours listed", and a pharmacy open nine hours a day reads as
#: unconstrained. Both families are therefore present, and the input is
#: lowercased before lookup.
_DAY_TOKENS = {
    "su": 0, "sun": 0, "sunday": 0,
    "mo": 1, "mon": 1, "monday": 1,
    "tu": 2, "tue": 2, "tues": 2, "tuesday": 2,
    "we": 3, "wed": 3, "weds": 3, "wednesday": 3,
    "th": 4, "thu": 4, "thur": 4, "thurs": 4, "thursday": 4,
    "fr": 5, "fri": 5, "friday": 5,
    "sa": 6, "sat": 6, "saturday": 6,
}


@dataclass
class OpenState:
    #: True when open at the evaluated instant.
    open: bool
    #: Opening and closing time on that day, when the rule is a simple range.
    opensAt: str | None = None
    closesAt: str | None = None
    #: A rule that cannot be reduced to a range: overnight hours, multiple
    #: windows, or a `sunrise`-style variant.
    rule: str | None = None
    #: True when the source gave no usable hours at all. Distinct from
    #: ``open: False`` - "unknown" must never render as "closed". Every
    #: constructor passes this explicitly, mirroring the TypeScript.
    unknown: bool = True


@dataclass
class Window:
    #: Minutes from midnight. Values above 1440 represent past-midnight close.
    from_: int
    to: int
    #: True when the window ends on the following day, e.g. `18:00-02:00`.
    crossesMidnight: bool


def evaluate_opening_hours(
    spec: str | None,
    at: _dt.datetime,
    utc_offset_minutes: int | None = None,
) -> OpenState:
    """Evaluate an ``opening_hours`` string at an instant.

    Supports the subset an agent actually acts on: weekday lists and ranges
    (``Mo-Fr``), time ranges (``09:00-17:00``), the ``24/7`` literal,
    ``off``/``closed``, and public holidays. Anything it cannot parse returns
    ``unknown``, which is the correct answer for an unrecognised grammar
    rather than a default-open guess.
    """
    if not spec or spec.strip() == "":
        return OpenState(open=True, unknown=True, rule="no opening hours recorded")

    lower = spec.strip().lower()

    # The two literals that short-circuit everything else.
    if lower == "24/7":
        return OpenState(True, "00:00", "24:00", unknown=False)
    if lower in ("off", "closed"):
        return OpenState(False, rule="always closed", unknown=False)

    # Shift the instant into the place's local frame and read the clock with
    # UTC getters. Reading the host's local clock directly is the bug this
    # indirection exists to prevent.
    if utc_offset_minutes is not None:
        offset = utc_offset_minutes
    else:
        uo = at.astimezone().utcoffset()
        offset = int(uo.total_seconds() // 60) if uo is not None else 0
    local_ms_ms = _epoch_ms(at) + offset * 60000
    local = _dt.datetime(1970, 1, 1) + _dt.timedelta(milliseconds=local_ms_ms)
    # JavaScript's getUTCDay(): Sunday = 0. Python's weekday(): Monday = 0.
    weekday = (local.weekday() + 1) % 7
    minutes = local.hour * 60 + local.minute

    # The rule governing today. Absence means unconstrained, which most
    # people read as open - but reporting times we do not have would be a
    # fabrication, so the state is open with the rule recorded and no times.
    applicable = _rule_for(lower, weekday)
    if applicable is None:
        return OpenState(True, rule="no hours listed for this day", unknown=True)

    if applicable in ("off", "closed"):
        return OpenState(False, rule="closed on this day", unknown=False)

    windows = _parse_windows(applicable)
    if len(windows) == 0:
        return OpenState(True, rule=applicable, unknown=True)

    # Yesterday's rule, because a window can run past midnight and the
    # spillover is the reason someone is standing outside a bar at 1am.
    yesterday = _rule_for(lower, (weekday + 6) % 7)
    spillover = (
        [] if yesterday is None else [w for w in _parse_windows(yesterday) if w.crossesMidnight]
    )

    def open_now(w: Window) -> bool:
        # Today's window, as it applies to today. When it crosses midnight,
        # only the part from the opening time onward belongs to today - the
        # after-midnight segment is tomorrow's.
        return minutes >= w.from_ if w.crossesMidnight else w.from_ <= minutes < w.to

    def open_from_spill(w: Window) -> bool:
        # Yesterday's overnight window is still running during today's early hours.
        return minutes < w.to - 1440

    # A single window that neither crosses midnight nor has yesterday's
    # spillover in play is the common case, and worth stating as an exact
    # pair of times.
    if len(windows) == 1 and len(spillover) == 0 and not windows[0].crossesMidnight:
        w = windows[0]
        return OpenState(
            open=minutes >= w.from_ and minutes < w.to,
            opensAt=_format_minutes(w.from_),
            closesAt=_format_minutes(w.to),
            unknown=False,
        )

    # Otherwise the rule is too complex to reduce to one pair of times without
    # being wrong at one end: several windows, or a window crossing midnight.
    # The rule is reported verbatim so the agent can reason about it.
    opens = any(open_now(w) for w in windows) or any(open_from_spill(w) for w in spillover)
    return OpenState(opens, rule=applicable, unknown=False)


def _rule_for(spec: str, weekday: int) -> str | None:
    """The rule governing a given weekday, last match winning.

    ``None`` when no selector mentions the day, which is different from a rule
    that explicitly closes it.
    """
    found: str | None = None
    for selector, rule in _split_rules(spec):
        if selector is None:
            continue
        if not _selector_matches(selector, weekday):
            continue
        found = rule
    return found


def _split_rules(text: str) -> list[tuple[str | None, str]]:
    """Split on semicolons, except inside a parenthesised exception group.

    ``Mo-Fr 09:00-17:00; Sa 10:00-14:00 (PH off)`` is one rule with an
    exception, and splitting it at the last semicolon turns the exception into
    a weekday selector that matches nothing.
    """
    out: list[tuple[str | None, str]] = []
    depth = 0
    current: list[str] = []

    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        if ch == ";" and depth == 0:
            _push_rule(out, "".join(current))
            current = []
        else:
            current.append(ch)
    _push_rule(out, "".join(current))
    return out


def _push_rule(out: list, text: str) -> None:
    trimmed = text.strip()
    if trimmed == "":
        return

    # Drop a parenthesised exception: it applies conditionally, and evaluating
    # it unconditionally would close a shop on a holiday it is actually open.
    without_exception = re.sub(r"\([^)]*\)", " ", trimmed).strip()

    space_at = without_exception.find(" ")
    if space_at <= 0:
        out.append((None, without_exception))
        return
    out.append(
        (without_exception[:space_at], without_exception[space_at + 1 :].strip())
    )


def _selector_matches(selector: str, weekday: int) -> bool:
    """Whether a weekday selector covers today."""
    for token in selector.split(","):
        t = token.strip()
        if t == "":
            continue
        if t in ("PH", "SH"):
            continue

        # A bare weekday, or a range like `mo-fr` or `Mo-We,Su`.
        dash = t.find("-")
        if dash > 0:
            from_ = _DAY_TOKENS.get(t[:dash].strip())
            to = _DAY_TOKENS.get(t[dash + 1 :].strip())
            if from_ is None or to is None:
                continue
            # Ranges may wrap: `Sa-Mo` means Saturday through Monday.
            if from_ <= to:
                if from_ <= weekday <= to:
                    return True
            elif weekday >= from_ or weekday <= to:
                return True
            continue

        d = _DAY_TOKENS.get(t)
        if d is not None and d == weekday:
            return True
    return False


_WINDOW_RE = re.compile(r"(\d{1,2}):?(\d{2})\s*-\s*(\d{1,2}):?(\d{2})")


def _parse_windows(rule: str) -> list[Window]:
    """Pull ``HH:MM-HH:MM`` pairs out of a rule body."""
    out: list[Window] = []
    pos = 0
    while True:
        m = _WINDOW_RE.search(rule, pos)
        if m is None:
            break
        pos = m.end()
        from_ = int(m.group(1)) * 60 + int(m.group(2))
        raw_to = int(m.group(3)) * 60 + int(m.group(4))
        # A closing time at or below the opening time means the window runs
        # past midnight. The end is stored as an absolute offset (past 1440)
        # so the window stays a single contiguous range, and
        # ``crossesMidnight`` is kept alongside it.
        crosses_midnight = raw_to <= from_
        to = raw_to + 1440 if crosses_midnight else raw_to
        out.append(Window(from_, to, crosses_midnight))
    return out


def _format_minutes(m: int) -> str:
    wrapped = (m % 1440 + 1440) % 1440
    h = wrapped // 60
    minutes = wrapped % 60
    return f"{h:02d}:{minutes:02d}"


def opening_phrase(
    spec: str | None,
    at: _dt.datetime,
    utc_offset_minutes: int | None = None,
) -> str | None:
    """Whether a place is open right now, as a short phrase for a graph node.

    Returns None when the feature carries no ``opening_hours``, which is not
    the same as being closed: absent means go and find out, closed means go
    elsewhere.
    """
    s = evaluate_opening_hours(spec, at, utc_offset_minutes)
    if s.unknown:
        return s.rule if s.rule is not None else "hours unknown"
    if not s.open:
        return s.rule if s.rule is not None else "closed"
    if s.opensAt and s.closesAt:
        return f"{s.opensAt}-{s.closesAt}"
    return "open"


def _epoch_ms(at: _dt.datetime) -> int:
    """JavaScript-style milliseconds since the epoch, rounding down like Date."""
    if at.tzinfo is None:
        at = at.replace(tzinfo=_dt.timezone.utc)
    return int(at.timestamp() * 1000) if at.timestamp() >= 0 else -int(-at.timestamp() * 1000)

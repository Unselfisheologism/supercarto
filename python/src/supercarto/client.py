"""JSON-RPC client for the supercarto MCP server over stdio.

The protocol is three messages and a Content-Length-framed JSON body. That is
small enough to implement directly, which is why this package has no runtime
dependencies: importing an SDK here would force httpx and pydantic onto every
user, most of whom already have one of them at a different version.

What this module does care about is being honest when the server cannot start.
A Node binary that is missing is the single most likely failure for a new user,
and the error says so in one sentence with the fix, rather than surfacing an
``FileNotFoundError`` from deep inside ``asyncio``.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Sequence

__all__ = [
    "ConnectionError",
    "MapletResult",
    "RouteResult",
    "SuperCarto",
    "ToolError",
    "TrafficResult",
    "WeatherResult",
    "default_server_command",
]

# JSON-RPC method names as they appear on the wire.
_INITIALIZE = "initialize"
_TOOLS_LIST = "tools/list"
_TOOLS_CALL = "tools/call"
_NOTIFICATIONS_INITIALIZED = "notifications/initialized"


class ConnectionError(Exception):
    """The MCP server could not be started or did not respond."""


class ToolError(Exception):
    """A tool ran and reported a failure.

    Kept distinct from :class:`ConnectionError` because the two mean different
    things to a caller: a connection error is this client's problem, a tool error
    is usually a real answer about the world, such as "traffic is not configured
    for this deployment".
    """


@dataclass
class MapletResult:
    """A compiled, token-budgeted map graph."""

    yaml: str
    tokens: int
    """Tokens the server reported. Always within the requested budget."""

    budget: int
    fetched_from: str
    """Which upstream source answered. Useful when a latency is unexpected."""

    warnings: list[str] = field(default_factory=list)
    """Problems the source reported. A non-empty list means the map is partial."""


@dataclass
class RouteResult:
    """Turn-by-turn directions as prose."""

    mode: str
    distance_m: int
    duration_s: int
    steps: list[str]
    source: str
    free_flow_only: bool = False
    """True when no traffic source was configured, so the duration ignores
    congestion. Check this before quoting an arrival time to anyone."""


@dataclass
class WeatherResult:
    """Current conditions and a short forecast."""

    summary: str
    temp_c: float | None
    feels_like_c: float | None
    precipitation: str
    wind_kmh: float | None
    advisory: str
    degraded: bool = False
    """True when the forecast source was unreachable. ``temp_c`` is None then,
    and the advisory says so. Do not read a missing reading as a dry day."""


@dataclass
class TrafficResult:
    """Congestion and arrival time."""

    level: str
    worst_level: str
    duration_s: int
    free_flow_s: int
    delay_s: int
    free_flow_only: bool
    unavailable: str | None = None


@dataclass
class DaylightResult:
    """Sun position and daylight state.

    ``twilight`` is one of ``day``, ``civil``, ``nautical``, or ``night`` rather
    than a boolean, because the states lead to different decisions: walking is
    ordinary at civil twilight and unwise at nautical.
    """

    elevation_deg: float
    azimuth_deg: float
    twilight: str
    needs_light: bool
    sunrise: str | None = None
    """None inside the polar circles, where the sun does not rise that day."""
    sunset: str | None = None
    polar: str | None = None
    """``day`` or ``night``, set instead of sunrise/sunset in the polar cases."""


@dataclass
class TerrainResult:
    """Ground elevation sampled around a point."""

    min_m: float
    max_m: float
    range_m: float


def default_server_command() -> list[str]:
    """How to launch the server when the caller does not say.

    Prefers an already-installed ``supercarto`` on PATH, because that is the
    normal case after ``npm install -g supercarto``. Falls back to ``npx`` so a
    user who has only pip-installed the Python package still works, at the cost
    of a first-call download.
    """
    explicit = os.environ.get("SUPERCARTO_SERVER_CMD")
    if explicit:
        return explicit.split()

    on_path = shutil.which("supercarto")
    if on_path:
        return [on_path, "mcp"]

    if shutil.which("npx"):
        return ["npx", "-y", "supercarto", "mcp"]

    return ["supercarto", "mcp"]


class SuperCarto:
    """An MCP client for supercarto.

    Use it as an async context manager so the subprocess is always cleaned up::

        async with SuperCarto() as carto:
            await carto.maplet(lat=51.5, lon=-0.12)

    Or manage ``start`` and ``close`` yourself if the lifetime is awkward to
    express with ``async with``.
    """

    def __init__(
        self,
        command: Sequence[str] | None = None,
        *,
        env: dict[str, str] | None = None,
        timeout_s: float = 90.0,
    ) -> None:
        self._command = list(command) if command else default_server_command()
        self._env = {**os.environ, **(env or {})}
        # Generous by default because a first request against the public Overpass
        # instance genuinely takes 15-40 seconds, and a timeout shorter than
        # that would fail on correct behaviour.
        self._timeout_s = timeout_s
        self._proc: asyncio.subprocess.Process | None = None
        self._next_id = 1
        self._tools: list[dict[str, Any]] | None = None
        self._write_lock = asyncio.Lock()

    async def __aenter__(self) -> SuperCarto:
        await self.start()
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()

    async def start(self) -> None:
        """Spawn the server and complete the MCP handshake."""
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *self._command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=self._env,
            )
        except FileNotFoundError as exc:
            # The one error every new user hits, so it gets the one error worth
            # writing well.
            raise ConnectionError(
                f"could not run {' '.join(self._command)!r}: command not found.\n"
                "supercarto is a Node program. Install it with:\n"
                "  npm install -g supercarto\n"
                "or set SUPERCARTO_SERVER_CMD to its full path."
            ) from exc

        await self._request(
            _INITIALIZE,
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "supercarto-python", "version": "0.3.0"},
            },
        )
        await self._notify(_NOTIFICATIONS_INITIALIZED, {})

    async def close(self) -> None:
        """Terminate the server."""
        if self._proc is None:
            return
        if self._proc.returncode is None:
            self._proc.terminate()
            try:
                # A short grace period before SIGKILL, so the server can close
                # its own handles instead of being cut off mid-write.
                await asyncio.wait_for(self._proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._proc.kill()
                await self._proc.wait()
        self._proc = None
        self._tools = None

    async def tools(self) -> list[str]:
        """Tool names this deployment actually offers.

        Worth checking before a loop: ``get_traffic`` is absent unless a flow
        credential is configured, and calling it anyway raises rather than
        returning a plausible free-flow estimate.
        """
        if self._tools is None:
            result = await self._request(_TOOLS_LIST, {})
            self._tools = list(result.get("tools", []))
        return [t["name"] for t in self._tools if "name" in t]

    async def maplet(
        self,
        lat: float,
        lon: float,
        radius_m: int = 300,
        budget: int = 1024,
        layers: list[str] | None = None,
    ) -> MapletResult:
        """Fetch a map around a coordinate and compile it for an agent.

        The budget is honoured: the server measures its own output and cuts until
        it fits, so ``tokens`` will not exceed ``budget``.
        """
        args: dict[str, Any] = {"lat": lat, "lon": lon, "radiusM": radius_m, "budget": budget}
        if layers:
            args["layers"] = layers

        text = await self._call("get_maplet", args)
        return _parse_maplet(text, budget)

    async def route(
        self,
        from_lat: float,
        from_lon: float,
        to_lat: float,
        to_lon: float,
        mode: str = "walk",
    ) -> RouteResult:
        """Turn-by-turn directions as prose, which a model reads better than geometry."""
        text = await self._call(
            "route",
            {
                "fromLat": from_lat,
                "fromLon": from_lon,
                "toLat": to_lat,
                "toLon": to_lon,
                "mode": mode,
            },
        )
        return _parse_route(text)

    async def search_places(
        self,
        lat: float,
        lon: float,
        radius_m: int = 300,
        query: str | None = None,
        limit: int = 20,
    ) -> list[str]:
        """Find named places near a coordinate. Cheaper than :meth:`maplet`."""
        args: dict[str, Any] = {"lat": lat, "lon": lon, "radiusM": radius_m, "limit": limit}
        if query:
            args["query"] = query
        text = await self._call("search_places", args)
        return [line[2:].strip() for line in text.splitlines() if line.startswith("- ")]

    async def weather(self, lat: float, lon: float, hours: int = 12) -> WeatherResult:
        """Current conditions and forecast. Needs no API key.

        Raises :class:`ToolError` if the forecast source is unreachable, rather
        than returning a result that reads as a dry day.
        """
        text = await self._call("get_weather", {"lat": lat, "lon": lon, "hours": hours})
        return _parse_weather(text)

    async def traffic(
        self, from_lat: float, from_lon: float, to_lat: float, to_lon: float
    ) -> TrafficResult:
        """Congestion and arrival time.

        Raises :class:`ToolError` when no flow source is configured, because a
        free-flow number returned as if it were live is the failure this library
        exists to avoid.
        """
        text = await self._call(
            "get_traffic",
            {"fromLat": from_lat, "fromLon": from_lon, "toLat": to_lat, "toLon": to_lon},
        )
        return _parse_traffic(text)

    async def daylight(
        self, lat: float, lon: float, at: str | None = None
    ) -> DaylightResult:
        """Sun position, sunrise, sunset, and whether a light is needed.

        Always available: solar geometry is arithmetic, needing no source and no
        credential. ``at`` is an ISO 8601 instant in UTC and defaults to now.

        Inside the polar circles ``sunrise`` and ``sunset`` are ``None`` and
        ``polar`` is set instead, because there is no honest time to report.
        """
        args: dict[str, Any] = {"lat": lat, "lon": lon}
        if at:
            args["at"] = at
        text = await self._call("get_daylight", args)
        return _parse_daylight(text)

    async def terrain(
        self, lat: float, lon: float, radius_m: int = 1000, samples: int = 16
    ) -> TerrainResult:
        """Ground elevation range around a point.

        Raises :class:`ToolError` unless the deployment has an elevation source
        configured.
        """
        text = await self._call(
            "get_terrain",
            {"lat": lat, "lon": lon, "radiusM": radius_m, "samples": samples},
        )
        return _parse_terrain(text)

    async def _call(self, name: str, args: dict[str, Any]) -> str:
        result = await self._request(_TOOLS_CALL, {"name": name, "arguments": args})
        if result.get("isError"):
            raise ToolError(_content_text(result) or f"{name} failed")

        text = _content_text(result)
        if not text:
            raise ToolError(f"{name} returned no content")
        return text

    async def _request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if self._proc is None or self._proc.stdin is None:
            raise ConnectionError("server not started; call start() or use `async with`")

        self._next_id += 1
        request_id = self._next_id
        payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        await self._write(payload)

        # A timeout is not paranoia. A framing mismatch between client and server
        # manifests as the server never answering at all, so without this the
        # failure mode is an indefinite hang rather than an error message.
        try:
            deadline = asyncio.wait_for(
                self._await_response(request_id), timeout=self._timeout_s
            )
            return await deadline
        except asyncio.TimeoutError as exc:
            raise ConnectionError(
                f"no response to {method} after {self._timeout_s:g}s. "
                "If this is a map request the upstream data source may be slow; "
                "otherwise the client and server disagree about framing."
            ) from exc

    async def _await_response(self, request_id: int) -> dict[str, Any]:
        while True:
            message = await self._read_message()
            # Skip anything that is not our response: the server is free to send
            # notifications, and a log line on stdout would otherwise look like a
            # reply.
            if message.get("id") != request_id:
                if "error" in message and message.get("id") is None:
                    raise ConnectionError(f"server error: {message['error']}")
                continue
            if "error" in message:
                raise ConnectionError(f"{method} failed: {message['error']}")
            result = message.get("result", {})
            return result if isinstance(result, dict) else {}

    async def _notify(self, method: str, params: dict[str, Any]) -> None:
        await self._write({"jsonrpc": "2.0", "method": method, "params": params})

    async def _write(self, payload: dict[str, Any]) -> None:
        """Send one newline-delimited JSON message.

        Newline framing rather than Content-Length headers. supercarto's server
        writes `JSON.stringify(...) + "\\n"`, which is the simpler of the two
        framings the MCP spec allows and the one this client has to match:
        sending a Content-Length header to a newline reader hangs on the first
        request, because the server treats the header line as a malformed message
        and answers nothing.
        """
        if self._proc is None or self._proc.stdin is None:
            raise ConnectionError("server not started; call start() or use `async with`")
        # Serialised because stdin is a single stream: two interleaved writes
        # would corrupt the line framing.
        async with self._write_lock:
            self._proc.stdin.write((json.dumps(payload, separators=(",", ":")) + "\n").encode())
            await self._proc.stdin.drain()

    async def _read_message(self) -> dict[str, Any]:
        if self._proc is None or self._proc.stdout is None:
            raise ConnectionError("server not started")

        while True:
            line = await self._proc.stdout.readline()
            if not line:
                code = self._proc.returncode
                raise ConnectionError(f"server closed its output (exit code {code})")
            text = line.decode().strip()
            if text == "":
                continue
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError as exc:
                # Anything that is not JSON on stdout is a stray print. Skipping
                # it is better than dying, since a log line from a dependency
                # should not take down a working session.
                continue
            if isinstance(parsed, dict):
                return parsed


def _content_text(result: dict[str, Any]) -> str:
    content = result.get("content")
    if not isinstance(content, list):
        return ""
    return "\n".join(
        block.get("text", "") for block in content if isinstance(block, dict)
    ).strip()


# ---------------------------------------------------------------------------
# Response parsing
#
# The MCP server returns text meant for a language model, so this parses prose
# rather than reading structured fields. That is a deliberate choice at both
# ends: the server emits prose because a model reads it better than a JSON blob,
# and this client parses it back with narrow patterns. Both halves are pinned by
# tests, so a change to the wording on one side fails loudly rather than
# silently returning None.
# ---------------------------------------------------------------------------


def _parse_maplet(text: str, budget: int) -> MapletResult:
    header, sep, body = text.partition("\n\n")
    # With no header at all, `partition` swallows the whole document as the
    # header and returns an empty body. Detecting that case keeps a caller from
    # receiving an empty map from a server that actually answered.
    if not sep:
        header, body = "", text

    fetched_from = "unknown"
    tokens = 0
    warnings: list[str] = []

    for line in header.splitlines():
        if line.startswith("# maplet @"):
            # The header carries the centre and the source in parentheses.
            # Taking the last "(" group avoids splitting on the coordinate.
            _, _, rest = line.partition("@")
            tail = rest.strip()
            _, _, trailing = tail.rpartition("(")
            fetched_from = trailing.rstrip(")").strip() or tail
        elif line.startswith("# tokens "):
            # "tokens 749/1500  nodes 19  edges 34"
            token_part = line.removeprefix("# tokens ").split()[0]
            tokens = int(token_part.split("/")[0] or 0)
        elif line.startswith("# WARNING: "):
            warnings.append(line.removeprefix("# WARNING: "))

    return MapletResult(
        yaml=body,
        tokens=tokens,
        budget=budget,
        fetched_from=fetched_from,
        warnings=warnings,
    )


def _parse_route(text: str) -> RouteResult:
    mode = "walk"
    distance = 0
    duration = 0
    source = "unknown"
    steps: list[str] = []
    free_flow_only = False

    for line in text.splitlines():
        if line.startswith("route ("):
            # "route (walk) via osrm" carries both the mode and the source.
            inner = line.removeprefix("route (").rstrip(")")
            mode_part, _, source_part = inner.partition(") via ")
            mode = mode_part.split()[0] if mode_part.split() else "walk"
            source = source_part.strip() or source
        elif line.startswith("total: "):
            for part in line.removeprefix("total: ").split(", "):
                value = part.split("m")[0].split("s")[0].strip()
                if part.endswith("m"):
                    distance = int(value)
                elif part.endswith("s"):
                    duration = int(value)
        elif line[:1].isdigit() and "." in line:
            steps.append(line.strip())

    return RouteResult(
        mode=mode,
        distance_m=distance,
        duration_s=duration,
        steps=steps,
        source=source,
        free_flow_only=free_flow_only,
    )


def _parse_weather(text: str) -> WeatherResult:
    summary = "unknown"
    temp: float | None = None
    feels: float | None = None
    precipitation = "unknown"
    wind: float | None = None
    advisory = ""

    for line in text.splitlines():
        if line.startswith("now: "):
            body = line.removeprefix("now: ")
            summary = body.split(",")[0].strip()
            temp = _first_float(body)
            feels = _nth_float(body, 1)
            wind = _nth_float(body, 2)
        elif line.startswith("precipitation: "):
            value = line.removeprefix("precipitation: ").split(",")[0].strip()
            precipitation = value.split()[0] or "unknown"
        elif line.startswith("advisory: "):
            advisory = line.removeprefix("advisory: ")

    return WeatherResult(
        summary=summary,
        temp_c=temp,
        feels_like_c=feels,
        precipitation=precipitation,
        wind_kmh=wind,
        advisory=advisory,
    )


def _parse_daylight(text: str) -> DaylightResult:
    elevation = 0.0
    azimuth = 0.0
    twilight = "night"
    needs_light = True
    sunrise: str | None = None
    sunset: str | None = None
    polar: str | None = None

    for line in text.splitlines():
        # Values keep their unit ("43.4deg"), which the number pattern skips.
        if line.startswith("elevation: "):
            value = _first_float(line.removeprefix("elevation: "))
            if value is not None:
                elevation = value
        elif line.startswith("azimuth: "):
            value = _first_float(line.removeprefix("azimuth: "))
            if value is not None:
                azimuth = value
        elif line.startswith("state: "):
            twilight = line.removeprefix("state: ").strip()
        elif line.startswith("needs light: "):
            needs_light = line.removeprefix("needs light: ").strip() == "yes"
        elif line.startswith("sunrise: "):
            sunrise = line.removeprefix("sunrise: ").strip()
        elif line.startswith("sunset: "):
            sunset = line.removeprefix("sunset: ").strip()
        elif line.startswith("polar day"):
            polar = "day"
        elif line.startswith("polar night"):
            polar = "night"

    return DaylightResult(
        elevation_deg=elevation,
        azimuth_deg=azimuth,
        twilight=twilight,
        needs_light=needs_light,
        sunrise=sunrise,
        sunset=sunset,
        polar=polar,
    )


def _parse_terrain(text: str) -> TerrainResult:
    minimum = 0.0
    maximum = 0.0
    span = 0.0
    for line in text.splitlines():
        if line.startswith("min: "):
            value = _first_float(line.removeprefix("min: "))
            if value is not None:
                minimum = value
        elif line.startswith("max: "):
            value = _first_float(line.removeprefix("max: "))
            if value is not None:
                maximum = value
        elif line.startswith("range: "):
            value = _first_float(line.removeprefix("range: "))
            if value is not None:
                span = value
    return TerrainResult(min_m=minimum, max_m=maximum, range_m=span)


def _parse_traffic(text: str) -> TrafficResult:
    free_flow_only = "unknown" in text.splitlines()[0] if text else False
    level = "unknown"
    worst = "unknown"
    duration = 0
    free_flow = 0
    delay = 0
    unavailable = None

    for line in text.splitlines():
        if line.startswith("traffic: "):
            level = line.removeprefix("traffic: ").split(" ")[0].strip()
            if "worst segment" in line:
                worst = line.split("worst segment ")[1].strip()
        elif line.startswith("traffic "):
            parts = line.split()
            level = parts[1] if len(parts) > 1 else level
            if "worst segment" in line:
                worst = line.split("worst segment ")[1].strip()
        elif line.startswith("free-flow estimate: "):
            free_flow = _first_int(line)
        elif line.startswith("duration: "):
            body = line.removeprefix("duration: ")
            duration = _first_int(body)
            # "1500s including 900s of delay (free flow would be 600s)".
            # Splitting on " including " rather than " of " avoids catching the
            # "(free flow would be 600s)" tail, which is a different number.
            if " including " in body:
                delay = _first_int(body.split(" including ")[1])
        elif line.startswith("note: "):
            unavailable = line.removeprefix("note: ")

    return TrafficResult(
        level=level,
        worst_level=worst,
        duration_s=duration,
        free_flow_s=free_flow or duration,
        delay_s=delay,
        free_flow_only=free_flow_only,
        unavailable=unavailable,
    )


def _first_float(text: str) -> float | None:
    return _nth_float(text, 0)


def _nth_float(text: str, index: int) -> float | None:
    """The index-th number in a string, or None.

    Numbers are found with a strict pattern so the "C" in a temperature unit
    does not count as part of a value and a street number in a name does not
    shift the index.
    """
    import re

    found = re.findall(r"-?\d+(?:\.\d+)?", text)
    if index < len(found):
        try:
            return float(found[index])
        except ValueError:
            return None
    return None


def _first_int(text: str) -> int:
    value = _nth_float(text, 0)
    return int(value) if value is not None else 0

"""Minimal HTTP fetch over ``urllib`` — the stand-in for JS ``fetch``.

Zero dependencies: every live source (Overpass, Open-Meteo, OSRM, elevation
tiles) speaks plain HTTP with query-string or urlencoded bodies, so the whole
live path rides on the standard library.

``fetch`` shapes the response like the WHATWG API the TypeScript sources were
written against: ``ok``, ``status``, ``text``. Sources inject their own fetch
callable (``fetchImpl`` in TS, ``fetch`` here) for tests and replay fixtures,
which is how the live path is gated byte-for-byte against the TypeScript
without touching a network.
"""

from __future__ import annotations

import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any

DEFAULT_TIMEOUT_S = 60.0

USER_AGENT = "supercarto/0.4.0 (LLM spatial middleware; +https://github.com/supercarto)"


class HttpError(Exception):
    """A network-level failure: DNS, connection refused, read timeout.

    TS ``fetch`` rejects with a ``TypeError`` for these; the sources treat a
    bare error as non-retryable unless they recognised the shape, so this stays
    a plain exception rather than a status assignment.
    """


class HttpResponse:
    """A completed exchange, whether the status is success or failure.

    ``urllib`` raises an :class:`~urllib.error.HTTPError` for non-2xx rather
    than returning a response. Every Overpass failure — rate limits, slot
    exhaustion, oversized queries — arrives as a 4xx with a meaningful XML body,
    so errors are captured as responses instead of exceptions and the status
    survives for the retry policy to inspect.
    """

    def __init__(self, status: int, headers: dict[str, str], body: bytes):
        self.status = status
        self.headers = headers
        self._body = body

    @property
    def body(self) -> bytes:
        return self._body

    @property
    def text(self) -> str:
        return self._body.decode("utf-8")

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<HttpResponse {self.status} {len(self._body)}B>"


#: ``fetch(url) -> HttpResponse`` / ``fetch(url, method=..., body=...)``.
Fetch = Callable[..., HttpResponse]


def http_fetch(
    url: str,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: bytes | str | None = None,
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> HttpResponse:
    """One blocking HTTP exchange via ``urllib.request``."""
    data = body.encode("utf-8") if isinstance(body, str) else body
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers=headers or {},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            return HttpResponse(resp.status, dict(resp.headers), resp.read())
    except urllib.error.HTTPError as e:
        return HttpResponse(e.code, dict(e.headers or {}), e.read())
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        raise HttpError(f"{type(e).__name__}: {e}") from e


def query_params(params: dict[str, Any]) -> str:
    """URL-encode a flat parameter dict, exactly like ``URLSearchParams``.

    Both encoders use ``application/x-www-form-urlencoded`` rules, so a fixture
    captured against one implementation replays against the other unchanged.
    """
    return urllib.parse.urlencode(params)

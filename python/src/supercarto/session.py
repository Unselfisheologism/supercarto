"""The agent moves: session views — port of ``src/session/session.ts``.

A moving agent keeps its map in local RAM as the SCR string each call
returns. ``move_maplet`` is the engine behind the ``localize`` tool: it takes
the agent's current map, a fresh fetch for the new view box, and returns only
the +/-/~ delta plus the new compact state. The LLM context never re-pays for
the streets it already knows; the diff names what changed and the harness
swaps the stored string.

One envelope, the session's, quantizes every view: it is read from the
agent's document and pinned into the re-ingest, so the same place always
lands on the same grid point and the diff compares geometry exactly rather
than quantization noise. That is the precondition every diff run needs.
"""

from __future__ import annotations

from typing import Any

from .diff import FeatureChange, diff_documents, render_diff
from .pipeline import to_maplet
from .types import ScrDocument
from .wire import decode_document


def move_maplet(
    scr: str,
    features: dict[str, Any] | list[Any],
    opts: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One move of a session: previous SCR in, delta and new state out.

    ``opts`` are the ordinary :func:`to_maplet` request options; the session
    envelope wins because it is read from the agent's document and pinned
    last.
    """
    prev = decode_document(scr)
    req = {**(opts or {}), "envelope": prev.envelope}
    view = to_maplet(features, req)
    changes: list[FeatureChange] = diff_documents(prev, view["doc"])
    return {
        "changes": changes,
        "report": render_diff(changes, prev, view["doc"]),
        "counts": {
            "added": sum(1 for c in changes if c["op"] == "+"),
            "removed": sum(1 for c in changes if c["op"] == "-"),
            "updated": sum(1 for c in changes if c["op"] == "~"),
        },
        # The new view's compact state: the harness stores this, not the LLM.
        "scr": view["scr"],
        "yaml": view["yaml"],
        "metrics": {
            "yamlTokens": view["metrics"]["tokens"],
            "wireBytes": view["metrics"]["wireBytes"],
            "wireTokens": view["metrics"]["wireTokens"],
        },
        "view": _view_header(view["graph"].meta),
    }


def _view_header(meta: Any) -> dict[str, str]:
    out = {"center": meta.center}
    if meta.note:
        out["note"] = meta.note
    return out


def session_doc(scr: str) -> ScrDocument:
    """Decode-only re-export so callers can inspect the document they hold."""
    return decode_document(scr)


def session_envelope_contains(env: Any, bbox: dict[str, float]) -> bool:
    """Whether a view box can be quantized on the session envelope's grid.

    A wrapped envelope (``west > east``, the antimeridian) is one grid only
    on the east-side span ``[west, 180]``: the projection is linear in
    Mercator X, so features inside ``[-180, east]`` would land on negative
    grid x, off the document's own coordinate system. A view inside that
    span is refused - the agent gets a clear instruction to open a new
    session rather than a diff that a foreign grid would make a lie.
    """

    def get(obj: Any, key: str) -> float:
        out = obj[key] if isinstance(obj, dict) else getattr(obj, key)
        return float(out)

    lat_ok = get(bbox, "south") >= get(env, "south") and get(bbox, "north") <= get(env, "north")
    if not lat_ok:
        return False
    if get(env, "west") <= get(env, "east"):
        return get(bbox, "west") >= get(env, "west") and get(bbox, "east") <= get(env, "east")
    # Antimeridian: coverage is [west, 180] plus [-180, east], but only the
    # first span quantizes onto the document's grid.
    return get(bbox, "west") >= get(env, "west") and get(bbox, "east") <= 180

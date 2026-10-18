"""State diffs: what changed between two documents — port of
``src/diff/diff.ts``.

An agent that moves does not need the whole map again; it needs ``+`` (entered
view), ``-`` (left view) and ``~`` (updated). Compared by wire feature id,
which is stable across documents because ingest prefers the source's own id.
Geometry compares exactly - grid integers, no tolerance - because a moved
vertex is a change worth reporting, not noise to absorb.

Precondition: both documents share envelope, extent and projection (the
session fills this in by re-ingesting every move under the session's
envelope). Otherwise quantization differs per doc and identical source
geometry compares dirty. Layer, class and attributes compare by resolved
name/content, which is immune to per-document interning counters; geometry has
no such luxury.
"""

from __future__ import annotations

import json
from typing import Any, TypedDict

from .types import (
    AttrBool,
    AttrNum,
    AttrRef,
    AttrToken,
    Feature,
    ScrDocument,
    js_num_str,
)

#: Change op vocabulary: entered view, left view, updated in place.
ChangeOp = str


class FeatureChange(TypedDict):
    """One feature-level change record."""

    #: ``+`` entered view, ``-`` left view, ``~`` updated in place.
    op: ChangeOp
    #: The wire feature id, stable across documents.
    id: float | int
    #: For ``~``: which aspects differ (`geometry`, `layer`, `class`, `attributes`).
    aspects: list[str]


def _geom_key(f: Feature) -> str:
    """Canonical serialization of a feature's geometry.

    Equivalent to the reference's ``JSON.stringify``, mirrored through
    Python's stable dataclass field order. Comparison is exact on grid
    integers, so any deterministic encoding serves the same purpose as long
    as it distinguishes every distinct geometry.
    """
    out: list[str] = []

    def walk(v: Any) -> None:
        if isinstance(v, float):
            # JavaScript's number formatting, so the two encoders agree.
            out.append(js_num_str(v))
        elif isinstance(v, list):
            out.append("[")
            for x in v:
                walk(x)
                out.append(",")
            out.append("]")
        else:
            out.append(str(v))

    def obj(o: Any) -> None:
        out.append("{")
        d = o.__dict__ if hasattr(o, "__dict__") else o
        for k in d:
            out.append(str(k))
            out.append(":")
            walk(d[k])
            out.append(",")
        out.append("}")

    obj(f.geometry)
    return "".join(out)


def _resolved_attrs(f: Feature, doc: ScrDocument) -> dict[str, str]:
    """Resolved attributes: key strings to plain values.

    Two independently ingested documents compare by content rather than by
    interned ids (which are per-document counters and never equal across
    docs).
    """
    out: dict[str, str] = {}
    the_set = doc.attrSets.get(f.attrSet)
    if not the_set:
        return out
    for p in the_set.props:
        key = doc.strings.get(p.key)
        if key is None:
            key = f"key{p.key}"
        v = p.value
        if isinstance(v, AttrRef):
            ref = doc.strings.get(v.ref)
            out[key] = ref if ref is not None else _js(v.ref)
        elif isinstance(v, AttrNum):
            out[key] = _js(v.num)
        elif isinstance(v, AttrBool):
            out[key] = _js(v.bool)
        elif isinstance(v, AttrToken):
            out[key] = str(v.token)
    return out


def _js(v: Any) -> str:
    """The value, as the reference's ``JSON.stringify`` would spell it."""
    if isinstance(v, float):
        return js_num_str(v)
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    escaped = json.dumps(str(v), ensure_ascii=False)
    return escaped


def _aspects_of(
    a: Feature, da: ScrDocument, b: Feature, db: ScrDocument
) -> list[str]:
    out: list[str] = []
    # Names, not ids: layer and class ids are per-document interning counters.
    la = da.layers.get(a.layerId)
    lb = db.layers.get(b.layerId)
    if (la.name if la else a.layerId) != (lb.name if lb else b.layerId):
        out.append("layer")
    ca = da.classes.get(a.classId)
    cb = db.classes.get(b.classId)
    if (ca.name if ca else a.classId) != (cb.name if cb else b.classId):
        out.append("class")
    if a.kind != b.kind or _geom_key(a) != _geom_key(b):
        out.append("geometry")
    if _resolved_attrs(a, da) != _resolved_attrs(b, db):
        out.append("attributes")
    return out


def _js_num(v: float) -> float | int:
    """An id as the JSON reference would spell it: integral floats print bare."""
    if isinstance(v, float) and v.is_integer() and abs(v) < 2 ** 53:
        return int(v)
    return v


def diff_documents(a: ScrDocument, b: ScrDocument) -> list[FeatureChange]:
    """What changed from document ``a`` (the map the agent holds) to ``b``."""
    am = {f.id: f for f in a.features}
    bm = {f.id: f for f in b.features}
    out: list[FeatureChange] = []
    for id_ in sorted(am):
        fa = am[id_]
        fb = bm.get(id_)
        if fb is None:
            out.append({"op": "-", "id": _js_num(id_), "aspects": []})
            continue
        aspects = _aspects_of(fa, a, fb, b)
        if aspects:
            out.append({"op": "~", "id": _js_num(id_), "aspects": aspects})
    for id_ in sorted(bm):
        if id_ not in am:
            out.append({"op": "+", "id": _js_num(id_), "aspects": []})
    # Deterministic across runs: one entry per id, in id order.
    return sorted(out, key=lambda c: c["id"])


def _feature_label(f: Feature, doc: ScrDocument) -> str:
    layer = doc.layers.get(f.layerId)
    name = ""
    the_set = doc.attrSets.get(f.attrSet)
    if the_set:
        for p in the_set.props:
            if doc.strings.get(p.key) == "name" and isinstance(p.value, AttrRef):
                name = doc.strings.get(p.value.ref) or ""
                break
    shown = layer.name if layer else f"layer{f.layerId}"
    name_id = _js_num(f.id)
    return f"{name} ({shown})" if name else f"feature {name_id} ({shown})"


def render_diff(
    changes: list[FeatureChange], a: ScrDocument, b: ScrDocument
) -> str:
    """Render changes as the planning doc's ``+``/``-``/``~`` lines.

    Names resolve from whichever document holds the feature (the new one for
    additions and updates, the old one for removals), so a removed place is
    still named rather than numbered.
    """
    am: dict[float | int, Feature] = {_js_num(f.id): f for f in a.features}
    bm: dict[float | int, Feature] = {_js_num(f.id): f for f in b.features}
    lines = []
    for c in changes:
        if c["op"] == "-":
            f = am.get(c["id"])
            line = f"- {_js_num(c['id'])} {_feature_label(f, a) if f else ''}".rstrip()
        else:
            f = bm.get(c["id"])
            label = _feature_label(f, b) if f else ""
            suffix = f" ({', '.join(c['aspects'])})" if c["op"] == "~" else ""
            line = f"{c['op']} {_js_num(c['id'])} {label}{suffix}".rstrip()
        lines.append(line)
    return "\n".join(lines)

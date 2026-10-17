"""LLM-native YAML emission — port of ``src/emit/yaml.ts``.

Token estimation matters more in its consistency than its exact calibration:
the budgeter only needs to be right to within ~10% to stop emitting features.
"""

from __future__ import annotations

import math
import re

from .graph import GraphEdge, GraphNode, SpatialGraph
from .indoor import is_meaningful_indoor
from .types import utf16_length


def estimate_tokens(text: str) -> int:
    """``ceil(chars / 4)`` — a rough but well-behaved model of BPE tokenizers.

    BPE tokenizers split on word boundaries, punctuation runs, and digits.
    Using one consistent estimate matters more than its exact calibration.
    """
    chars = utf16_length(text)
    if chars == 0:
        return 0
    return math.ceil(chars / 4)


_PLAIN_UNSAFE = re.compile(r"[:#\[\]{}&*!|>'\"%@`,]")
# Mirrors /^[\s]|[\s]$/ — leading or trailing whitespace.
_WS_EDGE = re.compile(r"^[\s]|[\s]$")
_LOOKALIKE = re.compile(r"^(true|false|null|yes|no|on|off|~)$", re.IGNORECASE)
_NUMERIC = re.compile(r"^-?\d+(\.\d+)?$")


def yaml_string(value: str) -> str:
    """Quote a scalar for YAML flow style. Only quote when it must be.

    Plain scalars are safe when they are not YAML-special and not ambiguous
    with a number or boolean. Quoting everything costs a token per value and
    buys nothing for a model that is reading, not a parser being pedantic.
    """
    if value == "":
        return '""'
    needs_quote = (
        _WS_EDGE.search(value) is not None
        or _PLAIN_UNSAFE.search(value) is not None
        or _LOOKALIKE.match(value) is not None
        or _NUMERIC.match(value) is not None
        or value == "-"
        or value == "..."
    )
    return '"' + value.replace('"', '\\"') + '"' if needs_quote else value


def _value_with_hash(value: str) -> str:
    """A value that contains a ``#``.

    YAML reads ``09:00-17:00`` as a plain scalar, so the generic rule would
    quote it. Only a genuine comment - ``#`` at the start of the value or
    after whitespace - needs escaping.
    """
    if re.match(r"^\s*#", value) is not None or " #" in value:
        return yaml_string(value)
    return value


def _n(x: float | None) -> str:
    """JavaScript-style number formatting for YAML output.

    ``3.0`` prints as ``3``, ``27.5`` as ``27.5`` — Node prints integral
    doubles without a trailing ``.0``, and Python would too often print one,
    which loses token-parity with the reference emitter.
    """
    if x is None:
        return "None"
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, int):
        return str(x)
    if x != x:  # noqa: PLR0124 - NaN check, mirrors JS formatting
        return "NaN"
    if x == int(x) and abs(x) < 1e21:
        return str(int(x))
    r = repr(x)
    # repr gives Python float literals; exponent forms already match JS for
    # the magnitudes supercarto produces.
    return r


class EmitOptions(dict):
    """Options for :func:`emit_graph` (``scale``, ``includeTools``, ...)"""


def emit_graph(graph: SpatialGraph, opts: dict | None = None) -> dict:
    """Render a spatial graph as LLM-native YAML flow style.

    Returns ``{"yaml", "tokens", "chars"}``.
    """
    opts = opts or {}
    scale = opts.get("scale")
    out: list[str] = []

    out.append("map:")
    out.append(f"  center: {yaml_string(graph.meta.center)}")
    if graph.meta.radius:
        out.append(f"  radius: {yaml_string(graph.meta.radius)}")
    if graph.meta.lod:
        out.append(f"  lod: {yaml_string(graph.meta.lod)}")
    if graph.meta.source:
        out.append(f"  source: {yaml_string(graph.meta.source)}")
    if graph.meta.sun is not None:
        s = graph.meta.sun
        # Three states, not two. `twilight` is what separates "you can walk"
        # from "you cannot see", and an agent that only knew daylight/night
        # would warn someone about a 6am June walk that is perfectly fine.
        parts = [
            f"sun: {'up' if s.daylight else 'down'}",
            f"elevation: {_n(s.elevationDeg)}deg",
            f"twilight: {s.twilight}",
            f"azimuth: {_n(s.azimuthDeg)}deg",
        ]
        if s.polar:
            parts.append(f"polar: {s.polar}")
        else:
            if s.sunrise:
                parts.append(f"sunrise: {yaml_string(s.sunrise)}")
            if s.sunset:
                parts.append(f"sunset: {yaml_string(s.sunset)}")
        out.append(f"  {', '.join(parts)}")
    if graph.meta.note:
        out.append(f"  note: {yaml_string(graph.meta.note)}")

    out.append("nodes:")
    if len(graph.nodes) == 0:
        out.append("  {}")
    else:
        for n in graph.nodes:
            out.append(f"  {n.id}: {_node_body(n)}")

    out.append("edges:")
    if len(graph.edges) == 0:
        out.append("  {}")
    else:
        for e in graph.edges:
            out.append(f"  {e.from_}->{e.to}: {_edge_body(e, scale)}")

    if len(graph.obstacles) > 0:
        out.append("obstacles:")
        for o in graph.obstacles:
            parts = [f"edge: {yaml_string(o.edge)}", f"type: {yaml_string(o.type)}"]
            if o.blocks:
                parts.append("blocks: true")
            out.append(f"  - {{{', '.join(parts)}}}")

    if opts.get("includeHeat", True) and len(graph.heat) > 0:
        out.append("heat:")
        for h in graph.heat:
            out.append(f"  {yaml_string(h.name)}: {{max: {_n(h.max)}, mean: {_n(h.mean)}}}")
            for spot in h.hotspots:
                out.append(
                    f'    - {{at: "{_n(spot.lat)},{_n(spot.lon)}", v: {_n(spot.value)}, rel: {_n(spot.rel)}}}'
                )

    if opts.get("includeIndoor", True) and is_meaningful_indoor(graph.indoor):
        out.extend(_indoor_lines(graph.indoor))

    if opts.get("includeOmitted", True) and len(graph.omitted) > 0:
        out.append("omitted:")
        for o in graph.omitted:
            parts = [f"layer: {yaml_string(o.layer)}", f"count: {o.count}"]
            if o.near != "unspecified":
                parts.append(f"near: {yaml_string(o.near)}")
            if o.note:
                parts.append(f"note: {yaml_string(o.note)}")
            out.append(f"  - {{{', '.join(parts)}}}")

    if opts.get("includeTools", True) and len(graph.tools) > 0:
        out.append("tools:")
        for t in graph.tools:
            out.append(f"  - {t}")

    yaml = "\n".join(out) + "\n"
    return {"yaml": yaml, "tokens": estimate_tokens(yaml), "chars": utf16_length(yaml)}


def _indoor_lines(graph) -> list[str]:
    """Render the indoor block (only reachable once the indoor builder exists)."""
    out = ["indoor:"]
    out.append(f"  storeys: {','.join(str(l.level) for l in graph.levels) or 'none'}")
    out.append(f"  {'multi_storey: true' if graph.multiStorey else 'multi_storey: false'}")

    for level in graph.levels:
        out.append(f"  {level.level}: {{label: {yaml_string(level.label)}, rooms: {len(level.nodes)}}}")
        for n in level.nodes:
            parts = [f"type: {n.kind}"]
            if n.name:
                parts.append(f"name: {yaml_string(n.name)}")
            if n.wheelchair is not None:
                parts.append(f"wheelchair: {n.wheelchair}")
            out.append(f"    {n.id}: {{{', '.join(parts)}}}")
        for e in level.edges:
            parts = [f"dist: {e.distM}m"]
            if e.blocked:
                parts.append("blocked: true")
            if e.door:
                parts.append(f"door: {yaml_string(e.door)}")
            out.append(f"    {e.from_}->{e.to}: {{{', '.join(parts)}}}")

    for v in graph.vertical:
        parts = [f"type: {v.kind}", f"levels: [{','.join(str(x) for x in v.levels)}]"]
        if v.wheelchair:
            parts.append("wheelchair: true")
        if v.name:
            parts.append(f"name: {yaml_string(v.name)}")
        out.append(f"  {v.id}: {{{', '.join(parts)}}}")

    if graph.missingLevels:
        out.append(f"  missing: [{','.join(str(x) for x in graph.missingLevels)}]")
    for o in graph.omitted:
        out.append(f"  omitted: - {{level: {o.level}, note: {yaml_string(o.reason)}}}")
    return out


def _node_body(n: GraphNode) -> str:
    parts: list[str] = []
    parts.append(f"type: {n.kind}")
    if n.name:
        parts.append(f"name: {yaml_string(n.name)}")
    if n.tags and len(n.tags) > 0:
        parts.append(f"tags: [{', '.join(yaml_string(t) for t in n.tags)}]")
    if n.heightM is not None:
        parts.append(f"height: {_n(n.heightM)}m")
    # Only emitted when present. An absent `hours` means nobody recorded
    # them, which the agent must not read as "closed".
    if n.hours:
        parts.append(f"hours: {_value_with_hash(n.hours)}")
    if n.brand:
        parts.append(f"brand: {yaml_string(n.brand)}")
    if n.lat is not None and n.lon is not None:
        parts.append(f'at: "{_n(n.lat)},{_n(n.lon)}"')
    return "{" + ", ".join(parts) + "}"


def _edge_body(e: GraphEdge, scale: dict | None) -> str:
    parts: list[str] = []
    # The critical decision: emit a distance the model can reason about
    # directly. Metres when the envelope's scale is known, grid units labelled
    # as such when it is not. Applying the scale per axis is what keeps an
    # east-west distance correct in a bbox whose width and height differ.
    usable_scale = (
        scale
        if scale is not None and math.isfinite(scale["x"]) and math.isfinite(scale["y"])
        else None
    )
    metres = (
        math.hypot(e.dx * usable_scale["x"], e.dy * usable_scale["y"])
        if usable_scale is not None
        else math.nan
    )

    if math.isfinite(metres):
        parts.append(f"dist: {_n(_js_round(metres))}m")
    elif math.isfinite(e.dist):
        # Scale is unusable, but the raw geometry is sound. Label it as grid
        # units so the agent does not mistake 2048 units for 2048 metres.
        parts.append(f"dist: {_n(_js_round(e.dist))}u")
    else:
        # A non-finite distance means the geometry itself is broken. Say so
        # explicitly rather than writing "NaN", which a model reads as a value.
        parts.append("dist: unknown")
    parts.append(f"dir: {e.dir}")
    if e.path:
        parts.append(f"path: {e.path}")
    if e.crosswalk:
        parts.append("crosswalk: true")
    if e.blocked:
        parts.append("blocked: true")
    return "{" + ", ".join(parts) + "}"


def _js_round(x: float) -> float:
    from .types import js_round

    return js_round(x)

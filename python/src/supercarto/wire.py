"""SCR (SuperCarto 1) wire codec — Python port of ``src/wire/{geometry,encode,decode}.ts``.

Serializes and parses the SCR text format: envelope, meta, layer/class/string
tables, attribute sets, quantized features, heat layers, omissions, refs and
routes. The encoding rules that keep the output small (delta paths for long
polylines, a string dictionary, sparse heat cells) and the parsing rules that
keep it safe (strict integer parsing, feature-count cap, single forward pass)
are ported verbatim.

Byte parity with the TypeScript codec is the gate. That is why every number
interpolation here goes through ``types.js_num_str`` — the codec's bytes carry
JavaScript's number formatting (``2``, never ``2.0``; ``1.5e-7``, never
``1.5e-07``) — and why TS functions named ``int()``/``num()`` appear here as
``strict_int()``/``strict_num()`` (shadowing the Python builtin in module
scope would be worse than a rename).
"""

from __future__ import annotations

import functools
import math
import re

from .types import (
    DEFAULT_EXTENT,
    DEFAULT_PROJECTION,
    SCR_MAGIC,
    AttrBool,
    AttributeSet,
    AttrNum,
    AttrRef,
    AttrToken,
    BboxEnvelope,
    BuildingGeom,
    ClassDef,
    Feature,
    GridPoint,
    GridPolygonPart,
    HeatCell,
    HeatLayer,
    HeatRow,
    HeatRun,
    IndexedHeatCell,
    Layer,
    LineGeom,
    Omission,
    PointGeom,
    PolygonGeom,
    Prop,
    Ref,
    Route,
    RouteStep,
    ScrDocument,
    TileEnvelope,
    js_num_str,
    js_number,
)

__all__ = [
    "DELTA_PREFIX",
    "PART_SEPARATOR",
    "RING_SEPARATOR",
    "VERTEX_SEPARATOR",
    "ScrError",
    "close_ring",
    "decode_delta_path",
    "decode_document",
    "decode_path",
    "decode_path_auto",
    "decode_polygon",
    "decode_props",
    "decode_rle_runs",
    "decode_sparse_cells",
    "encode_delta_path",
    "encode_document",
    "encode_heat_body",
    "encode_indexed_heat",
    "encode_path",
    "encode_path_smart",
    "encode_point",
    "encode_polygon",
    "encode_props",
    "encode_rle_heat",
    "encode_sparse_heat",
    "open_ring",
    "signed_ring_area",
    "strict_int",
    "strict_num",
]

#: Separates polygon parts. Chosen over winding-order inference so decoding is
#: unambiguous.
PART_SEPARATOR = "||"
RING_SEPARATOR = "|"
VERTEX_SEPARATOR = ";"
DELTA_PREFIX = "d:"


class ScrError(Exception):
    """Raised for any malformed or unsupported SCR input."""

    def __init__(self, message: str, line: int | None = None) -> None:
        # TS prefixes the message with the 1-based line when it is known.
        super().__init__(f"line {line}: {message}" if line is not None else message)
        self.line = line


# ---------------------------------------------------------------------------
# Scalar parsing
# ---------------------------------------------------------------------------


def strict_int(text: str) -> int:
    """Strict integer parse (TS ``int()``). Rejects ``1.5``, ``abc`` and ``1e3``."""
    if not re.fullmatch(r"-?\d+", text):
        raise ScrError(f'expected integer, got "{text}"')
    return int(text)


def strict_num(text: str) -> float:
    """Number parse (TS ``num()``): anything JS ``Number()`` would reject or make non-finite."""
    n = js_number(text)
    if not math.isfinite(n):
        raise ScrError(f'expected number, got "{text}"')
    return n


# ---------------------------------------------------------------------------
# Coordinate lists
# ---------------------------------------------------------------------------


def encode_path(line: list[GridPoint]) -> str:
    """Encode an absolute path as ``x,y;x,y;...``."""
    out = ""
    for i, p in enumerate(line):
        if i > 0:
            out += VERTEX_SEPARATOR
        out += f"{js_num_str(p.x)},{js_num_str(p.y)}"
    return out


def encode_delta_path(line: list[GridPoint]) -> str:
    """Encode a path as a delta list: first vertex absolute, rest displacements.

    The payload is one flat comma-separated number stream, matching the spec:
    ``d:100,100,50,0,0,50`` is three vertices. Deliberately not
    ``;``-separated like an absolute path, which keeps the number stream
    uniform and removes any chance of mixing the two conventions inside one
    payload.
    """
    if not line:
        return ""
    parts = [f"{js_num_str(line[0].x)},{js_num_str(line[0].y)}"]
    for i in range(1, len(line)):
        prev, cur = line[i - 1], line[i]
        parts.append(f"{js_num_str(cur.x - prev.x)},{js_num_str(cur.y - prev.y)}")
    return DELTA_PREFIX + ",".join(parts)


def decode_path(text: str) -> list[GridPoint]:
    """Parse ``x,y;x,y;...``, absolute."""
    if text == "":
        return []
    out: list[GridPoint] = []
    for chunk in text.split(VERTEX_SEPARATOR):
        if chunk == "":
            continue
        out.append(parse_point(chunk))
    return out


def decode_delta_path(text: str) -> list[GridPoint]:
    """Parse ``d:x,y,dx,dy,...``, resolving the running position.

    The whole payload is one comma-separated number stream, where the first
    pair is absolute and every later pair is a displacement. It is not
    ``;``-separated like an absolute path, so it must be split on commas.
    """
    body = text[len(DELTA_PREFIX):]
    if body == "":
        return []
    nums = [s for s in body.split(",") if s != ""]
    if len(nums) < 2:
        raise ScrError(f'delta path needs at least one vertex, got "{text}"')
    if len(nums) % 2 != 0:
        raise ScrError(f'delta path has odd coordinate count in "{text}"')
    x = strict_int(nums[0])
    y = strict_int(nums[1])
    out = [GridPoint(x=x, y=y)]
    for i in range(2, len(nums), 2):
        x += strict_int(nums[i])
        y += strict_int(nums[i + 1])
        out.append(GridPoint(x=x, y=y))
    return out


def decode_path_auto(text: str) -> list[GridPoint]:
    """Parse either form, detecting the ``d:`` prefix."""
    return decode_delta_path(text) if text.startswith(DELTA_PREFIX) else decode_path(text)


def encode_path_smart(line: list[GridPoint]) -> str:
    """Choose delta for long paths (where it pays) and absolute for short ones."""
    return encode_delta_path(line) if len(line) >= 4 else encode_path(line)


# ---------------------------------------------------------------------------
# Rings and polygons
# ---------------------------------------------------------------------------


def close_ring(line: list[GridPoint]) -> list[GridPoint]:
    if not line:
        return line
    a, b = line[0], line[-1]
    if a.x == b.x and a.y == b.y:
        return line
    return list(line) + [GridPoint(x=a.x, y=a.y)]


def open_ring(line: list[GridPoint]) -> list[GridPoint]:
    """Open a ring, dropping a duplicated closing vertex. Rings are implicitly closed."""
    if len(line) < 2:
        return line
    a, b = line[0], line[-1]
    if a.x == b.x and a.y == b.y:
        return line[:-1]
    return line


def encode_polygon(polygon: list) -> str:
    """Encode a polygon as ``ext|hole||ext2|hole2``."""
    return PART_SEPARATOR.join(
        RING_SEPARATOR.join(encode_path_smart(ring) for ring in part.rings) for part in polygon
    )


def decode_polygon(text: str) -> list:
    """Decode a polygon. ``||`` separates parts, ``|`` separates rings.

    The first ring of each part is the exterior; the rest are holes.
    """
    if text == "":
        return []
    parts: list = []
    for part_text in text.split(PART_SEPARATOR):
        rings = [
            decode_path_auto(r)
            for r in part_text.split(RING_SEPARATOR)
            if r != ""
        ]
        if rings:
            parts.append(GridPolygonPart(rings=rings))
    return parts


def signed_ring_area(ring: list[GridPoint]) -> float:
    """Ring area in grid units, sign indicating winding. Used for orientation fixes."""
    r = close_ring(ring)
    total = 0
    for i in range(len(r) - 1):
        a, b = r[i], r[i + 1]
        total += a.x * b.y - b.x * a.y
    return total / 2


# ---------------------------------------------------------------------------
# Point payloads
# ---------------------------------------------------------------------------


def encode_point(p: GridPoint) -> str:
    return f"{js_num_str(p.x)},{js_num_str(p.y)}" if p.z is None else (
        f"{js_num_str(p.x)},{js_num_str(p.y)},{js_num_str(p.z)}"
    )


def parse_point(chunk: str) -> GridPoint:
    parts = chunk.split(",")
    if len(parts) < 2:
        raise ScrError(f'malformed point "{chunk}"')
    p = GridPoint(x=strict_int(parts[0]), y=strict_int(parts[1]))
    if len(parts) >= 3 and parts[2] != "":
        p.z = strict_int(parts[2])
    return p


# ---------------------------------------------------------------------------
# Heat encodings
# ---------------------------------------------------------------------------


def encode_sparse_heat(h: HeatLayer) -> list[str]:
    """``X <id> x,y,v;x,y,v`` — sparse cells."""
    cells = h.cells or []
    body = VERTEX_SEPARATOR.join(f"{js_num_str(c.x)},{js_num_str(c.y)},{js_num_str(c.value)}" for c in cells)
    return [] if body == "" else [f"X {h.id} {body}"]


def encode_rle_heat(h: HeatLayer) -> list[str]:
    """``D <id> <row> x,len,v;x,len,v`` — run-length rows."""
    rows = h.rows or []
    out = []
    for row in rows:
        if not row.runs:
            continue
        body = VERTEX_SEPARATOR.join(
            f"{js_num_str(r.x)},{js_num_str(r.len)},{js_num_str(r.value)}" for r in row.runs
        )
        out.append(f"D {h.id} {js_num_str(row.y)} {body}")
    return out


def encode_indexed_heat(h: HeatLayer) -> list[str]:
    """``HC <id> <cell> <value>`` — externally indexed cells."""
    return [f"HC {h.id} {c.cell} {js_num_str(c.value)}" for c in (h.indexed or [])]


def encode_heat_body(h: HeatLayer) -> list[str]:
    if h.encoding == "rle":
        return encode_rle_heat(h)
    if h.encoding == "cell":
        return encode_indexed_heat(h)
    return encode_sparse_heat(h)


def decode_sparse_cells(text: str) -> list[HeatCell]:
    """Parse an ``X`` payload body into cells."""
    out: list[HeatCell] = []
    for chunk in text.split(VERTEX_SEPARATOR):
        if chunk == "":
            continue
        parts = chunk.split(",")
        if len(parts) < 3:
            raise ScrError(f'malformed heat cell "{chunk}"')
        out.append(HeatCell(x=strict_int(parts[0]), y=strict_int(parts[1]), value=strict_num(parts[2])))
    return out


def decode_rle_runs(text: str) -> list[HeatRun]:
    """Parse a ``D`` payload body into runs."""
    out: list[HeatRun] = []
    for chunk in text.split(VERTEX_SEPARATOR):
        if chunk == "":
            continue
        parts = chunk.split(",")
        if len(parts) < 3:
            raise ScrError(f'malformed heat run "{chunk}"')
        out.append(HeatRun(x=strict_int(parts[0]), len=strict_int(parts[1]), value=strict_num(parts[2])))
    return out


# ---------------------------------------------------------------------------
# Attribute values
# ---------------------------------------------------------------------------


def encode_props(props: list[Prop]) -> str:
    """``key=s123;12=18;13=true``"""

    def render(p: Prop) -> str:
        v = p.value
        if v.t == "ref":
            rendered = f"s{v.ref}"
        elif v.t == "num":
            rendered = js_num_str(v.num)
        elif v.t == "bool":
            rendered = "true" if v.bool else "false"
        else:
            rendered = v.token
        return f"{p.key}={rendered}"

    return VERTEX_SEPARATOR.join(render(p) for p in props)


def decode_props(text: str) -> list[Prop]:
    """Parse ``key=value`` pairs.

    A value of the form ``s<digits>`` becomes a string reference; a bare token
    stays a token so that ``s``-ambiguity is never silently resolved the wrong
    way.
    """
    if text == "" or text == "0":
        return []
    out: list[Prop] = []
    for chunk in text.split(VERTEX_SEPARATOR):
        if chunk == "":
            continue
        eq = chunk.find("=")
        if eq < 0:
            raise ScrError(f'malformed property "{chunk}"')
        key = strict_int(chunk[:eq])
        raw = chunk[eq + 1:]
        out.append(Prop(key=key, value=parse_attr_value(raw)))
    return out


def parse_attr_value(raw: str) -> AttrRef | AttrNum | AttrBool | AttrToken:
    if re.fullmatch(r"s\d+", raw):
        return AttrRef(ref=strict_int(raw[1:]))
    if raw == "true":
        return AttrBool(bool=True)
    if raw == "false":
        return AttrBool(bool=False)
    if re.fullmatch(r"-?\d+(\.\d+)?([eE][-+]?\d+)?", raw):
        return AttrNum(num=js_number(raw))
    return AttrToken(token=raw)


# ---------------------------------------------------------------------------
# Document encoding
# ---------------------------------------------------------------------------


def encode_document(doc: ScrDocument, opts: dict | None = None) -> str:
    """Serialize a document to SCR text.

    ``opts["group"]`` (default True) emits blank lines between record groups:
    a few bytes each, and a dumped document stays readable while debugging.
    """
    group = (opts or {}).get("group", True)
    out: list[str] = []

    def nl(s: str = "") -> None:
        out.append(s)

    def gap() -> None:
        if group and out and out[-1] != "":
            out.append("")

    nl(f"{SCR_MAGIC} {doc.version}")
    nl(encode_envelope(doc.envelope))
    if doc.projection != DEFAULT_PROJECTION:
        nl(f"PROJ {doc.projection}")
    nl(f"Q {js_num_str(doc.extent)}")
    if doc.buffer:
        nl(f"BUF {js_num_str(doc.buffer)}")

    if doc.meta:
        gap()
        for key in sorted(doc.meta):
            nl(f"META {key} {doc.meta[key]}")

    if doc.layers:
        gap()
        for layer in _sort_by_id(doc.layers.values()):
            nl(f"L {js_num_str(layer.id)} {layer.name}")

    if doc.classes:
        gap()
        for c in _sort_by_id(doc.classes.values()):
            nl(f"C {js_num_str(c.id)} {js_num_str(c.layerId)} {c.name}")

    if doc.strings:
        gap()
        # TS sorts the *entries*, and idOf(entry) falls through to
        # String(entry) because an array has no `id` property — so this is
        # lexicographic order on the joined "id,text" string, not numeric id
        # order. Reproduced exactly.
        for sid, text in sorted(doc.strings.items(), key=lambda kv: f"{js_num_str(kv[0])},{kv[1]}"):
            nl(f"S {js_num_str(sid)} {text}")

    if doc.attrSets:
        gap()
        for a in _sort_by_id(doc.attrSets.values()):
            nl(f"A {js_num_str(a.id)} {encode_props(a.props)}")

    if doc.features:
        gap()
        for f in doc.features:
            nl(encode_feature(f))

    if doc.heat:
        gap()
        for h in doc.heat:
            nl(
                f"H {js_num_str(h.id)} {h.name} {js_num_str(h.resolution)} "
                f"{js_num_str(h.minValue)} {js_num_str(h.maxValue)}"
            )
            for line in encode_heat_body(h):
                nl(line)

    if doc.omissions:
        gap()
        for o in doc.omissions:
            nl(encode_omission(o))

    if doc.refs:
        gap()
        for r in doc.refs:
            nl(encode_ref(r))

    for route in doc.routes:
        gap()
        nl(encode_route_header(route))
        for step in route.steps:
            nl(encode_step(step))

    return "\n".join(out) + "\n"


def encode_envelope(env) -> str:
    # Ingest builds typed envelopes; the live paths pass dict-shaped ones.
    def field(name: str):
        return env.get(name) if isinstance(env, dict) else getattr(env, name)

    env_type = env["type"] if isinstance(env, dict) else env.type
    if env_type == "tile":
        return f"TILE {js_num_str(field('z'))} {js_num_str(field('x'))} {js_num_str(field('y'))}"
    return (
        f"BBOX {js_num_str(field('west'))} {js_num_str(field('south'))} "
        f"{js_num_str(field('east'))} {js_num_str(field('north'))}"
    )


def encode_feature(f: Feature) -> str:
    payload = encode_geometry_payload(f)
    return (
        f"F {js_num_str(f.id)} {js_num_str(f.layerId)} {js_num_str(f.classId)} "
        f"{_geom_kind_tag(f.kind)} {js_num_str(f.attrSet)} {payload}"
    )


def _geom_kind_tag(kind: str) -> str:
    return {"point": "P", "line": "L", "polygon": "G", "building": "B"}.get(kind, kind)


def encode_geometry_payload(f: Feature) -> str:
    g = f.geometry
    if g.kind == "point":
        return encode_point(g.point)
    if g.kind == "line":
        # Multiline: `|`-joined parts, no ring semantics.
        return RING_SEPARATOR.join(encode_path_smart(line) for line in g.lines)
    return encode_polygon(g.polygon)


def encode_omission(o: Omission) -> str:
    line = f"O {js_num_str(o.layerId)} {js_num_str(o.count)}"
    if o.centroid is not None:
        line += f" centroid={js_num_str(o.centroid.x)},{js_num_str(o.centroid.y)}"
    if o.note is not None:
        line += f" note={js_num_str(o.note)}"
    return line


def encode_ref(r: Ref) -> str:
    line = f"REF {r.kind} {r.uri}"
    if r.mime:
        line += f" mime={r.mime}"
    if r.note is not None:
        line += f" note={js_num_str(r.note)}"
    return line


def encode_route_header(r: Route) -> str:
    line = f"ROUTE {js_num_str(r.id)} {r.mode}"
    if r.dist is not None:
        line += f" dist={js_num_str(r.dist)}"
    if r.time is not None:
        line += f" time={js_num_str(r.time)}"
    return line


def encode_step(s: RouteStep) -> str:
    # The instruction is the rest of the line, so it must come after all kv pairs.
    kv: list[str] = []
    if s.dist is not None:
        kv.append(f"dist={js_num_str(s.dist)}")
    if s.ref is not None:
        kv.append(f"ref={js_num_str(s.ref)}")
    if s.turn is not None:
        kv.append(f"turn={s.turn}")
    head = " ".join(kv) + " " if kv else ""
    return f"STEP {js_num_str(s.n)} {head}{s.instruction}"


def _sort_by_id(items):
    """Sort Map values by id, mirroring TS ``sorted()``/``compareIds`` for deterministic output."""
    return sorted(items, key=functools.cmp_to_key(compare_ids))


def compare_ids(a, b) -> float:
    """Sort comparator mirroring TS ``compareIds``: numeric ids ascending, else string order."""
    av = _id_of(a)
    bv = _id_of(b)
    if isinstance(av, (int, float)) and isinstance(bv, (int, float)):
        return av - bv
    return -1 if str(av) < str(bv) else (1 if str(av) > str(bv) else 0)


def _id_of(x):
    if isinstance(x, (int, float)):
        return x
    id_ = getattr(x, "id", None)
    if isinstance(id_, (int, float)):
        return id_
    if isinstance(id_, str):
        return id_
    return str(x)


# ---------------------------------------------------------------------------
# Document decoding
# ---------------------------------------------------------------------------

_STEP_KV = re.compile(r"^(dist|ref|turn)=(\S+)\s*")


def decode_document(text: str, opts: dict | None = None) -> ScrDocument:
    """Parse SCR text into a document. Single forward pass, no backtracking.

    ``opts["maxFeatures"]`` (default 5,000,000) guards against a hostile
    document exploding memory.
    """
    max_features = (opts or {}).get("maxFeatures", 5_000_000)
    lines = text.split("\n")

    doc = ScrDocument(
        version=1,
        envelope=TileEnvelope(z=0, x=0, y=0),
        projection=DEFAULT_PROJECTION,
        extent=DEFAULT_EXTENT,
        buffer=0,
        meta={},
        layers={},
        classes={},
        strings={},
        attrSets={},
        features=[],
        heat=[],
        omissions=[],
        refs=[],
        routes=[],
    )

    saw_header = False
    saw_envelope = False
    saw_q = False
    heat_by_id: dict[int, HeatLayer] = {}
    route_by_id: dict[int, Route] = {}

    line_no = 0
    for raw in lines:
        line_no += 1
        line = raw.strip()
        if line == "" or line.startswith("#"):
            continue

        sp = line.find(" ")
        tag = line if sp < 0 else line[:sp]
        rest = "" if sp < 0 else line[sp + 1:].strip()

        if not saw_header:
            if tag != SCR_MAGIC:
                raise ScrError(f'expected "{SCR_MAGIC}" header, got "{tag}"', line_no)
            version = strict_int(rest)
            if version != 1:
                raise ScrError(f"unsupported SCR major version {version}", line_no)
            doc.version = version
            saw_header = True
            continue

        if tag == "TILE":
            f = _fields(rest, 3, "TILE", line_no)
            doc.envelope = TileEnvelope(z=strict_int(f[0]), x=strict_int(f[1]), y=strict_int(f[2]))
            saw_envelope = True
        elif tag == "BBOX":
            f = _fields(rest, 4, "BBOX", line_no)
            doc.envelope = BboxEnvelope(
                west=strict_num(f[0]), south=strict_num(f[1]),
                east=strict_num(f[2]), north=strict_num(f[3]),
            )
            saw_envelope = True
        elif tag == "PROJ":
            name = _fields(rest, 1, "PROJ", line_no)[0]
            if name not in ("webmerc", "wgs84"):
                raise ScrError(f'unknown projection "{name}"', line_no)
            doc.projection = name
        elif tag == "Q":
            doc.extent = strict_int(_fields(rest, 1, "Q", line_no)[0])
            saw_q = True
        elif tag == "BUF":
            doc.buffer = strict_int(_fields(rest, 1, "BUF", line_no)[0])
        elif tag == "META":
            f = _fields(rest, 2, "META", line_no)
            doc.meta[f[0]] = " ".join(f[1:])
        elif tag == "L":
            f = _fields(rest, 2, "L", line_no)
            layer = Layer(id=strict_int(f[0]), name=" ".join(f[1:]))
            doc.layers[layer.id] = layer
        elif tag == "C":
            f = _fields(rest, 3, "C", line_no)
            cls = ClassDef(id=strict_int(f[0]), layerId=strict_int(f[1]), name=" ".join(f[2:]))
            doc.classes[cls.id] = cls
        elif tag == "S":
            sp2 = rest.find(" ")
            if sp2 < 0:
                raise ScrError("S record needs text", line_no)
            doc.strings[strict_int(rest[:sp2])] = rest[sp2 + 1:]
        elif tag == "A":
            f = _fields(rest, 2, "A", line_no)
            attr_set = AttributeSet(id=strict_int(f[0]), props=decode_props(f[1]))
            doc.attrSets[attr_set.id] = attr_set
        elif tag == "F":
            if len(doc.features) >= max_features:
                raise ScrError(f"feature count exceeds maxFeatures ({max_features})", line_no)
            doc.features.append(_decode_feature(rest, line_no))
        elif tag == "H":
            f = _fields(rest, 5, "H", line_no)
            layer = HeatLayer(
                id=strict_int(f[0]),
                name=f[1],
                resolution=strict_int(f[2]),
                minValue=strict_num(f[3]),
                maxValue=strict_num(f[4]),
                encoding="sparse",
                cells=[],
            )
            heat_by_id[layer.id] = layer
            doc.heat.append(layer)
        elif tag == "D":
            f = _fields(rest, 3, "D", line_no)
            h = _require_heat(heat_by_id, strict_int(f[0]), line_no)
            h.encoding = "rle"
            if h.rows is None:
                h.rows = []
            h.rows.append(HeatRow(y=strict_int(f[1]), runs=decode_rle_runs(f[2])))
        elif tag == "X":
            f = _fields(rest, 2, "X", line_no)
            h = _require_heat(heat_by_id, strict_int(f[0]), line_no)
            h.encoding = "sparse"
            if h.cells is None:
                h.cells = []
            h.cells.extend(decode_sparse_cells(f[1]))
        elif tag == "HC":
            f = _fields(rest, 3, "HC", line_no)
            h = _require_heat(heat_by_id, strict_int(f[0]), line_no)
            h.encoding = "cell"
            if h.indexed is None:
                h.indexed = []
            h.indexed.append(IndexedHeatCell(cell=f[1], value=strict_num(f[2])))
        elif tag == "O":
            f = _fields(rest, 2, "O", line_no)
            omission = Omission(layerId=strict_int(f[0]), count=strict_int(f[1]))
            for tok in f[2:]:
                eq = tok.find("=")
                if eq < 0:
                    raise ScrError(f'malformed O option "{tok}"', line_no)
                k, v = tok[:eq], tok[eq + 1:]
                if k == "centroid":
                    c = v.split(",")
                    omission.centroid = GridPoint(x=strict_int(c[0]), y=strict_int(c[1]))
                elif k == "note":
                    omission.note = strict_int(v)
                else:
                    raise ScrError(f'unknown O option "{k}"', line_no)
            doc.omissions.append(omission)
        elif tag == "REF":
            f = _fields(rest, 2, "REF", line_no)
            ref = Ref(kind=f[0], uri=f[1])
            for tok in f[2:]:
                eq = tok.find("=")
                if eq < 0:
                    raise ScrError(f'malformed REF option "{tok}"', line_no)
                k, v = tok[:eq], tok[eq + 1:]
                if k == "mime":
                    ref.mime = v
                elif k == "note":
                    ref.note = strict_int(v)
                else:
                    raise ScrError(f'unknown REF option "{k}"', line_no)
            doc.refs.append(ref)
        elif tag == "ROUTE":
            f = _fields(rest, 2, "ROUTE", line_no)
            route = Route(id=strict_int(f[0]), mode=f[1], steps=[])
            for tok in f[2:]:
                eq = tok.find("=")
                if eq < 0:
                    raise ScrError(f'malformed ROUTE option "{tok}"', line_no)
                k, v = tok[:eq], tok[eq + 1:]
                if k == "dist":
                    route.dist = strict_int(v)
                elif k == "time":
                    route.time = strict_int(v)
                else:
                    raise ScrError(f'unknown ROUTE option "{k}"', line_no)
            route_by_id[route.id] = route
            doc.routes.append(route)
        elif tag == "STEP":
            sp3 = rest.find(" ")
            if sp3 < 0:
                raise ScrError("STEP record needs an instruction", line_no)
            step = RouteStep(n=strict_int(rest[:sp3]), instruction="")
            # Leading `k=v` pairs, then the instruction as the rest of the line.
            tail = rest[sp3 + 1:]
            consumed = 0
            while True:
                m = _STEP_KV.match(tail[consumed:])
                if not m:
                    break
                k, v = m.group(1), m.group(2)
                if k == "dist":
                    step.dist = strict_int(v)
                elif k == "ref":
                    step.ref = strict_int(v)
                else:
                    step.turn = v
                consumed += len(m.group(0))
            step.instruction = tail[consumed:].strip()
            if step.instruction == "":
                raise ScrError("STEP instruction is empty", line_no)
            route = _last_route(route_by_id, line_no)
            route.steps.append(step)
        else:
            raise ScrError(f'unknown record tag "{tag}"', line_no)

    if not saw_header:
        raise ScrError("empty document: missing SCR header")
    if not saw_envelope:
        raise ScrError("missing envelope: need TILE or BBOX")
    if not saw_q:
        raise ScrError("missing Q record: quantization extent is required")

    return doc


def _fields(rest: str, count: int, tag: str, line_no: int) -> list[str]:
    """Split a record's payload into fields and require at least ``count``.

    Extra fields beyond ``count`` are permitted: a trailing name may
    legitimately contain spaces, and the caller joins the remainder itself.
    That is why this only enforces a lower bound.
    """
    parts = rest.split(" ") if rest else []
    if len(parts) < count:
        raise ScrError(f"{tag} needs {count} fields, got {len(parts)}", line_no)
    return parts


def _require_heat(by_id: dict[int, HeatLayer], hid: int, line_no: int) -> HeatLayer:
    h = by_id.get(hid)
    if h is None:
        raise ScrError(f"heat record references undeclared layer {hid}", line_no)
    return h


def _last_route(by_id: dict[int, Route], line_no: int) -> Route:
    last = None
    for r in by_id.values():
        last = r
    if last is None:
        raise ScrError("STEP record before any ROUTE record", line_no)
    return last


def _decode_feature(rest: str, line_no: int) -> Feature:
    f = _fields(rest, 6, "F", line_no)
    id_ = strict_int(f[0])
    layer_id = strict_int(f[1])
    class_id = strict_int(f[2])
    kind = _decode_geom_kind(f[3], line_no)
    attr_set = strict_int(f[4])
    payload = " ".join(f[5:])
    return Feature(
        id=id_, layerId=layer_id, classId=class_id, kind=kind,
        attrSet=attr_set, geometry=_decode_geometry(kind, payload),
    )


def _decode_geom_kind(tag: str, line_no: int) -> str:
    kind = {"P": "point", "L": "line", "G": "polygon", "B": "building"}.get(tag)
    if kind is None:
        raise ScrError(f'unknown geometry kind "{tag}"', line_no)
    return kind


def _decode_geometry(kind: str, payload: str):
    if kind == "point":
        path = decode_path(payload)
        if not path:
            raise ScrError("point geometry is empty")
        return PointGeom(point=path[0])
    if kind == "line":
        lines = [decode_path_auto(s) for s in payload.split(RING_SEPARATOR) if s != ""]
        return LineGeom(lines=lines)
    if kind == "polygon":
        return PolygonGeom(polygon=decode_polygon(payload))
    return BuildingGeom(polygon=decode_polygon(payload))

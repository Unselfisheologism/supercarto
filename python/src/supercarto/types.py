"""SCR (SuperCarto 1) document model — Python port of ``src/wire/types.ts``.

This is the decoded, in-memory shape of an SCR document. It is deliberately
flat and array-based: an ingester fills it in one forward pass, and the
compiler reads it. See ``docs/spec.md`` for the normative grammar.

Milestone-1 note: the SCR text/binary codec is not ported yet, so documents
exist only in this in-memory form (and never round-trip through strings).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

DEFAULT_EXTENT = 4096
DEFAULT_PROJECTION = "webmerc"
SCR_MAGIC = "SCR"

#: Attribute-key string ids below this are conventionally keys, not values.
KEY_STRING_CEILING = 100


@dataclass
class GridPoint:
    x: float
    y: float
    #: Metres above the ellipsoid. Only meaningful on point geometry.
    z: float | None = None


#: A polyline in the quantized grid. ``z`` is never present.
GridLine = list[GridPoint]


@dataclass
class GridPolygonPart:
    #: Ring 0 is the exterior, the rest are holes. Rings are stored open.
    rings: list[GridLine]


#: A polygon grouped by part.
GridPolygon = list[GridPolygonPart]


@dataclass
class PointGeom:
    kind: str = field(default="point", init=False)
    point: GridPoint


@dataclass
class LineGeom:
    kind: str = field(default="line", init=False)
    lines: list[GridLine]


@dataclass
class PolygonGeom:
    kind: str = field(default="polygon", init=False)
    polygon: GridPolygon


@dataclass
class BuildingGeom:
    kind: str = field(default="building", init=False)
    polygon: GridPolygon


#: Geometry union, discriminated by ``kind``.
GridGeometry = PointGeom | LineGeom | PolygonGeom | BuildingGeom

GeomKind = str


@dataclass
class TileEnvelope:
    type: str = field(default="tile", init=False)
    z: int
    x: int
    y: int


@dataclass
class BboxEnvelope:
    type: str = field(default="bbox", init=False)
    west: float
    south: float
    east: float
    north: float


Envelope = TileEnvelope | BboxEnvelope


@dataclass
class Layer:
    id: int
    name: str


@dataclass
class ClassDef:
    id: int
    layerId: int
    name: str


@dataclass
class AttrRef:
    t: str = field(default="ref", init=False)
    ref: int


@dataclass
class AttrNum:
    t: str = field(default="num", init=False)
    num: float


@dataclass
class AttrBool:
    t: str = field(default="bool", init=False)
    bool: bool


@dataclass
class AttrToken:
    t: str = field(default="token", init=False)
    token: str


#: A decoded attribute value.
AttrValue = AttrRef | AttrNum | AttrBool | AttrToken


@dataclass
class Prop:
    #: String-dictionary id of the key.
    key: int
    value: AttrValue


@dataclass
class AttributeSet:
    id: int
    props: list[Prop]


@dataclass
class Feature:
    id: int
    layerId: int
    classId: int
    kind: GeomKind
    #: 0 means no attributes.
    attrSet: int
    geometry: GridGeometry


HeatEncoding = str


@dataclass
class HeatLayer:
    id: int
    name: str
    resolution: float
    minValue: float
    maxValue: float
    encoding: HeatEncoding
    #: ``sparse``: non-empty cells in grid coordinates.
    cells: list[HeatCell] | None = None
    #: ``rle``: run-length rows, keyed by row index.
    rows: list[HeatRow] | None = None
    #: ``cell``: externally indexed cells (H3/S2/etc).
    indexed: list[IndexedHeatCell] | None = None


@dataclass
class HeatRow:
    y: int
    runs: list[HeatRun]


@dataclass
class HeatRun:
    x: int
    len: int
    value: float


@dataclass
class IndexedHeatCell:
    cell: str
    value: float


@dataclass
class HeatCell:
    x: float
    y: float
    value: float


@dataclass
class Omission:
    layerId: int
    count: int
    centroid: GridPoint | None = None
    note: int | None = None


RefKind = str


@dataclass
class Ref:
    kind: RefKind | str
    uri: str
    mime: str | None = None
    note: int | None = None


@dataclass
class RouteStep:
    #: 1-based step number.
    n: int
    instruction: str
    dist: float | None = None
    #: String-dictionary id of the road name.
    ref: int | None = None
    turn: str | None = None


@dataclass
class Route:
    id: int
    mode: str
    dist: float | None = None
    time: float | None = None
    steps: list[RouteStep] = field(default_factory=list)


@dataclass
class ScrDocument:
    #: A fully decoded SCR document.
    version: int
    envelope: Envelope
    projection: str
    #: Quantization extent, integer grid resolution across the envelope.
    extent: int
    #: Coordinate buffer, so clipped geometry can exceed [0, extent].
    buffer: int
    meta: dict[str, str]
    layers: dict[int, Layer]
    classes: dict[int, ClassDef]
    #: String dictionary, keyed by id.
    strings: dict[int, str]
    attrSets: dict[int, AttributeSet]
    features: list[Feature]
    heat: list[HeatLayer]
    omissions: list[Omission]
    refs: list[Ref]
    routes: list[Route]


def is_finite(x: float) -> bool:
    return math.isfinite(x)


def js_number(raw: str) -> float:
    """Convert a string to a number with JavaScript ``Number()`` semantics.

    JSON sources are inconsistent about numbers and heights arrive as
    ``"18"`` as often as ``18``, so a converter that returns ``nan`` for
    anything JavaScript would coerce keeps the port from diverging on edge
    cases like ``"1e5"`` or ``"Infinity"``.

    Faithful to the grammar: a leading sign is not allowed with radix
    prefixes (``Number("-0x1f")`` is ``NaN``); hex/binary/octal literals need
    the ``0x``/``0b``/``0o`` prefix (bare ``"cafe"`` is ``NaN``, a distinction
    that matters for OSM tag values); the empty string is ``0``; ``Infinity``
    matches case-insensitively but bare ``"inf"`` is ``NaN``.
    """
    t = raw.strip()
    if t == "":
        return 0.0
    if t in ("Infinity", "+Infinity"):
        return math.inf
    if t == "-Infinity":
        return -math.inf
    if re.fullmatch(r"[+-]?0[xXoObB][0-9a-fA-F]+", t):
        # Signed equivalents are NaN in JS: only the unsigned form parses.
        if t[0] in "+-":
            return math.nan
        return float(int(t, 0))  # python accepts 0x/0b/0o prefixes here too
    if re.fullmatch(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?", t):
        return float(t)
    return math.nan


def js_round(x: float) -> float:
    """JavaScript ``Math.round``: floor(x + 0.5), which resolves .5 ties up.

    Python's built-in ``round`` is banker's rounding and disagrees with the
    TypeScript this port mirrors, so every converted rounding site calls this.
    """
    return math.floor(x + 0.5)


def utf16_length(text: str) -> int:
    """String length in UTF-16 code units.

    The token estimator in the original divides character counts by four, and
    those counts are JavaScript's UTF-16 lengths. Non-BMP characters (emoji in
    place names are real these days) count as two units there and one here,
    which would make Python believe a maplet is smaller than Node did.
    """
    return len(text.encode("utf-16-le")) // 2


def js_num_str(n: float) -> str:
    """JavaScript ``String(n)`` for numbers.

    SCR payloads interpolate coordinates, counts and attribute values with
    template literals, so the codec's bytes carry JavaScript's number
    formatting: Python's ``str()`` differs on integral floats (``"2.0"`` vs
    ``"2"``), negative zero (``"-0.0"`` vs ``"0"``) and exponent forms
    (``"1.5e-07"`` vs ``"1.5e-7"``).

    Both runtimes pick the same shortest round-trip digits (Python's ``repr``
    as well as V8), so this re-renders those digits under the ECMAScript
    ToString rules: decompose the value into digit string ``s`` (k digits) and
    exponent ``n`` with value ``= s * 10^(n - k)``, then
    ``k <= n <= 21`` -> digits padded with zeros,
    ``0 < n <= 21``       -> decimal point inserted after ``n`` digits,
    ``-6 < n <= 0``       -> ``0.`` + ``-n`` zeros + digits,
    otherwise             -> ``d1.d2... e (n-1)``.
    """
    if isinstance(n, bool):
        return "true" if n else "false"
    if isinstance(n, int):
        return str(n)
    if math.isnan(n):
        return "NaN"
    if math.isinf(n):
        return "Infinity" if n > 0 else "-Infinity"
    if n == 0:
        return "0"  # -0 prints as "0" too

    s = repr(n)  # shortest round-trip digits, same as V8 picks
    sign = ""
    if s[0] == "-":
        sign = "-"
        s = s[1:]

    if "e" in s:
        mant, _, exp_s = s.partition("e")
        m = int(exp_s)
    else:
        mant = s
        m = 0
    if "." in mant:
        ip, fp = mant.split(".", 1)
        # repr marks integral floats with a bare ".0"; that trailing zero is a
        # Python-ism, not a significant digit (JS prints 1.0 as "1").
        if not fp.strip("0"):
            fp = ""
    else:
        ip, fp = mant, ""
    digits_all = ip + fp
    if not digits_all.lstrip("0"):
        return "0"  # subnormal dust rounding to zero, defensively
    d = abs(int(digits_all))
    # value = digits_all * 10^shift, then simplified to s * 10^(n-k)
    shift = (m - len(fp)) if "e" in s else -len(fp)
    ds = str(d)
    k = len(ds)
    n10 = shift + k

    if k <= n10 <= 21:
        return sign + ds + "0" * (n10 - k)
    if 0 < n10 <= 21:
        head = ds[:n10] if n10 <= k else ds  # n10 < k implies a fraction digit
        tail = ds[n10:] if n10 <= k else ""
        return sign + head + "." + tail
    if -6 < n10 <= 0:
        z = max(0, -n10) if n10 < 0 else 0
        return sign + "0." + "0" * z + ds
    e_out = n10 - 1
    mant_out = ds[0] + ("." + ds[1:] if k > 1 else "")
    return f"{sign}{mant_out}e{'+' if e_out > 0 else '-'}{abs(e_out)}"


def js_fixed(n: float, d: int) -> str:
    """JavaScript ``n.toFixed(d)``.

    Python's format rounds half-to-even and JS's ``toFixed`` rounds the decimal
    representation half-away from zero in practice, so the scaling round-trip
    keeps emitted coordinates and query parameters byte-identical at edges
    like ``.00005``.
    """
    scaled = n * 10**d
    if not math.isfinite(scaled):
        # NaN/Infinity formatting is never hit by callers; mirror JS loosely.
        raw = "nan" if math.isnan(scaled) else ("Infinity" if scaled > 0 else "-Infinity")
        return raw
    r = int(js_round(scaled))
    sign = "-" if r < 0 else ""
    r = abs(r)
    if d == 0:
        return f"{sign}{r}"
    return f"{sign}{r // 10**d}.{r % 10**d:0{d}d}"

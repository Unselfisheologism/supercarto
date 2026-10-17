"""GeoJSON ingestion — port of ``src/ingest/geojson.ts``.

The adapter every source funnels through. OSM, Overture, PMTiles, and a
hand-written fixture all arrive as GeoJSON first, so the compiler only ever
sees one shape.

One determinism rule worth restating: property sets are iterated in a fixed
key order (sorted by key id), which keeps the attribute-set deduplication
signature stable so identical property sets collapse to one record.
"""

from __future__ import annotations

import json
import math
from typing import Any

from .project import lonlat_to_grid
from .types import (
    DEFAULT_EXTENT,
    DEFAULT_PROJECTION,
    AttrBool,
    AttributeSet,
    AttrNum,
    AttrRef,
    AttrToken,
    BboxEnvelope,
    BuildingGeom,
    ClassDef,
    Envelope,
    Feature,
    GridGeometry,
    GridPoint,
    GridPolygonPart,
    HeatCell,
    HeatLayer,
    Layer,
    LineGeom,
    PointGeom,
    PolygonGeom,
    Prop,
    ScrDocument,
    TileEnvelope,
    js_num_str,
    js_number,
)

#: Fixed key ids, so the compiler can recognise them without a lookup.
KEY_IDS = {
    "name": 10,
    "type": 11,
    "height_m": 12,
    "amenity": 13,
    "brand": 14,
    "opening_hours": 15,
    "highway": 16,
    "railway": 17,
    "crossing": 18,
    "indoor": 19,
    "layer": 20,
    "wheelchair": 21,
    "level": 22,
    "door": 23,
}

KEY_NAMES: dict[int, str] = {v: k for k, v in KEY_IDS.items()}

#: Property keys that become attributes. Everything else is dropped: an agent
#: does not need the OSM ``created_by`` or ``source`` fields, and every key
#: costs tokens on every feature that carries it.
KEPT_KEYS: list[tuple[str, int]] = [
    ("name", KEY_IDS["name"]),
    ("height", KEY_IDS["height_m"]),
    ("height_m", KEY_IDS["height_m"]),
    ("building:levels", KEY_IDS["height_m"]),
    ("amenity", KEY_IDS["amenity"]),
    ("brand", KEY_IDS["brand"]),
    ("opening_hours", KEY_IDS["opening_hours"]),
    ("highway", KEY_IDS["highway"]),
    ("railway", KEY_IDS["railway"]),
    ("crossing", KEY_IDS["crossing"]),
    ("indoor", KEY_IDS["indoor"]),
    ("wheelchair", KEY_IDS["wheelchair"]),
    # Storey tags. Both spellings are carried because OSM uses `level` for the
    # storey and `layer` for repeat-count styling on bridges and tunnels, and
    # an indoor extractor that reads only one of them silently misses half the
    # buildings. `level` is checked first at compile time.
    ("level", KEY_IDS["level"]),
    ("layer", KEY_IDS["layer"]),
    ("door", KEY_IDS["door"]),
]

#: First string id allocated to a value. Keys live below 100 by convention.
FIRST_VALUE_ID = 100

BLOCKING_TOKENS = frozenset(
    ["construction", "closed", "no", "barrier", "locked", "yes", "private"]
)

PATH_TOKENS = frozenset(
    [
        "footway",
        "pedestrian",
        "path",
        "steps",
        "cycleway",
        "corridor",
        "service",
        "track",
        "motorway",
        "trunk",
        "crossing",
        "crosswalk",
        "sidewalk",
    ]
)


class ScrError(ValueError):
    """Raised for malformed or unsupported geospatial input."""


class _Allocator:
    def __init__(self) -> None:
        self.strings: dict[int, str] = dict(KEY_NAMES)
        self.next_id = FIRST_VALUE_ID

    def intern(self, text: str) -> int:
        for id_, s in self.strings.items():
            if s == text:
                return id_
        id_ = self.next_id
        self.next_id += 1
        self.strings[id_] = text
        return id_


class _Counter:
    """Attribute-set id allocator, mirroring the TS `nextAttr++` closure."""

    def __init__(self) -> None:
        self.value = 1

    def __call__(self) -> int:
        v = self.value
        self.value += 1
        return v


def from_geojson(
    input_: list[dict] | dict,
    opts: dict[str, Any] | None = None,
) -> ScrDocument:
    """Convert GeoJSON into an SCR document.

    ``input_`` is a feature collection dict, a bare list of feature dicts, or a
    JSON string of either. Options mirror ``IngestOptions`` from TypeScript.
    """
    opts = opts or {}
    if isinstance(input_, str):
        input_ = json.loads(input_)
    features = input_ if isinstance(input_, list) else input_["features"]
    collection_heat = None if isinstance(input_, list) else input_.get("heat")

    max_features = opts.get("maxFeatures", 200_000)
    extent = int(opts.get("extent") or DEFAULT_EXTENT)
    buffer = int(opts.get("buffer") or 64)

    # Pass 1: find the data extent so we can build an envelope.
    west, south, east, north = math.inf, math.inf, -math.inf, -math.inf
    for f in features:
        for c in _coords_of(f.get("geometry")):
            west = min(west, c[0])
            south = min(south, c[1])
            east = max(east, c[0])
            north = max(north, c[1])
    if not math.isfinite(west):
        # An empty collection still needs a valid envelope, so use a null
        # island one-tile box rather than emitting NaN.
        return _empty_document(opts, extent, buffer)

    # A single axis can be degenerate: a perfectly horizontal street has zero
    # height, and a vertical one zero width. ``lonLatToGrid`` divides by the
    # span, so a zero span yields NaN coordinates that silently poison every
    # downstream distance. Widen any degenerate axis to a small real extent.
    min_span = 1e-7
    if east - west < min_span:
        mid = (east + west) / 2
        west = mid - min_span / 2
        east = mid + min_span / 2
    if north - south < min_span:
        mid = (north + south) / 2
        south = mid - min_span / 2
        north = mid + min_span / 2

    envelope: Envelope = opts.get("envelope") or BboxEnvelope(west, south, east, north)
    projection: str = opts.get("projection") or DEFAULT_PROJECTION

    doc = ScrDocument(
        version=1,
        envelope=envelope,
        projection=projection,
        extent=extent,
        buffer=buffer,
        meta={"source": opts.get("source") or "geojson"},
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

    alloc = _Allocator()
    for id_, name in alloc.strings.items():
        doc.strings[id_] = name

    # Pass 2: classify, quantize, and intern.
    layer_ids: dict[str, int] = {}
    class_ids: dict[str, int] = {}
    attr_ids: dict[str, int] = {}
    next_layer = 1
    next_class = 1
    counter = _Counter()
    feature_id = 1

    for f in features:
        if len(doc.features) >= max_features:
            raise ScrError(f"feature count exceeds maxFeatures ({max_features})")
        if not f.get("geometry"):
            continue

        layer_name = _resolve_layer(f, opts.get("layerKey"))
        class_name = _resolve_class(f, layer_name)
        layer_id = layer_ids.get(layer_name, next_layer)
        if layer_name not in layer_ids:
            layer_ids[layer_name] = layer_id
            doc.layers[layer_id] = Layer(layer_id, layer_name)
            next_layer += 1
        class_id = class_ids.get(class_name, next_class)
        if class_name not in class_ids:
            class_ids[class_name] = class_id
            doc.classes[class_id] = ClassDef(class_id, layer_id, class_name)
            next_class += 1

        geometry = _quantize(f["geometry"], envelope, extent, projection)
        if geometry is None:
            continue

        attr_set = _build_attr_set(
            f.get("properties") or {},
            alloc,
            attr_ids,
            doc.attrSets,
            counter,
        )

        # Prefer the source's own id so `expand_feature(id)` can address the
        # same feature upstream. `0` is a legitimate id, so test for presence
        # explicitly.
        source_id = js_number(str(f["id"])) if f.get("id") is not None else math.nan
        doc.features.append(
            Feature(
                id=source_id if math.isfinite(source_id) else feature_id,
                layerId=layer_id,
                classId=class_id,
                kind=geometry.kind,
                attrSet=attr_set or 0,
                geometry=geometry,
            )
        )
        feature_id += 1

    for id_, s in alloc.strings.items():
        doc.strings[id_] = s

    for i, h in enumerate(collection_heat or []):
        # Malformed heat fails loudly rather than silently dropping a layer
        # the benchmark then grades against. A missing hotspot reads as a
        # model failure otherwise, which is the exact confusion this file
        # exists to prevent.
        valid = (
            isinstance(h, dict)
            and isinstance(h.get("name"), str)
            and isinstance(h.get("resolution"), (int, float))
            and math.isfinite(h.get("resolution", math.nan))
            and h.get("resolution", 0) > 0
            and isinstance(h.get("min"), (int, float))
            and math.isfinite(h.get("min", math.nan))
            and isinstance(h.get("max"), (int, float))
            and math.isfinite(h.get("max", math.nan))
            and isinstance(h.get("cells"), list)
            and all(
                isinstance(c, dict)
                and math.isfinite(c.get("x", math.nan))
                and math.isfinite(c.get("y", math.nan))
                and math.isfinite(c.get("value", math.nan))
                for c in h["cells"]
            )
        )
        if not valid:
            raise ScrError(
                f"invalid heat layer at index {i}: expected {{name, resolution, min, max, cells[]}}"
            )
        doc.heat.append(
            HeatLayer(
                id=i + 1,
                name=h["name"],
                resolution=h["resolution"],
                minValue=h["min"],
                maxValue=h["max"],
                encoding="sparse",
                cells=[HeatCell(c["x"], c["y"], c["value"]) for c in h["cells"]],
            )
        )

    return doc


def _empty_document(opts: dict[str, Any], extent: int, buffer: int) -> ScrDocument:
    return ScrDocument(
        version=1,
        envelope=opts.get("envelope") or TileEnvelope(0, 0, 0),
        projection=opts.get("projection") or DEFAULT_PROJECTION,
        extent=extent,
        buffer=buffer,
        meta={"source": opts.get("source") or "geojson"},
        layers={},
        classes={},
        strings=dict(KEY_NAMES),
        attrSets={},
        features=[],
        heat=[],
        omissions=[],
        refs=[],
        routes=[],
    )


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------


def _coords_of(geom: dict | None) -> list[tuple[float, float]]:
    if not geom:
        return []
    out: list[tuple[float, float]] = []
    _walk_coords(geom.get("coordinates"), out)
    return out


def _walk_coords(node: Any, out: list[tuple[float, float]]) -> None:
    if not isinstance(node, list):
        return
    if len(node) >= 2 and isinstance(node[0], (int, float)) and isinstance(node[1], (int, float)):
        out.append((node[0], node[1]))
        return
    for child in node:
        _walk_coords(child, out)


def _quantize(
    geom: dict,
    env: Envelope,
    extent: int,
    projection: str,
) -> GridGeometry | None:
    def to(c: Any) -> GridPoint:
        return lonlat_to_grid(c[1], c[0], env, extent, projection)

    gtype = geom.get("type")
    if gtype == "Point":
        p = to(geom["coordinates"])
        z = geom["coordinates"][2] if len(geom["coordinates"]) > 2 else None
        return PointGeom(point=GridPoint(p.x, p.y, z))
    if gtype == "MultiPoint":
        pts = [to(c) for c in geom["coordinates"]]
        if not pts:
            return None
        return PointGeom(point=pts[0])
    if gtype == "LineString":
        line = [to(c) for c in geom["coordinates"]]
        if len(line) < 2:
            return None
        return LineGeom(lines=[line])
    if gtype == "MultiLineString":
        lines = [line for line in ([to(c) for c in l] for l in geom["coordinates"]) if len(line) >= 2]
        if not lines:
            return None
        return LineGeom(lines=lines)
    if gtype == "Polygon":
        poly = _polygon_of(geom["coordinates"], to)
        if not poly:
            return None
        return PolygonGeom(polygon=poly)
    if gtype == "MultiPolygon":
        poly = [part for p in geom["coordinates"] for part in _polygon_of(p, to)]
        if not poly:
            return None
        return PolygonGeom(polygon=poly)
    raise ScrError(f'unsupported GeoJSON geometry type "{gtype}"')


def _polygon_of(rings: list, to) -> list[GridPolygonPart]:
    parts: list[GridPolygonPart] = []
    for r in rings:
        converted = [to(c) for c in r]
        if len(converted) >= 3:
            parts.append(GridPolygonPart(rings=[converted]))
    return parts


def building_geometry(parts: list[GridPolygonPart]) -> GridGeometry:
    """A footprint with a height is a building; otherwise a plain polygon."""
    return BuildingGeom(polygon=parts)


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------


def _resolve_layer(f: dict, layer_key: str | None) -> str:
    props = f.get("properties") or {}
    if layer_key and isinstance(props.get(layer_key), str):
        return props[layer_key]

    kind = _key_of(f)
    if kind == "line":
        return "road"
    if kind == "point":
        return "poi"
    if kind == "building":
        return "building"
    return "area"


def _resolve_class(f: dict, layer_name: str) -> str:
    props = f.get("properties") or {}

    # An explicit class is authoritative and lets a source override inference.
    for key in ("class", "supercarto_class"):
        if isinstance(props.get(key), str):
            return props[key]

    # A dotted `type` is already a class in the OSM sense: `amenity.cafe`.
    if isinstance(props.get("type"), str) and "." in props["type"]:
        return props["type"]

    highway = _str(props.get("highway"))
    if highway:
        return f"highway.{highway}"

    railway = _str(props.get("railway"))
    if railway:
        return f"railway.{railway}"

    amenity = _str(props.get("amenity"))
    if amenity:
        return f"amenity.{amenity}"

    shop = _str(props.get("shop"))
    if shop:
        return f"shop.{shop}"

    leisure = _str(props.get("leisure"))
    if leisure:
        return f"leisure.{leisure}"

    tourism = _str(props.get("tourism"))
    if tourism:
        return f"tourism.{tourism}"

    if layer_name == "building" or props.get("building"):
        return "building.commercial"

    kind = _key_of(f)
    if kind == "point":
        return "poi"
    if kind == "line":
        return "highway.residential"
    return "area.generic"


def _key_of(f: dict) -> str:
    t = (f.get("geometry") or {}).get("type")
    props = f.get("properties") or {}
    if t in ("Point", "MultiPoint"):
        return "building" if props.get("building") or props.get("building:part") else "point"
    if t in ("LineString", "MultiLineString"):
        return "line"
    return "building" if props.get("building") else "area"


def _str(v: Any) -> str | None:
    return v if isinstance(v, str) and v != "" else None


# ---------------------------------------------------------------------------
# Attributes
# ---------------------------------------------------------------------------


def _build_attr_set(
    props: dict[str, Any],
    alloc: _Allocator,
    attr_ids: dict[str, int],
    out: dict[int, AttributeSet],
    next_id,
) -> int | None:
    list_: list[Prop] = []
    # Deterministic key order keeps the deduplication signature stable, which
    # means identical property sets collapse to one attribute record.
    for key, key_id in sorted(KEPT_KEYS, key=lambda kv: kv[1]):
        raw = props.get(key)
        if raw is None or raw == "":
            continue
        value = _to_attr_value(raw, alloc)
        if value is not None:
            list_.append(Prop(key=key_id, value=value))
    if not list_:
        return None

    signature = ";".join(f"{p.key}={_render_value(p.value)}" for p in list_)
    existing = attr_ids.get(signature)
    if existing is not None:
        return existing

    id_ = next_id()
    attr_ids[signature] = id_
    out[id_] = AttributeSet(id_, list_)
    return id_


def _to_attr_value(raw: Any, alloc: _Allocator):
    if isinstance(raw, bool):
        return AttrBool(raw)
    if isinstance(raw, (int, float)) and math.isfinite(raw):
        return AttrNum(float(raw))
    if isinstance(raw, str):
        # A number stored as a string stays a number: JSON is inconsistent
        # about this and a height of "18" must not become the string "18".
        as_number = js_number(raw)
        if raw.strip() != "" and math.isfinite(as_number):
            return AttrNum(as_number)
        # Tokens that the compiler pattern-matches on stay bare, not interned.
        if raw in BLOCKING_TOKENS or raw in PATH_TOKENS:
            return AttrToken(raw)
        return AttrRef(alloc.intern(raw))
    return None


def _render_value(v) -> str:
    if v.t == "ref":
        return f"s{v.ref}"
    if v.t == "num":
        # ts renderValue uses String(value.num).
        return js_num_str(v.num)
    if v.t == "bool":
        return "true" if v.bool else "false"
    return v.token

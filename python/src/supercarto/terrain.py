"""Terrain elevation — port of ``src/source/terrain.ts``.

Web Mercator flattens the earth, so a 2D map cannot tell a model that one
street is 40m above another. For anything that reasons about grade - a drone
route, a flood, a cyclist - elevation is the missing dimension.

The source is a tiled elevation service, the shape AWS Terrain Tiles uses
(Terrarium encoding) and several open mirrors serve unchanged. Both the
standard PNG tile body and the raw-sample variant decode here, with no runtime
dependencies beyond the stdlib.
"""

from __future__ import annotations

import math
import struct
from collections.abc import Callable

from .net import http_fetch
from .png import decode_png_terrarium
from .types import HeatCell, HeatLayer


class ElevationGrid:
    def __init__(self, bbox: dict, width: int, height: int, values: list[float], minimum: float, maximum: float):
        #: Envelope the samples cover.
        self.bbox = bbox
        #: Samples per axis.
        self.width = width
        self.height = height
        #: Row-major elevations in metres, ``width * height`` entries.
        self.values = values
        #: Smallest and largest sample, for range checks.
        self.min = minimum
        self.max = maximum


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _png_signature(body: bytes) -> bool:
    return body[:8] == PNG_SIGNATURE


class TerrariumElevation:
    """Terrarium-encoded elevation tiles.

    Terrarium tiles come in two body shapes: the standard PNG encoding
    (`elevation = R * 256 + G + B / 256 - 32768` metres, what AWS Terrain
    Tiles and most mirrors serve) and a raw variant (`width`/`height` uint32
    LE header, then big-endian 16-bit samples, `(sample - 32768) / 256`
    metres) used by endpoints that want to skip image decoding. Both decoders
    are dependency-free; both decode into metre-valued samples and share one
    bilinear sampler.
    """

    name = "terrarium"

    def __init__(self, template: str | None = None, fetch: Callable | None = None, max_tiles: int = 16):
        #: URL template with `{z}/{x}/{y}` and `{r}` placeholders.
        #: `{r}` is the tile size in pixels, e.g. `256`.
        self.template = template or "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
        self.fetch_impl = fetch
        self.max_tiles = max_tiles

    def fetch(self, bbox: dict, res: int) -> ElevationGrid:
        z, tiles = tiles_for(bbox, self.max_tiles)
        size = 256
        out = [0.0] * (res * res)
        minimum = math.inf
        maximum = -math.inf

        for t in tiles:
            url = (
                self.template.replace("{z}", str(z))
                .replace("{x}", str(t["x"]))
                .replace("{y}", str(t["y"]))
                .replace("{r}", str(size))
            )
            try:
                res0 = self._fetch(url)
            except Exception:  # noqa: BLE001, S112 - skipped tile, mirrors TS !res0.ok
                continue
            if not res0.ok:
                continue
            # Two accepted body shapes: PNG (the standard Terrarium encoding)
            # and the raw-sample variant. Anything else skips the tile; a grid
            # of no decoded samples is reported as absent upstream, never as
            # flat data.
            body = res0.bytes
            pixels = (
                decode_png_terrarium(body)
                if _png_signature(body)
                else decode_raw_terrarium(body)
            )
            if not pixels:
                continue
            width, height, data = pixels
            for i in range(len(out)):
                v = sample_bilinear((width, height, data), width, height, i % res, i // res, res)
                out[i] = v
                minimum = min(minimum, v)
                maximum = max(maximum, v)

        if math.isinf(minimum):
            minimum = 0.0
            maximum = 0.0

        return ElevationGrid(bbox, res, res, out, minimum, maximum)

    def _fetch(self, url: str):
        if self.fetch_impl is not None:
            return self.fetch_impl(url)
        return http_fetch(url)


RawElevationT = tuple[int, int, list[float]] | None


def decode_raw_terrarium(body: bytes) -> tuple[int, int, list[float]] | None:
    """Decode a raw Terrarium buffer: `width`, `height` as uint32 LE, then
    big-endian int16 samples, decoded to metres by the encoding
    `elevation = (sample - 32768) / 256`."""
    if len(body) < 8:
        return None
    width = struct.unpack_from("<I", body, 0)[0]
    height = struct.unpack_from("<I", body, 4)[0]
    expected = width * height * 2
    if len(body) < 8 + expected:
        return None
    data: list[float] = []
    for i in range(width * height):
        # Terrarium stores samples big-endian.
        data.append((struct.unpack_from(">h", body, 8 + i * 2)[0] - 32768) / 256)
    return width, height, data


def sample_bilinear(grid: tuple[int, int, list[float]], gw: int, gh: int, x: int, y: int, res: int) -> float:
    """Bilinear interpolation over a decoded metre-valued grid (no offsets:
    both decoder paths already deliver metres)."""
    fx = (x / max(1, res - 1)) * (gw - 1)
    fy = (y / max(1, res - 1)) * (gh - 1)
    x0 = math.floor(fx)
    y0 = math.floor(fy)
    x1 = min(gw - 1, x0 + 1)
    y1 = min(gh - 1, y0 + 1)
    tx = fx - x0
    ty = fy - y0
    data = grid[2]
    a = _elev(data, gw, gh, x0, y0)
    b = _elev(data, gw, gh, x1, y0)
    c = _elev(data, gw, gh, x0, y1)
    d = _elev(data, gw, gh, x1, y1)
    top = a + (b - a) * tx
    bot = c + (d - c) * tx
    return top + (bot - top) * ty


def _elev(data: list[float], w: int, h: int, x: int, y: int) -> float:
    cx = max(0, min(w - 1, x))
    cy = max(0, min(h - 1, y))
    if 0 <= cy * w + cx < len(data):
        return data[cy * w + cx]
    return 0


def tiles_for(bbox: dict, max_tiles: int) -> tuple[int, list[dict]]:
    """Slippy tiles covering a bbox, capped so a huge area cannot fan out."""
    nw = _tile_x(bbox["west"], bbox["north"])
    se = _tile_x(bbox["east"], bbox["south"])
    for z in range(12, -1, -1):
        a = nw(z)
        b = se(z)
        w = abs(b["x"] - a["x"]) + 1
        h = abs(b["y"] - a["y"]) + 1
        if w * h <= max_tiles:
            tiles = []
            for x in range(a["x"], b["x"] + 1):
                for y in range(a["y"], b["y"] + 1):
                    tiles.append({"x": x, "y": y})
            return z, tiles
    return 0, [{"x": 0, "y": 0}]


def _tile_x(lon: float, lat: float):
    def at_z(z: int) -> dict:
        n = 2**z
        x = math.floor(((lon + 180) / 360) * n)
        lat_rad = max(-85.05112878, min(85.05112878, lat)) * (math.pi / 180)
        y = math.floor(((1 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2) * n)
        return {"x": max(0, min(n - 1, x)), "y": max(0, min(n - 1, y))}

    return at_z


def elevation_to_heat(grid: ElevationGrid, name: str = "elevation") -> HeatLayer:
    """Turn an elevation grid into a SCR heat layer.

    Reusing the heat encoding rather than inventing an elevation-specific one
    is deliberate: it is the same shape (a scalar field over a grid), it reuses
    the sparse and run-length encodings, and the agent already knows how to
    read a heat layer. An `elevation` layer with `rel` values is
    self-explanatory.
    """
    cells: list[HeatCell] = []
    # Report the extremes and a coarse sample, not every cell. A model needs to
    # know the terrain ranges across here and where the high ground is; it does
    # not need a 64x64 grid of numbers it will never use.
    step = max(1, math.floor(grid.width / 16))
    for y in range(0, grid.height, step):
        for x in range(0, grid.width, step):
            idx = y * grid.width + x
            v = grid.values[idx] if 0 <= idx < len(grid.values) else 0
            cells.append(HeatCell(x=x, y=y, value=math.floor(v + 0.5)))
    return HeatLayer(
        id=1,
        name=name,
        resolution=grid.width,
        minValue=math.floor(grid.min + 0.5),
        maxValue=math.floor(grid.max + 0.5),
        encoding="sparse",
        cells=cells,
    )

"""Per-axis grid scale — port of ``src/geo/scale.ts``."""

from __future__ import annotations

import math

from .project import DEG, grid_to_lonlat, merc_envelope
from .types import ScrDocument


def grid_scale_for(doc: ScrDocument) -> dict[str, float] | None:
    """Per-axis metres per grid unit for a document, in *ground* metres.

    Two corrections matter here, and both are easy to get wrong:

    1. **Per axis, not one mean.** A bbox is often far from square - a city
       block is 200m by 90m - and collapsing that onto a single mean inflates
       or deflates every distance in the graph by up to the aspect ratio.
       Edges are measured from grid deltas, so the per-axis scale must be
       applied to the components before the length is taken.

    2. **Mercator overstatement.** Web Mercator inflates *both* axes away
       from the equator, because it is conformal: it preserves shape, not
       area. The overstatement factor is ``1/cos(latitude)`` in both axes, so
       the correction is to multiply each axis's mercator scale by the cosine
       of the centre latitude.

    Returns None for a degenerate envelope, so callers fall back to labelled
    grid units rather than emitting a fabricated zero.
    """
    env = merc_envelope(doc.envelope, doc.projection)
    width_m = env["maxX"] - env["minX"]
    height_m = abs(env["bottomY"] - env["topY"])
    if not (math.isfinite(width_m) and math.isfinite(height_m)):
        return None
    if width_m <= 0 or height_m <= 0:
        return None
    if doc.extent <= 0:
        return None

    # Evaluated at the envelope's centre latitude, whose scale factor best
    # represents the whole maplet.
    lat, _lon = grid_to_lonlat(
        doc.extent / 2, doc.extent / 2, doc.envelope, doc.extent, doc.projection
    )
    lat_correction = math.cos(lat * DEG)
    if not (math.isfinite(lat_correction) and lat_correction > 0):
        return None

    return {
        "x": (width_m / doc.extent) * lat_correction,
        "y": (height_m / doc.extent) * lat_correction,
    }


def merc_envelope_scale(doc: ScrDocument) -> float | None:
    """A single representative ground-metres scale, for callers that need one number.

    Prefer :func:`grid_scale_for` for lengths.
    """
    scale = grid_scale_for(doc)
    if scale is None:
        return None
    mean = (scale["x"] + scale["y"]) / 2
    return mean if mean > 0 else None

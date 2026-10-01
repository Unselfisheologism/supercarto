import { mercEnvelope, metersPerDegLon, METERS_PER_DEG_LAT } from './project.js';
import type { ScrDocument } from '../wire/types.js';
import { gridToLonLat } from './project.js';

export interface GridScale {
  /** Metres per grid unit along x. */
  x: number;
  /** Metres per grid unit along y. */
  y: number;
}

/**
 * Per-axis metres per grid unit for a document, in *ground* metres.
 *
 * Two corrections matter here, and both are easy to get wrong:
 *
 * 1. **Per axis, not one mean.** A bbox is often far from square - a city block
 *    is 200m by 90m - and collapsing that onto a single mean inflates or
 *    deflates every distance in the graph by up to the aspect ratio. Edges are
 *    measured from grid deltas, so the per-axis scale must be applied to the
 *    components before the length is taken.
 *
 * 2. **Mercator overstatement.** Web Mercator inflates *both* axes away from
 *    the equator, because it is conformal: it preserves shape, not area. A span
 *    of 0.0099 degrees of longitude at San Francisco's latitude measures 1102
 *    mercator metres but only 871m on the ground, and 0.01 degrees of latitude
 *    at the same place is similarly overstated. The overstatement factor is
 *    `1/cos(latitude)` in both axes, so the correction is to multiply each
 *    axis's mercator scale by the cosine of the centre latitude.
 *
 * Returns undefined for a degenerate envelope, so callers fall back to labelled
 * grid units rather than emitting a fabricated zero.
 */
export function gridScaleFor(doc: ScrDocument): GridScale | undefined {
  const env = mercEnvelope(doc.envelope, doc.projection);
  const widthM = env.maxX - env.minX;
  const heightM = Math.abs(env.bottomY - env.topY);
  if (!Number.isFinite(widthM) || !Number.isFinite(heightM)) return undefined;
  if (widthM <= 0 || heightM <= 0) return undefined;
  if (doc.extent <= 0) return undefined;

  // Evaluated at the envelope's centre latitude, whose scale factor best
  // represents the whole maplet.
  const centre = gridToLonLat(
    { x: doc.extent / 2, y: doc.extent / 2 },
    doc.envelope,
    doc.extent,
    doc.projection,
  );
  const latCorrection = Math.cos((centre.lat * Math.PI) / 180);
  if (!Number.isFinite(latCorrection) || latCorrection <= 0) return undefined;

  return {
    x: (widthM / doc.extent) * latCorrection,
    y: (heightM / doc.extent) * latCorrection,
  };
}

/**
 * A single representative ground-metres scale, for callers that genuinely need
 * one number. Prefer {@link gridScaleFor} for lengths.
 */
export function mercEnvelopeFor(doc: ScrDocument): number | undefined {
  const scale = gridScaleFor(doc);
  if (!scale) return undefined;
  const mean = (scale.x + scale.y) / 2;
  return mean > 0 ? mean : undefined;
}

export { metersPerDegLon, METERS_PER_DEG_LAT };

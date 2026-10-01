import type { Envelope, GridPoint, Projection } from '../wire/types.js';

/** Web Mercator clips at ±85.05112878; beyond that the projection diverges. */
export const MERCATOR_MAX_LAT = 85.0511287798066;
const ORIGIN_SHIFT = 2 * Math.PI * 6378137 / 2; // half the Earth's circumference, metres
const DEG = Math.PI / 180;

export interface LonLat {
  lat: number;
  lon: number;
}

/** Web Mercator easting in metres for a longitude. */
export function lonToMercX(lon: number): number {
  return lon * ORIGIN_SHIFT / 180;
}

/** Web Mercator northing in metres for a latitude, clamped to the valid range. */
export function latToMercY(lat: number): number {
  const clamped = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  return Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2)) * 6378137;
}

export function mercXToLon(x: number): number {
  return (x / ORIGIN_SHIFT) * 180;
}

export function mercYToLat(y: number): number {
  return (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) / DEG;
}

// ---------------------------------------------------------------------------
// Tile envelopes
// ---------------------------------------------------------------------------

/** Geographic bounds of a slippy tile at zoom `z`. */
export function tileBounds(z: number, x: number, y: number) {
  const n = 2 ** z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north = mercYToLat(latToMercY(90) - (latToMercY(90) * 2 * y) / n);
  const south = mercYToLat(latToMercY(90) - (latToMercY(90) * 2 * (y + 1)) / n);
  return { west, south, east, north };
}

/** Slippy tile containing a point at zoom `z`. */
export function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const clamped = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  const latRad = clamped * DEG;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { x, y };
}

/**
 * The tile that contains a bbox, at a zoom high enough to cover it. Picks the
 * coarsest zoom whose tile count does not exceed `maxTiles`, which keeps a
 * request for a city from fanning out into thousands of tiles.
 */
export function bboxToTile(
  west: number,
  south: number,
  east: number,
  north: number,
  maxTiles = 1,
): { z: number; x: number; y: number } {
  const target = Math.max(1, maxTiles);
  for (let z = 22; z >= 0; z--) {
    const a = lonLatToTile(west, north, z);
    const b = lonLatToTile(east, south, z);
    const w = Math.abs(b.x - a.x) + 1;
    const h = Math.abs(b.y - a.y) + 1;
    if (w * h <= target) return { z, x: a.x, y: a.y };
  }
  return { z: 0, x: 0, y: 0 };
}

// ---------------------------------------------------------------------------
// Grid <-> lon/lat
// ---------------------------------------------------------------------------

/**
 * Bounds of a grid-quantized envelope in mercator metres.
 *
 * `topY` is always greater than `bottomY`, because mercator northing increases
 * northward. Note the grid's own y axis points *south*, so interpolation runs
 * from `topY` down to `bottomY` as grid y increases. Getting this pairing
 * backwards silently produces negative scales.
 */
export function mercEnvelope(env: Envelope, _projection: Projection = 'webmerc') {
  if (env.type === 'tile') {
    const { west, south, east, north } = tileBounds(env.z, env.x, env.y);
    return {
      minX: lonToMercX(west),
      maxX: lonToMercX(east),
      topY: latToMercY(north),
      bottomY: latToMercY(south),
    };
  }
  return {
    minX: lonToMercX(env.west),
    maxX: lonToMercX(env.east),
    topY: latToMercY(env.north),
    bottomY: latToMercY(env.south),
  };
}

/**
 * Convert a grid coordinate to lon/lat.
 *
 * Longitude interpolates linearly; latitude interpolates in Mercator space,
 * not in degrees. Linear-in-degrees latitude is the classic slippy-map bug and
 * shows up as a consistent north-south bias that grows with tile height.
 */
export function gridToLonLat(
  p: GridPoint,
  env: Envelope,
  extent: number,
  projection: Projection = 'webmerc',
): LonLat {
  const { minX, maxX, topY, bottomY } = mercEnvelope(env, projection);
  const fx = p.x / extent;
  // Grid y increases southward, so the fraction runs from topY down to bottomY.
  const fy = p.y / extent;
  const mercX = minX + fx * (maxX - minX);
  const mercY = topY + fy * (bottomY - topY);
  return { lat: mercYToLat(mercY), lon: mercXToLon(mercX) };
}

/** Convert lon/lat to a grid coordinate, rounding to integers. */
export function lonLatToGrid(
  { lat, lon }: LonLat,
  env: Envelope,
  extent: number,
  projection: Projection = 'webmerc',
): GridPoint {
  const { minX, maxX, topY, bottomY } = mercEnvelope(env, projection);
  const fx = (lonToMercX(lon) - minX) / (maxX - minX);
  const fy = (latToMercY(lat) - topY) / (bottomY - topY);
  return { x: Math.round(fx * extent), y: Math.round(fy * extent) };
}

/** Metres per grid unit at a given latitude, for the mercator scale distortion. */
export function metersPerGridUnit(
  env: Envelope,
  extent: number,
  _atLat?: number,
): number {
  const { topY, bottomY } = mercEnvelope(env, 'webmerc');
  return Math.abs(bottomY - topY) / extent;
}

// ---------------------------------------------------------------------------
// Local planar helpers
// ---------------------------------------------------------------------------

/**
 * Metres per degree of longitude at a latitude. Used for edge distances, which
 * is where a planar approximation is accurate enough to be useful and cheap.
 */
export function metersPerDegLon(lat: number): number {
  return 111320 * Math.cos(lat * DEG);
}

export const METERS_PER_DEG_LAT = 110574;

/** Great-circle distance in metres. */
export function haversine(a: LonLat, b: LonLat): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Planar distance between two grid points, scaled to metres at a reference latitude. */
export function gridDistance(
  a: GridPoint,
  b: GridPoint,
  env: Envelope,
  extent: number,
  _atLat?: number,
): number {
  const { minX, maxX, topY, bottomY } = mercEnvelope(env, 'webmerc');
  const widthM = maxX - minX;
  const heightM = Math.abs(bottomY - topY);
  const dx = ((b.x - a.x) / extent) * widthM;
  const dy = ((b.y - a.y) / extent) * heightM;
  return Math.hypot(dx, dy);
}

export function degToRad(d: number): number {
  return d * DEG;
}

export function radToDeg(r: number): number {
  return r / DEG;
}

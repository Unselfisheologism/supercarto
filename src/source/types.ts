/**
 * The source abstraction.
 *
 * Everything upstream of ingestion - Overpass, Protomaps, a local file, a
 * fixture - implements this. The pipeline asks a source for "everything you
 * know inside this circle" and gets GeoJSON back, so the rest of the library is
 * unaware of where data came from.
 */

import type { GeoJsonFeature } from '../ingest/geojson.js';

export interface BboxQuery {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface FetchQuery extends BboxQuery {
  /** Human-readable radius, echoed into the map metadata. */
  radiusLabel?: string;
  /** Semantic zoom hint. Sources use it to pick a detail level. */
  zoom?: number;
}

export interface SourceRequest {
  bbox: BboxQuery;
  /** Semantic groups to request. Empty means "whatever this source has". */
  layers: string[];
  /**
   * Largest number of features to return. Sources apply it while streaming so
   * a dense city does not have to be fully materialized first.
   */
  maxFeatures: number;
  /** Abort signal, so a server can cancel an upstream fetch. */
  signal?: AbortSignal;
}

export interface SourceResult {
  features: GeoJsonFeature[];
  /** Provenance, copied into the document's `META` records. */
  source: string;
  /**
   * True when the source itself hit `maxFeatures` and stopped early, as opposed
   * to having nothing more to give. The distinction matters: one means the area
   * is exhausted, the other means the answer is incomplete, and the budgeter
   * reports them differently.
   */
  truncated: boolean;
  /** Wall-clock fetch time, for metrics. */
  elapsedMs: number;
  /** Source-specific warnings, surfaced rather than swallowed. */
  warnings: string[];
}

export interface MapSource {
  /** Stable identifier, used in `META source`. */
  readonly name: string;
  /** Human-readable description, for diagnostics. */
  readonly description: string;
  /** True when the source can serve this request without configuration. */
  available(): Promise<boolean>;
  fetch(request: SourceRequest): Promise<SourceResult>;
}

/** Bounding box of a circle, used to turn a radius query into a bbox query. */
export function bboxAround(
  lat: number,
  lon: number,
  radiusM: number,
): BboxQuery {
  // Longitude degrees shrink with latitude; latitude degrees do not. Getting
  // this wrong produces a box that is far too narrow east-west at high
  // latitudes, which silently drops everything outside a thin strip.
  const dLat = radiusM / 110574;
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  return {
    west: lon - dLon,
    south: lat - dLat,
    east: lon + dLon,
    north: lat + dLat,
  };
}

/** Clamp a bbox to valid WGS84, and handle the antimeridian. */
export function normalizeBbox(b: BboxQuery): BboxQuery {
  const west = Math.max(-180, Math.min(180, b.west));
  const east = Math.max(-180, Math.min(180, b.east));
  return {
    west: Math.min(west, east),
    south: Math.max(-85.05112878, Math.min(85.05112878, b.south)),
    east: Math.max(west, east),
    north: Math.max(-85.05112878, Math.min(85.05112878, b.north)),
  };
}

/** Approximate ground area of a bbox in square metres. */
export function bboxAreaSqm(b: BboxQuery): number {
  const midLat = (b.north + b.south) / 2;
  const widthM = (b.east - b.west) * 111320 * Math.cos((midLat * Math.PI) / 180);
  const heightM = (b.north - b.south) * 110574;
  return Math.abs(widthM * heightM);
}
/**
 * Build a synthetic, non-memorisable benchmark area.
 *
 * Every existing fixture sits at a real, well-known place, which makes the `none`
 * arm useless as a floor: a model asked about downtown San Francisco answers from
 * memory, scoring above the arm that was actually given the map. Measured, in
 * bench-results/.
 *
 * Two changes make memorisation impossible rather than merely unlikely:
 *
 *  1. **Coordinates match nowhere real.** Open North Pacific, 1500km from the
 *     nearest coast. No model has memorised this place because it is not a place.
 *  2. **Every name is synthetic.** `Cafe 0`, `Shop 1`. Real geometry, invented
 *     semantics, so there is nothing in training data to recall.
 *
 * The geometry is still realistic - a street grid with jitter, buildings, and a
 * dense scatter of low-priority point features - because the point is to measure
 * budget behaviour under a plausible load, not to test the generator.
 *
 * Those dense point features are the point of the `omission` task kind: under a
 * tight budget the budgeter drops them and emits an omission record, and the
 * question becomes whether the model says "present but omitted" or "absent".
 *
 *   npx tsx scripts/make-synthetic-area.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GeoJsonFeatureCollection, GeoJsonFeature } from '../src/index.js';

/** Open North Pacific. Nothing here, ever. */
export const SYNTHETIC_CENTER = { lat: 44.0, lon: -150.0 };
export const SYNTHETIC_ID = 'synthetic-pacific';

const M_PER_DEG_LAT = 110_574;

/** Jittered so the grid is not perfectly regular, like a real street layout. */
function jitter(seed: number): number {
  // Deterministic: the fixture must be byte-identical on regeneration, or a
  // re-score cannot tell a code change from a data change.
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2;
}

function offset(lat: number, dLatM: number, dLonM: number): [number, number] {
  return [
    +(lat + dLonM / (111_320 * Math.cos((lat * Math.PI) / 180))).toFixed(7),
    +(lat + dLatM / M_PER_DEG_LAT).toFixed(7),
  ] as [number, number];
}

export interface SyntheticOptions {
  /** Streets in each direction. */
  streets?: number;
  /** Low-priority point features that budget fitting will drop. */
  clutter?: number;
  /** Named places that must survive. */
  named?: number;
  radiusM?: number;
}

export function syntheticArea(opts: SyntheticOptions = {}): GeoJsonFeatureCollection {
  const streets = opts.streets ?? 11;
  const clutter = opts.clutter ?? 4500;
  const named = opts.named ?? 8;
  const radius = opts.radiusM ?? 400;
  const { lat } = SYNTHETIC_CENTER;
  const features: GeoJsonFeature[] = [];

  const step = (radius * 2) / streets;

  // Street grid.
  for (let i = 0; i < streets; i++) {
    const off = -radius + step * i;
    const wobble = jitter(i * 7) * step * 0.15;

    features.push({
      type: 'Feature',
      properties: { highway: 'residential', name: `Street ${i}` },
      geometry: {
        type: 'LineString',
        coordinates: [
          offset(lat, off, -radius + wobble),
          offset(lat, off, 0),
          offset(lat, off + wobble, radius),
        ],
      },
    });

    features.push({
      type: 'Feature',
      properties: { highway: 'residential', name: `Avenue ${i}` },
      geometry: {
        type: 'LineString',
        coordinates: [
          offset(lat, -radius, off + wobble),
          offset(lat, 0, off),
          offset(lat, radius, off + wobble),
        ],
      },
    });
  }

  // Buildings, to give the compiler real polygons to reject and keep.
  for (let b = 0; b < 40; b++) {
    const bLat = -radius + jitter(b * 31) * radius;
    const bLon = -radius + jitter(b * 37) * radius;
    const w = 8 + Math.abs(jitter(b * 41)) * 12;
    features.push({
      type: 'Feature',
      properties: { building: 'yes' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            offset(lat, bLat, bLon),
            offset(lat, bLat + w, bLon),
            offset(lat, bLat + w, bLon + w),
            offset(lat, bLat, bLon + w),
            offset(lat, bLat, bLon),
          ],
        ],
      },
    });
  }

  /**
   * Named places. These are the ones an agent must be able to report, so the
   * budgeter reserves capacity for them - which is exactly why the clutter below
   * gets dropped and the omission record appears.
   */
  for (let p = 0; p < named; p++) {
    const pLat = -radius * 0.6 + (p / named) * radius * 1.2;
    const pLon = -radius * 0.6 + jitter(p * 53) * radius * 0.8;
    features.push({
      type: 'Feature',
      properties: {
        amenity: p % 3 === 0 ? 'cafe' : 'shop',
        name: `Cafe ${p}`,
      },
      geometry: { type: 'Point', coordinates: offset(lat, pLat, pLon) },
    });
  }

  /**
   * The clutter. Layer-forced to `tree` so the omission record names it, and
   * named so an agent could in principle report them - the question is whether it
   * can tell "omitted" from "not there".
   */
  for (let c = 0; c < clutter; c++) {
    const cLat = -radius + jitter(c * 97) * radius;
    const cLon = -radius + jitter(c * 101) * radius;
    features.push({
      type: 'Feature',
      properties: { natural: 'tree', name: `Tree ${c}`, layer: 'tree' },
      geometry: { type: 'Point', coordinates: offset(lat, cLat, cLon) },
    });
  }

  return { type: 'FeatureCollection', features };
}

// Written when run directly, so the fixture can be regenerated and diffed.
if (process.argv[1]?.endsWith('make-synthetic-area.ts')) {
  const fc = syntheticArea();
  const dir = join(process.cwd(), 'fixtures', 'bench');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${SYNTHETIC_ID}.geojson`);
  writeFileSync(path, JSON.stringify(fc), 'utf8');

  const named = fc.features.filter(
    (f) => typeof (f.properties as Record<string, unknown>)?.name === 'string',
  ).length;
  console.log(`wrote ${path}`);
  console.log(`  ${fc.features.length} features, ${named} named`);
  console.log(`  centre ${SYNTHETIC_CENTER.lat}, ${SYNTHETIC_CENTER.lon} (open Pacific)`);
}
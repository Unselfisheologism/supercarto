/**
 * Generate a synthetic but realistic dense city extract, for benchmarking and
 * for the README. Not a real place: the coordinates are a jittered grid.
 *
 * This exists because the honest test of a token-efficiency claim is a dense
 * extract, where geometry dominates. A hand-written 13-feature fixture is
 * almost entirely names, and names are cheap in every format.
 */
import { writeFileSync } from 'node:fs';

const CENTER_LON = -122.4194;
const CENTER_LAT = 37.7749;
const SPAN = 0.02; // ~2km across
const BLOCKS = 22; // 22 x 22 blocks
const STEP = SPAN / BLOCKS;

let id = 1;
const features: unknown[] = [];

/** Small deterministic PRNG so the fixture is reproducible. */
let seed = 42;
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

const lon = (i: number) => CENTER_LON + (i - BLOCKS / 2) * STEP;
const lat = (j: number) => CENTER_LAT + (j - BLOCKS / 2) * STEP;

// Horizontal and vertical streets, each subdivided into block segments so the
// compiler has real vertices to weld and contract.
const STREETS = ['Mission', '5th', 'Oak', 'Folsom', 'Harrison', 'Bryant', 'Natoma', 'Townsend'];

for (let j = 0; j <= BLOCKS; j++) {
  const name = STREETS[j % STREETS.length]!;
  features.push({
    type: 'Feature',
    id: id++,
    properties: { highway: j % 4 === 0 ? 'primary' : 'secondary', name: `${name} St`, layer: 'road' },
    geometry: {
      type: 'LineString',
      coordinates: Array.from({ length: BLOCKS + 1 }, (_, i) => [lon(i), lat(j)]),
    },
  });
}

for (let i = 0; i <= BLOCKS; i++) {
  const name = ['5th', '6th', '7th', '8th', '9th'][i % 5]!;
  features.push({
    type: 'Feature',
    id: id++,
    properties: { highway: i % 5 === 0 ? 'primary' : 'secondary', name: `${name} St`, layer: 'road' },
    geometry: {
      type: 'LineString',
      coordinates: Array.from({ length: BLOCKS + 1 }, (_, j) => [lon(i), lat(j)]),
    },
  });
}

// Buildings inside each block.
for (let i = 0; i < BLOCKS; i++) {
  for (let j = 0; j < BLOCKS; j++) {
    if (rand() > 0.55) continue;
    const pad = STEP * 0.12;
    const x0 = lon(i) + pad;
    const y0 = lat(j) + pad;
    const x1 = lon(i + 1) - pad;
    const y1 = lat(j + 1) - pad;
    features.push({
      type: 'Feature',
      id: id++,
      properties: {
        building: 'yes',
        height: Math.round(8 + rand() * 90),
        ...(rand() > 0.7 ? { name: `Building ${i}-${j}` } : {}),
        layer: 'building',
      },
      geometry: {
        type: 'Polygon',
        coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
      },
    });
  }
}

// Points of interest.
const AMENITIES = ['cafe', 'restaurant', 'bar', 'pharmacy', 'bank', 'bench'];
for (let i = 0; i < 160; i++) {
  const amenity = AMENITIES[Math.floor(rand() * AMENITIES.length)]!;
  features.push({
    type: 'Feature',
    id: id++,
    properties: {
      amenity,
      name: `${amenity[0]!.toUpperCase()}${amenity.slice(1)} ${i}`,
      opening_hours: '08:00-20:00',
    },
    geometry: {
      type: 'Point',
      coordinates: [lon(rand() * BLOCKS), lat(rand() * BLOCKS)],
    },
  });
}

// Transit.
for (let i = 0; i < 8; i++) {
  features.push({
    type: 'Feature',
    id: id++,
    properties: { railway: 'subway_entrance', name: `Station ${i}` },
    geometry: { type: 'Point', coordinates: [lon(rand() * BLOCKS), lat(rand() * BLOCKS)] },
  });
}

// One blocked segment, so the obstacle path is exercised.
features.push({
  type: 'Feature',
  id: id++,
  properties: { highway: 'construction', layer: 'road' },
  geometry: {
    type: 'LineString',
    coordinates: [[lon(4), lat(6)], [lon(8), lat(6)]],
  },
});

const collection = { type: 'FeatureCollection', features };
writeFileSync('examples/synthetic-dense.geojson', JSON.stringify(collection, null, 1));
process.stdout.write(`wrote examples/synthetic-dense.geojson (${features.length} features)\n`);

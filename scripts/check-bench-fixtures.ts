/**
 * Validate captured fixtures before a run trusts them.
 *
 * A fixture is only useful if it holds the right place and has the features the
 * tasks score against. Two real defects were found this way: Overpass rejects
 * every southern-hemisphere bbox, and one area returned elements at a latitude
 * 22 degrees from the one requested. Neither would have been visible in a
 * summary count.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { toMaplet, type GeoJsonFeatureCollection } from '../src/index.js';

const DIR = 'fixtures/bench';

/** Must match TASK_AREAS. */
const AREAS: Record<string, { lat: number; lon: number; radiusM: number }> = {
  'sf-cbd': { lat: 37.7936, lon: -122.3958, radiusM: 400 },
  oslo: { lat: 59.9111, lon: 10.7529, radiusM: 400 },
  singapore: { lat: 1.2838, lon: 103.8591, radiusM: 500 },
  'tokyo-shimbashi': { lat: 35.6833, lon: 139.762, radiusM: 400 },
  sydney: { lat: -33.8688, lon: 151.2093, radiusM: 400 },
  reykjavik: { lat: 64.1466, lon: -21.9426, radiusM: 500 },
  'rural-montana': { lat: 46.4, lon: -110.7, radiusM: 2000 },
  'kuala-lumpur': { lat: 3.139, lon: 101.6869, radiusM: 400 },
};

function coordsOf(f: GeoJsonFeatureCollection['features'][number]): [number, number][] {
  const g = f.geometry;
  if (!g) return [];
  if (g.type === 'Point') return [g.coordinates as [number, number]];
  if (g.type === 'LineString') return g.coordinates as [number, number][];
  if (g.type === 'MultiLineString') return (g.coordinates as [number, number][][]).flat();
  if (g.type === 'MultiPolygon') return (g.coordinates as number[][][][]).flat(2) as [number, number][];
  if (g.type === 'Polygon') return (g.coordinates as number[][][]).flat() as [number, number][];
  return [];
}

let failures = 0;
const rows: string[] = [];

for (const [id, want] of Object.entries(AREAS)) {
  const path = join(DIR, `${id}.geojson`);
  if (!existsSync(path)) {
    rows.push(`${id.padEnd(16)} MISSING`);
    failures++;
    continue;
  }
  const fc = JSON.parse(readFileSync(path, 'utf8')) as GeoJsonFeatureCollection;
  const problems: string[] = [];

  if (fc.features.length === 0) {
    problems.push('no features');
  }

  const all = fc.features.flatMap(coordsOf);
  // Reduced by loop rather than Math.min(...xs): a spread over 20,000 features
  // exceeds the argument limit, which is a stack overflow rather than a result.
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const c of all) {
    if (c[1]! < minLat) minLat = c[1]!;
    if (c[1]! > maxLat) maxLat = c[1]!;
    if (c[0]! < minLon) minLon = c[0]!;
    if (c[0]! > maxLon) maxLon = c[0]!;
  }
  const midLat = all.length ? (minLat + maxLat) / 2 : NaN;
  const midLon = all.length ? (minLon + maxLon) / 2 : NaN;

  // The defect this catches: data from the right longitude band but the wrong
  // latitude entirely, which still looks like a plausible capture.
  const offByKm =
    Math.abs(midLat - want.lat) * 111 +
    Math.abs(midLon - want.lon) * 111 * Math.cos((want.lat * Math.PI) / 180);
  if (offByKm > 25) problems.push(`centroid ${offByKm.toFixed(0)}km from requested centre`);

  const named = fc.features.filter(
    (f) => typeof (f.properties as Record<string, unknown> | null)?.name === 'string',
  ).length;
  if (named === 0) problems.push('no named features (nearest-poi would be unscoreable)');

  // Compiling proves the fixture survives the real pipeline and says what the
  // model would actually be shown.
  let nodes = 0;
  let edges = 0;
  let yamlChars = 0;
  try {
    const dLat = want.radiusM / 110_574;
    const dLon = want.radiusM / (111_320 * Math.cos((want.lat * Math.PI) / 180));
    const m = toMaplet(fc, {
      bbox: {
        west: want.lon - dLon,
        south: want.lat - dLat,
        east: want.lon + dLon,
        north: want.lat + dLat,
      },
      budget: 1024,
      radiusLabel: `${want.radiusM}m`,
      capabilities: { elevation: false, weather: false, traffic: false },
    });
    nodes = m.graph.nodes.length;
    edges = m.graph.edges.length;
    yamlChars = m.yaml.length;
    if (nodes === 0) problems.push('compiled to zero nodes');
  } catch (e) {
    problems.push(`compile threw: ${e instanceof Error ? e.message.slice(0, 60) : String(e)}`);
  }

  const status = problems.length === 0 ? 'ok' : 'FAIL';
  if (problems.length) failures++;
  rows.push(
    `${id.padEnd(16)} ${status.padEnd(5)} ${String(fc.features.length).padStart(6)} feat  ` +
      `${String(named).padStart(5)} named  ${String(nodes).padStart(5)} nodes  ` +
      `${String(edges).padStart(5)} edges  ${String(yamlChars).padStart(6)}B yaml` +
      (problems.length ? `\n                 ${problems.join('; ')}` : ''),
  );
}

console.log(rows.join('\n'));
console.log(
  `\n${Object.keys(AREAS).length - failures}/${Object.keys(AREAS).length} areas usable`,
);
if (failures) process.exitCode = 1;
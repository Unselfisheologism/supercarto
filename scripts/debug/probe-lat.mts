// Decisive lat-mirror probe: fetch real SF-area features from the real
// build.protomaps.com archive and print the latitudes that survive.
import { ProtomapsSource } from '../../src/source/protomaps.js';

const BBOX = { west: -122.4268, south: 37.7702, east: -122.4014, north: 37.7799 };
const src = new ProtomapsSource({
  url: 'https://build.protomaps.com/20261022.pmtiles',
  maxZoom: 12,
  maxTiles: 4,
});
const res = await src.fetch({ bbox: BBOX, layers: [], maxFeatures: 60 });

const lats: number[] = [];
const lons: number[] = [];
const coordsOf = (c: unknown): void => {
  if (Array.isArray(c) && typeof c[0] === 'number') {
    lons.push(c[0] as number);
    lats.push(c[1] as number);
  } else if (Array.isArray(c)) for (const s of c) coordsOf(s);
};
for (const f of res.features) coordsOf(f.geometry?.coordinates);

const latMin = Math.min(...lats);
const latMax = Math.max(...lats);
console.log(`features ${res.features.length}, lat ${latMin.toFixed(4)}..${latMax.toFixed(4)}, lon ${Math.min(...lons).toFixed(4)}..${Math.max(...lons).toFixed(4)}`);
console.log(`bbox lat 37.7702..37.7799 -> ${latMax > 0 && latMin > 0 ? 'NO MIRROR' : 'MIRRORED?'}`);

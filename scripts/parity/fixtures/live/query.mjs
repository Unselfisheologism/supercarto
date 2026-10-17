// One-off: generate the exact Overpass QL the reference source would send
// for the fixture bbox, so the captured response is the real answer to the
// real request.
import { buildQuery } from '../../../../src/source/overpass.ts';
const req = {
  bbox: { south: 37.75912, west: -122.41503, north: 37.76069, east: -122.41346 },
  layers: ['highway','building','amenity','railway','shop','tourism','office','leisure','natural','waterway'],
  maxFeatures: 50000,
};
console.log(buildQuery(req));

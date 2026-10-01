import {
  DEFAULT_EXTENT,
  DEFAULT_PROJECTION,
  type AttributeSet,
  type ClassDef,
  type Envelope,
  type Feature,
  type GridGeometry,
  type Layer,
  type Prop,
  type Projection,
  type ScrDocument,
} from '../wire/types.js';
import { decodePolygon } from '../wire/geometry.js';
import { lonLatToGrid, tileBounds } from '../geo/project.js';
import { ScrError } from '../wire/errors.js';

/**
 * GeoJSON ingestion.
 *
 * The adapter every source funnels through. OSM, Overture, PMTiles, and a
 * hand-written fixture all arrive as GeoJSON first, so the compiler only ever
 * sees one shape.
 */

export interface GeoJsonGeometry {
  type: string;
  coordinates?: unknown;
  geometries?: GeoJsonGeometry[];
}

export interface GeoJsonFeature {
  type: 'Feature';
  geometry: GeoJsonGeometry | null;
  properties: Record<string, unknown> | null;
  id?: string | number;
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
}

export interface IngestOptions {
  /** Slippy tile envelope. Derived from the data when omitted. */
  readonly envelope?: Envelope;
  /** Integer grid resolution. Default 4096. */
  readonly extent?: number;
  /** Coordinate buffer in grid units. Default 64. */
  readonly buffer?: number;
  readonly projection?: Projection;
  readonly source?: string;
  /** Cap on ingested features, as a guard against a hostile or runaway file. */
  readonly maxFeatures?: number;
  /**
   * OSM tag key that names the layer, e.g. `layer` from a synthetic export.
   * When absent, layers are inferred from geometry type.
   */
  readonly layerKey?: string;
}

/** Fixed key ids, so the compiler can recognise them without a lookup. */
export const KEY_IDS = {
  name: 10,
  type: 11,
  height_m: 12,
  amenity: 13,
  brand: 14,
  opening_hours: 15,
  highway: 16,
  railway: 17,
  crossing: 18,
  indoor: 19,
  layer: 20,
  level: 22,
  wheelchair: 21,
  door: 23,
} as const;

const KEY_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(KEY_IDS).map(([k, v]) => [v as number, k]),
);

/** Property keys that become attributes. Everything else is dropped: an agent
 *  does not need the OSM `created_by` or `source` fields, and every key costs
 *  tokens on every feature that carries it. */
const KEPT_KEYS = new Map<string, number>([
  ['name', KEY_IDS.name],
  ['height', KEY_IDS.height_m],
  ['height_m', KEY_IDS.height_m],
  ['building:levels', KEY_IDS.height_m],
  ['amenity', KEY_IDS.amenity],
  ['brand', KEY_IDS.brand],
  ['opening_hours', KEY_IDS.opening_hours],
  ['highway', KEY_IDS.highway],
  ['railway', KEY_IDS.railway],
  ['crossing', KEY_IDS.crossing],
  ['indoor', KEY_IDS.indoor],
  ['wheelchair', KEY_IDS.wheelchair],
  // Storey tags. Both spellings are carried because OSM uses `level` for the
  // storey and `layer` for repeat-count styling on bridges and tunnels, and an
  // indoor extractor that reads only one of them silently misses half the
  // buildings. `level` is checked first at compile time.
  ['level', KEY_IDS.level],
  ['layer', KEY_IDS.layer],
  ['door', KEY_IDS.door],
]);

/** First string id allocated to a value. Keys live below 100 by convention. */
const FIRST_VALUE_ID = 100;

interface Allocator {
  strings: Map<number, string>;
  nextId: number;
}

function newAllocator(): Allocator {
  const strings = new Map<number, string>();
  for (const [id, name] of Object.entries(KEY_NAMES)) strings.set(Number(id), name);
  return { strings, nextId: FIRST_VALUE_ID };
}

function intern(alloc: Allocator, text: string): number {
  for (const [id, s] of alloc.strings) {
    if (s === text) return id;
  }
  const id = alloc.nextId++;
  alloc.strings.set(id, text);
  return id;
}

/** Convert GeoJSON into an SCR document. */
export function fromGeoJson(
  input: GeoJsonFeatureCollection | GeoJsonFeature[],
  opts: IngestOptions = {},
): ScrDocument {
  const features: GeoJsonFeature[] = Array.isArray(input) ? input : input.features;
  const maxFeatures = opts.maxFeatures ?? 200_000;
  const extent = opts.extent ?? DEFAULT_EXTENT;
  const buffer = opts.buffer ?? 64;

  // Pass 1: find the data extent so we can build an envelope.
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const f of features) {
    for (const c of coordsOf(f.geometry)) {
      if (c[0] < west) west = c[0];
      if (c[1] < south) south = c[1];
      if (c[0] > east) east = c[0];
      if (c[1] > north) north = c[1];
    }
  }
  if (!Number.isFinite(west)) {
    // An empty collection still needs a valid envelope, so use a null island
    // one-tile box rather than emitting NaN.
    return emptyDocument(opts, extent, buffer);
  }

  // A single axis can be degenerate: a perfectly horizontal street has zero
  // height, and a vertical one zero width. `lonLatToGrid` divides by the span,
  // so a zero span yields NaN coordinates that silently poison every
  // downstream distance. Widen any degenerate axis to a small real extent.
  const MIN_SPAN = 1e-7;
  if (east - west < MIN_SPAN) {
    const mid = (east + west) / 2;
    west = mid - MIN_SPAN / 2;
    east = mid + MIN_SPAN / 2;
  }
  if (north - south < MIN_SPAN) {
    const mid = (north + south) / 2;
    south = mid - MIN_SPAN / 2;
    north = mid + MIN_SPAN / 2;
  }

  const envelope = opts.envelope ?? {
    type: 'bbox',
    west,
    south,
    east,
    north,
  };

  const doc: ScrDocument = {
    version: 1,
    envelope,
    projection: opts.projection ?? DEFAULT_PROJECTION,
    extent,
    buffer,
    meta: { source: opts.source ?? 'geojson' },
    layers: new Map(),
    classes: new Map(),
    strings: new Map(),
    attrSets: new Map(),
    features: [],
    heat: [],
    omissions: [],
    refs: [],
    routes: [],
  };

  const alloc = newAllocator();
  for (const [id, name] of alloc.strings) doc.strings.set(id, name);

  // Pass 2: classify, quantize, and intern.
  const layerIds = new Map<string, number>();
  const classIds = new Map<string, number>();
  const attrIds = new Map<string, number>();
  let nextLayer = 1;
  let nextClass = 1;
  let nextAttr = 1;
  let featureId = 1;

  for (const f of features) {
    if (doc.features.length >= maxFeatures) {
      throw new ScrError(`feature count exceeds maxFeatures (${maxFeatures})`);
    }
    if (!f.geometry) continue;

    const layerName = resolveLayer(f, opts.layerKey);
    const className = resolveClass(f, layerName);
    const layerId = layerIds.get(layerName) ?? nextLayer;
    if (!layerIds.has(layerName)) {
      layerIds.set(layerName, layerId);
      doc.layers.set(layerId, { id: layerId, name: layerName } satisfies Layer);
      nextLayer++;
    }
    const classId = classIds.get(className) ?? nextClass;
    if (!classIds.has(className)) {
      classIds.set(className, classId);
      doc.classes.set(classId, { id: classId, layerId, name: className } satisfies ClassDef);
      nextClass++;
    }

    const geometry = quantize(f.geometry, envelope, extent, opts.projection ?? DEFAULT_PROJECTION);
    if (geometry === undefined) continue;

    const attrSet = buildAttrSet(f.properties ?? {}, alloc, attrIds, doc.attrSets, () => {
      return nextAttr++;
    });

    // Prefer the source's own id so `expand_feature(id)` can address the same
    // feature upstream. `0` is a legitimate id, so test for presence explicitly.
    const sourceId = f.id !== undefined ? Number(f.id) : Number.NaN;
    const feature: Feature = {
      id: Number.isFinite(sourceId) ? sourceId : featureId,
      layerId,
      classId,
      kind: geometry.kind,
      attrSet: attrSet ?? 0,
      geometry,
    };
    doc.features.push(feature);
    featureId++;
  }

  for (const [id, s] of alloc.strings) doc.strings.set(id, s);

  return doc;
}

function emptyDocument(opts: IngestOptions, extent: number, buffer: number): ScrDocument {
  return {
    version: 1,
    envelope: opts.envelope ?? { type: 'tile', z: 0, x: 0, y: 0 },
    projection: opts.projection ?? DEFAULT_PROJECTION,
    extent,
    buffer,
    meta: { source: opts.source ?? 'geojson' },
    layers: new Map(),
    classes: new Map(),
    strings: new Map(),
    attrSets: new Map(),
    features: [],
    heat: [],
    omissions: [],
    refs: [],
    routes: [],
  };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function coordsOf(geom: GeoJsonGeometry | null): [number, number][] {
  if (!geom) return [];
  const out: [number, number][] = [];
  walkCoords(geom.coordinates, out);
  return out;
}

function walkCoords(node: unknown, out: [number, number][]): void {
  if (!Array.isArray(node)) return;
  if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
    out.push([node[0], node[1]]);
    return;
  }
  for (const child of node) walkCoords(child, out);
}

function quantize(
  geom: GeoJsonGeometry,
  env: Envelope,
  extent: number,
  projection: Projection,
): GridGeometry | undefined {
  const to = (c: unknown): { x: number; y: number } => {
    const p = c as number[];
    return lonLatToGrid({ lon: p[0]!, lat: p[1]! }, env, extent, projection);
  };

  switch (geom.type) {
    case 'Point': {
      const p = to(geom.coordinates);
      const z = (geom.coordinates as number[])[2];
      return { kind: 'point', point: z === undefined ? p : { ...p, z } };
    }
    case 'MultiPoint': {
      const pts = (geom.coordinates as number[][]).map(to);
      if (pts.length === 0) return undefined;
      return { kind: 'point', point: pts[0]! };
    }
    case 'LineString': {
      const line = (geom.coordinates as number[][]).map(to);
      if (line.length < 2) return undefined;
      return { kind: 'line', lines: [line] };
    }
    case 'MultiLineString': {
      const lines = (geom.coordinates as number[][][])
        .map((l) => l.map(to))
        .filter((l) => l.length >= 2);
      if (lines.length === 0) return undefined;
      return { kind: 'line', lines };
    }
    case 'Polygon': {
      const poly = polygonOf(geom.coordinates as number[][][], to);
      if (poly.length === 0) return undefined;
      return kindOfPolygon(geom, poly);
    }
    case 'MultiPolygon': {
      const poly = (geom.coordinates as number[][][][])
        .flatMap((p) => polygonOf(p, to));
      if (poly.length === 0) return undefined;
      return kindOfPolygon(geom, poly);
    }
    default:
      throw new ScrError(`unsupported GeoJSON geometry type "${geom.type}"`);
  }
}

function polygonOf(
  rings: number[][][],
  to: (c: unknown) => { x: number; y: number },
) {
  return rings
    .map((r) => r.map(to))
    .filter((r) => r.length >= 3)
    .map((ringsOfPart) => ({ rings: [ringsOfPart] }));
}

/** A footprint with a height is a building; otherwise a plain polygon. */
function kindOfPolygon(
  geom: GeoJsonGeometry,
  poly: ReturnType<typeof polygonOf>,
): GridGeometry {
  void geom;
  return { kind: 'polygon', polygon: poly };
}

export function buildingGeometry(poly: ReturnType<typeof polygonOf>): GridGeometry {
  return { kind: 'building', polygon: poly };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function resolveLayer(f: GeoJsonFeature, layerKey?: string): string {
  const props = f.properties ?? {};
  if (layerKey && typeof props[layerKey] === 'string') return props[layerKey] as string;

  const kind = keyOf(f);
  switch (kind) {
    case 'line':
      return 'road';
    case 'point':
      return 'poi';
    case 'building':
      return 'building';
    default:
      return 'area';
  }
}

function resolveClass(f: GeoJsonFeature, layerName: string): string {
  const props = f.properties ?? {};

  // An explicit class is authoritative and lets a source override inference.
  for (const key of ['class', 'supercarto_class']) {
    if (typeof props[key] === 'string') return props[key] as string;
  }

  // A dotted `type` is already a class in the OSM sense: `amenity.cafe`.
  if (typeof props.type === 'string' && (props.type as string).includes('.')) {
    return props.type as string;
  }

  const highway = str(props.highway);
  if (highway) return `highway.${highway}`;

  const railway = str(props.railway);
  if (railway) return `railway.${railway}`;

  const amenity = str(props.amenity);
  if (amenity) return `amenity.${amenity}`;

  const shop = str(props.shop);
  if (shop) return `shop.${shop}`;

  const leisure = str(props.leisure);
  if (leisure) return `leisure.${leisure}`;

  const tourism = str(props.tourism);
  if (tourism) return `tourism.${tourism}`;

  if (layerName === 'building' || props.building) return 'building.commercial';

  const kind = keyOf(f);
  if (kind === 'point') return 'poi';
  if (kind === 'line') return 'highway.residential';
  return 'area.generic';
}

function keyOf(f: GeoJsonFeature): 'point' | 'line' | 'building' | 'area' {
  const t = f.geometry?.type;
  const props = f.properties ?? {};
  if (t === 'Point' || t === 'MultiPoint') {
    return props.building || props['building:part'] ? 'building' : 'point';
  }
  if (t === 'LineString' || t === 'MultiLineString') return 'line';
  return props.building ? 'building' : 'area';
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

function buildAttrSet(
  props: Record<string, unknown>,
  alloc: Allocator,
  attrIds: Map<string, number>,
  out: Map<number, AttributeSet>,
  nextId: () => number,
): number | undefined {
  const list: Prop[] = [];
  // Deterministic key order keeps the deduplication signature stable, which
  // means identical property sets collapse to one attribute record.
  for (const [key, keyId] of [...KEPT_KEYS.entries()].sort((a, b) => a[1] - b[1])) {
    const raw = props[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = toAttrValue(raw, alloc);
    if (value !== undefined) list.push({ key: keyId, value });
  }
  if (list.length === 0) return undefined;

  const signature = list.map((p) => `${p.key}=${renderValue(p.value)}`).join(';');
  const existing = attrIds.get(signature);
  if (existing !== undefined) return existing;

  const id = nextId();
  attrIds.set(signature, id);
  out.set(id, { id, props: list });
  return id;
}

function toAttrValue(raw: unknown, alloc: Allocator) {
  if (typeof raw === 'number') return { t: 'num' as const, num: raw };
  if (typeof raw === 'boolean') return { t: 'bool' as const, bool: raw };
  if (typeof raw === 'string') {
    // A number stored as a string stays a number: JSON is inconsistent about
    // this and a height of "18" must not become the string "18".
    const asNumber = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(asNumber)) {
      return { t: 'num' as const, num: asNumber };
    }
    // Tokens that the compiler pattern-matches on stay bare, not interned.
    if (BLOCKING_TOKENS.has(raw) || PATH_TOKENS.has(raw)) {
      return { t: 'token' as const, token: raw };
    }
    return { t: 'ref' as const, ref: intern(alloc, raw) };
  }
  return undefined;
}

const BLOCKING_TOKENS = new Set([
  'construction',
  'closed',
  'no',
  'barrier',
  'locked',
  'yes',
  'private',
]);

const PATH_TOKENS = new Set([
  'footway',
  'pedestrian',
  'path',
  'steps',
  'cycleway',
  'corridor',
  'service',
  'track',
  'motorway',
  'trunk',
  'crossing',
  'crosswalk',
  'sidewalk',
]);

function renderValue(v: Prop['value']): string {
  switch (v.t) {
    case 'ref':
      return `s${v.ref}`;
    case 'num':
      return String(v.num);
    case 'bool':
      return v.bool ? 'true' : 'false';
    case 'token':
      return v.token;
  }
}

export { tileBounds, decodePolygon };

/**
 * SCR (SuperCarto 1) document model.
 *
 * This is the decoded, in-memory shape of an SCR document. It is deliberately
 * flat and array-based: a decoder fills it in one forward pass, and the compiler
 * reads it. See `docs/spec.md` for the normative grammar.
 */

/** A point in the quantized integer grid. */
export interface GridPoint {
  x: number;
  y: number;
  /** Metres above the ellipsoid. Only meaningful on point geometry. */
  z?: number;
}

/** A polyline in the quantized grid. `z` is never present. */
export type GridLine = GridPoint[];

/**
 * A polygon in the quantized grid, grouped by part.
 * Each part is an ordered list of rings: ring 0 is the exterior, the rest are
 * holes. Rings are stored open; the codec closes them.
 */
export interface GridPolygonPart {
  rings: GridLine[];
}
export type GridPolygon = GridPolygonPart[];

/** Geometry union, discriminated by `kind`. */
export type GridGeometry =
  | { kind: 'point'; point: GridPoint }
  | { kind: 'line'; lines: GridLine[] }
  | { kind: 'polygon'; polygon: GridPolygon }
  | { kind: 'building'; polygon: GridPolygon };

export type GeomKind = GridGeometry['kind'];

/** `TILE z x y` — Web Mercator slippy tile envelope. */
export interface TileEnvelope {
  type: 'tile';
  z: number;
  x: number;
  y: number;
}

/** `BBOX w s e n` — WGS84 envelope. `west` may exceed `east` at the antimeridian. */
export interface BboxEnvelope {
  type: 'bbox';
  west: number;
  south: number;
  east: number;
  north: number;
}

export type Envelope = TileEnvelope | BboxEnvelope;

export type Projection = 'webmerc' | 'wgs84';

export interface Layer {
  id: number;
  name: string;
}

export interface ClassDef {
  id: number;
  layerId: number;
  name: string;
}

/** A decoded attribute value. `ref` is a string-dictionary id. */
export type AttrValue =
  | { t: 'ref'; ref: number }
  | { t: 'num'; num: number }
  | { t: 'bool'; bool: boolean }
  | { t: 'token'; token: string };

export interface Prop {
  /** String-dictionary id of the key. */
  key: number;
  value: AttrValue;
}

export interface AttributeSet {
  id: number;
  props: Prop[];
}

export interface Feature {
  id: number;
  layerId: number;
  classId: number;
  kind: GeomKind;
  /** 0 means no attributes. */
  attrSet: number;
  geometry: GridGeometry;
}

export type HeatEncoding = 'sparse' | 'rle' | 'cell';

export interface HeatLayer {
  id: number;
  name: string;
  resolution: number;
  minValue: number;
  maxValue: number;
  encoding: HeatEncoding;
  /** `sparse`: non-empty cells in grid coordinates. */
  cells?: { x: number; y: number; value: number }[];
  /** `rle`: run-length rows, keyed by row index. */
  rows?: { y: number; runs: { x: number; len: number; value: number }[] }[];
  /** `cell`: externally indexed cells (H3/S2/etc). */
  indexed?: { cell: string; value: number }[];
}

export interface Omission {
  layerId: number;
  count: number;
  centroid?: GridPoint;
  note?: number;
}

export type RefKind = 'buildings' | 'terrain' | 'mesh' | 'graph' | 'imagery' | 'elevation' | 'route' | 'full';

export interface Ref {
  kind: RefKind | string;
  uri: string;
  mime?: string;
  note?: number;
}

export interface RouteStep {
  /** 1-based step number. */
  n: number;
  instruction: string;
  dist?: number;
  /** String-dictionary id of the road name. */
  ref?: number;
  turn?: string;
}

export interface Route {
  id: number;
  mode: string;
  dist?: number;
  time?: number;
  steps: RouteStep[];
}

/** A fully decoded SCR document. */
export interface ScrDocument {
  version: number;
  envelope: Envelope;
  projection: Projection;
  /** Quantization extent, integer grid resolution across the envelope. */
  extent: number;
  /** Coordinate buffer, so clipped geometry can exceed [0, extent]. */
  buffer: number;
  meta: Record<string, string>;
  layers: Map<number, Layer>;
  classes: Map<number, ClassDef>;
  /** String dictionary, keyed by id. */
  strings: Map<number, string>;
  attrSets: Map<number, AttributeSet>;
  features: Feature[];
  heat: HeatLayer[];
  omissions: Omission[];
  refs: Ref[];
  routes: Route[];
}

export const DEFAULT_EXTENT = 4096;
export const DEFAULT_PROJECTION: Projection = 'webmerc';
export const SCR_MAGIC = 'SCR';

/** Attribute-key string ids below this are conventionally keys, not values. */
export const KEY_STRING_CEILING = 100;

import {
  DEFAULT_EXTENT,
  DEFAULT_PROJECTION,
  SCR_MAGIC,
  type AttrValue,
  type AttributeSet,
  type ClassDef,
  type Envelope,
  type Feature,
  type HeatLayer,
  type Layer,
  type Omission,
  type Prop,
  type Projection,
  type Ref,
  type Route,
  type RouteStep,
  type ScrDocument,
} from './types.js';
import {
  encodeHeatBody,
  encodePathSmart,
  encodePoint,
  encodePolygon,
  encodeProps,
  int,
  num,
} from './geometry.js';
import { ScrError } from './errors.js';

export interface EncodeOptions {
  /**
   * Emit blank lines between record groups. Costs a few bytes, makes a dumped
   * document readable during debugging. Default true.
   */
  readonly group?: boolean;
}

/** Serialize a document to SCR text. */
export function encodeDocument(doc: ScrDocument, opts: EncodeOptions = {}): string {
  const group = opts.group ?? true;
  const out: string[] = [];
  const nl = (s = '') => out.push(s);
  const gap = () => {
    if (group && out.length > 0 && out[out.length - 1] !== '') out.push('');
  };

  nl(`${SCR_MAGIC} ${doc.version}`);
  nl(encodeEnvelope(doc.envelope));
  if (doc.projection !== DEFAULT_PROJECTION) nl(`PROJ ${doc.projection}`);
  nl(`Q ${doc.extent}`);
  if (doc.buffer) nl(`BUF ${doc.buffer}`);

  if (Object.keys(doc.meta).length > 0) {
    gap();
    for (const key of orderedKeys(doc.meta)) nl(`META ${key} ${doc.meta[key]!}`);
  }

  if (doc.layers.size > 0) {
    gap();
    for (const layer of sorted(doc.layers.values())) nl(`L ${layer.id} ${layer.name}`);
  }

  if (doc.classes.size > 0) {
    gap();
    for (const c of sorted(doc.classes.values())) nl(`C ${c.id} ${c.layerId} ${c.name}`);
  }

  if (doc.strings.size > 0) {
    gap();
    for (const [id, text] of sorted(doc.strings.entries())) nl(`S ${id} ${text}`);
  }

  if (doc.attrSets.size > 0) {
    gap();
    for (const a of sorted(doc.attrSets.values())) nl(`A ${a.id} ${encodeProps(a.props)}`);
  }

  if (doc.features.length > 0) {
    gap();
    for (const f of doc.features) nl(encodeFeature(f));
  }

  if (doc.heat.length > 0) {
    gap();
    for (const h of doc.heat) {
      nl(`H ${h.id} ${h.name} ${h.resolution} ${h.minValue} ${h.maxValue}`);
      for (const line of encodeHeatBody(h)) nl(line);
    }
  }

  if (doc.omissions.length > 0) {
    gap();
    for (const o of doc.omissions) nl(encodeOmission(o));
  }

  if (doc.refs.length > 0) {
    gap();
    for (const r of doc.refs) nl(encodeRef(r));
  }

  for (const route of doc.routes) {
    gap();
    nl(encodeRouteHeader(route));
    for (const step of route.steps) nl(encodeStep(step));
  }

  return out.join('\n') + '\n';
}

function encodeEnvelope(env: Envelope): string {
  return env.type === 'tile'
    ? `TILE ${env.z} ${env.x} ${env.y}`
    : `BBOX ${env.west} ${env.south} ${env.east} ${env.north}`;
}

function encodeFeature(f: Feature): string {
  const payload = encodeGeometryPayload(f);
  return `F ${f.id} ${f.layerId} ${f.classId} ${geomKindTag(f.kind)} ${f.attrSet} ${payload}`;
}

function geomKindTag(kind: Feature['kind']): string {
  switch (kind) {
    case 'point':
      return 'P';
    case 'line':
      return 'L';
    case 'polygon':
      return 'G';
    case 'building':
      return 'B';
  }
}

function encodeGeometryPayload(f: Feature): string {
  const g = f.geometry;
  switch (g.kind) {
    case 'point':
      return encodePoint(g.point);
    case 'line':
      // Multiline: `|`-joined parts, no ring semantics.
      return g.lines.map(encodePathSmart).join('|');
    case 'polygon':
    case 'building':
      return encodePolygon(g.polygon);
  }
}

function encodeOmission(o: Omission): string {
  let line = `O ${o.layerId} ${o.count}`;
  if (o.centroid) line += ` centroid=${o.centroid.x},${o.centroid.y}`;
  if (o.note !== undefined) line += ` note=${o.note}`;
  return line;
}

function encodeRef(r: Ref): string {
  let line = `REF ${r.kind} ${r.uri}`;
  if (r.mime) line += ` mime=${r.mime}`;
  if (r.note !== undefined) line += ` note=${r.note}`;
  return line;
}

function encodeRouteHeader(r: Route): string {
  let line = `ROUTE ${r.id} ${r.mode}`;
  if (r.dist !== undefined) line += ` dist=${r.dist}`;
  if (r.time !== undefined) line += ` time=${r.time}`;
  return line;
}

function encodeStep(s: RouteStep): string {
  // The instruction is the rest of the line, so it must come after all kv pairs.
  const kv: string[] = [];
  if (s.dist !== undefined) kv.push(`dist=${s.dist}`);
  if (s.ref !== undefined) kv.push(`ref=${s.ref}`);
  if (s.turn !== undefined) kv.push(`turn=${s.turn}`);
  return `STEP ${s.n} ${kv.length > 0 ? kv.join(' ') + ' ' : ''}${s.instruction}`;
}

function orderedKeys(record: Record<string, string>): string[] {
  return Object.keys(record).sort();
}

/** Sort Map values by a numeric or string key, for deterministic output. */
function sorted<T>(iterable: Iterable<T>): T[] {
  return [...iterable].sort((a, b) => compareIds(a, b));
}

function compareIds(a: unknown, b: unknown): number {
  const av = idOf(a);
  const bv = idOf(b);
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  return String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
}

function idOf(x: unknown): number | string {
  if (x && typeof x === 'object' && 'id' in x) {
    const id = (x as { id: unknown }).id;
    if (typeof id === 'number') return id;
    if (typeof id === 'string') return id;
  }
  return String(x);
}

export { encodeDocument as encode };
export type {
  AttrValue,
  AttributeSet,
  ClassDef,
  Envelope,
  Feature,
  HeatLayer,
  Layer,
  Omission,
  Prop,
  Projection,
  Ref,
  Route,
  ScrDocument,
};

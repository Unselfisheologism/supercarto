import {
  DEFAULT_EXTENT,
  DEFAULT_PROJECTION,
  KEY_STRING_CEILING,
  SCR_MAGIC,
  type AttrValue,
  type AttributeSet,
  type ClassDef,
  type Feature,
  type GeomKind,
  type HeatLayer,
  type Layer,
  type Omission,
  type Projection,
  type Prop,
  type Ref,
  type RefKind,
  type Route,
  type RouteStep,
  type ScrDocument,
} from './types.js';
import {
  decodePath,
  decodePathAuto,
  decodePolygon,
  decodeProps,
  decodeRleRuns,
  decodeSparseCells,
  int,
  num,
} from './geometry.js';
import { ScrError } from './errors.js';

export interface DecodeOptions {
  /** Guard against a hostile document exploding memory. Default 5_000_000. */
  readonly maxFeatures?: number;
}

/** Parse SCR text into a document. Single forward pass, no backtracking. */
export function decodeDocument(text: string, opts: DecodeOptions = {}): ScrDocument {
  const maxFeatures = opts.maxFeatures ?? 5_000_000;
  const lines = text.split('\n');

  const doc: ScrDocument = {
    version: 1,
    envelope: { type: 'tile', z: 0, x: 0, y: 0 },
    projection: DEFAULT_PROJECTION,
    extent: DEFAULT_EXTENT,
    buffer: 0,
    meta: {},
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

  let sawHeader = false;
  let sawEnvelope = false;
  let sawQ = false;
  const heatById = new Map<number, HeatLayer>();
  const routeById = new Map<number, Route>();

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i]!;
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const sp = line.indexOf(' ');
    const tag = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? '' : line.slice(sp + 1).trim();

    if (!sawHeader) {
      if (tag !== SCR_MAGIC) throw new ScrError(`expected "${SCR_MAGIC}" header, got "${tag}"`, lineNo);
      const version = int(rest);
      if (version !== 1) {
        throw new ScrError(`unsupported SCR major version ${version}`, lineNo);
      }
      doc.version = version;
      sawHeader = true;
      continue;
    }

    switch (tag) {
      case 'TILE': {
        const f = fields(rest, 3, 'TILE', lineNo);
        doc.envelope = { type: 'tile', z: int(f[0]!), x: int(f[1]!), y: int(f[2]!) };
        sawEnvelope = true;
        break;
      }
      case 'BBOX': {
        const f = fields(rest, 4, 'BBOX', lineNo);
        doc.envelope = {
          type: 'bbox',
          west: num(f[0]!),
          south: num(f[1]!),
          east: num(f[2]!),
          north: num(f[3]!),
        };
        sawEnvelope = true;
        break;
      }
      case 'PROJ': {
        const name = fields(rest, 1, 'PROJ', lineNo)[0]!;
        if (name !== 'webmerc' && name !== 'wgs84') {
          throw new ScrError(`unknown projection "${name}"`, lineNo);
        }
        doc.projection = name as Projection;
        break;
      }
      case 'Q': {
        doc.extent = int(fields(rest, 1, 'Q', lineNo)[0]!);
        sawQ = true;
        break;
      }
      case 'BUF':
        doc.buffer = int(fields(rest, 1, 'BUF', lineNo)[0]!);
        break;
      case 'META': {
        const f = fields(rest, 2, 'META', lineNo);
        doc.meta[f[0]!] = f.slice(1).join(' ');
        break;
      }
      case 'L': {
        const f = fields(rest, 2, 'L', lineNo);
        const layer: Layer = { id: int(f[0]!), name: f.slice(1).join(' ') };
        doc.layers.set(layer.id, layer);
        break;
      }
      case 'C': {
        const f = fields(rest, 3, 'C', lineNo);
        const cls: ClassDef = { id: int(f[0]!), layerId: int(f[1]!), name: f.slice(2).join(' ') };
        doc.classes.set(cls.id, cls);
        break;
      }
      case 'S': {
        const sp2 = rest.indexOf(' ');
        if (sp2 < 0) throw new ScrError('S record needs text', lineNo);
        const id = int(rest.slice(0, sp2));
        doc.strings.set(id, rest.slice(sp2 + 1));
        break;
      }
      case 'A': {
        const f = fields(rest, 2, 'A', lineNo);
        const set: AttributeSet = { id: int(f[0]!), props: decodeProps(f[1]!) };
        doc.attrSets.set(set.id, set);
        break;
      }
      case 'F': {
        if (doc.features.length >= maxFeatures) {
          throw new ScrError(`feature count exceeds maxFeatures (${maxFeatures})`, lineNo);
        }
        doc.features.push(decodeFeature(rest, lineNo));
        break;
      }
      case 'H': {
        const f = fields(rest, 5, 'H', lineNo);
        const layer: HeatLayer = {
          id: int(f[0]!),
          name: f[1]!,
          resolution: int(f[2]!),
          minValue: num(f[3]!),
          maxValue: num(f[4]!),
          encoding: 'sparse',
          cells: [],
        };
        heatById.set(layer.id, layer);
        doc.heat.push(layer);
        break;
      }
      case 'D': {
        const f = fields(rest, 3, 'D', lineNo);
        const h = requireHeat(heatById, int(f[0]!), lineNo);
        h.encoding = 'rle';
        (h.rows ??= []).push({ y: int(f[1]!), runs: decodeRleRuns(f[2]!) });
        break;
      }
      case 'X': {
        const f = fields(rest, 2, 'X', lineNo);
        const h = requireHeat(heatById, int(f[0]!), lineNo);
        h.encoding = 'sparse';
        (h.cells ??= []).push(...decodeSparseCells(f[1]!));
        break;
      }
      case 'HC': {
        const f = fields(rest, 3, 'HC', lineNo);
        const h = requireHeat(heatById, int(f[0]!), lineNo);
        h.encoding = 'cell';
        (h.indexed ??= []).push({ cell: f[1]!, value: num(f[2]!) });
        break;
      }
      case 'O': {
        const f = fields(rest, 2, 'O', lineNo);
        const omission: Omission = { layerId: int(f[0]!), count: int(f[1]!) };
        for (const tok of f.slice(2)) {
          const eq = tok.indexOf('=');
          if (eq < 0) throw new ScrError(`malformed O option "${tok}"`, lineNo);
          const k = tok.slice(0, eq);
          const v = tok.slice(eq + 1);
          if (k === 'centroid') {
            const c = v.split(',');
            omission.centroid = { x: int(c[0]!), y: int(c[1]!) };
          } else if (k === 'note') {
            omission.note = int(v);
          } else {
            throw new ScrError(`unknown O option "${k}"`, lineNo);
          }
        }
        doc.omissions.push(omission);
        break;
      }
      case 'REF': {
        const f = fields(rest, 2, 'REF', lineNo);
        const ref: Ref = { kind: f[0]! as RefKind, uri: f[1]! };
        for (const tok of f.slice(2)) {
          const eq = tok.indexOf('=');
          if (eq < 0) throw new ScrError(`malformed REF option "${tok}"`, lineNo);
          const k = tok.slice(0, eq);
          const v = tok.slice(eq + 1);
          if (k === 'mime') ref.mime = v;
          else if (k === 'note') ref.note = int(v);
          else throw new ScrError(`unknown REF option "${k}"`, lineNo);
        }
        doc.refs.push(ref);
        break;
      }
      case 'ROUTE': {
        const f = fields(rest, 2, 'ROUTE', lineNo);
        const route: Route = { id: int(f[0]!), mode: f[1]!, steps: [] };
        for (const tok of f.slice(2)) {
          const eq = tok.indexOf('=');
          if (eq < 0) throw new ScrError(`malformed ROUTE option "${tok}"`, lineNo);
          const k = tok.slice(0, eq);
          const v = tok.slice(eq + 1);
          if (k === 'dist') route.dist = int(v);
          else if (k === 'time') route.time = int(v);
          else throw new ScrError(`unknown ROUTE option "${k}"`, lineNo);
        }
        routeById.set(route.id, route);
        doc.routes.push(route);
        break;
      }
      case 'STEP': {
        const sp3 = rest.indexOf(' ');
        if (sp3 < 0) throw new ScrError('STEP record needs an instruction', lineNo);
        const n = int(rest.slice(0, sp3));
        const step: RouteStep = { n, instruction: '' };
        // Leading `k=v` pairs, then the instruction as the rest of the line.
        const tail = rest.slice(sp3 + 1);
        let consumed = 0;
        for (;;) {
          const m = /^(dist|ref|turn)=(\S+)\s*/.exec(tail.slice(consumed));
          if (!m) break;
          const k = m[1]!;
          const v = m[2]!;
          if (k === 'dist') step.dist = int(v);
          else if (k === 'ref') step.ref = int(v);
          else step.turn = v;
          consumed += m[0].length;
        }
        step.instruction = tail.slice(consumed).trim();
        if (step.instruction === '') throw new ScrError('STEP instruction is empty', lineNo);
        const route = lastRoute(routeById, lineNo);
        route.steps.push(step);
        break;
      }
      default:
        throw new ScrError(`unknown record tag "${tag}"`, lineNo);
    }
  }

  if (!sawHeader) throw new ScrError('empty document: missing SCR header');
  if (!sawEnvelope) throw new ScrError('missing envelope: need TILE or BBOX');
  if (!sawQ) throw new ScrError('missing Q record: quantization extent is required');

  return doc;
}

/**
 * Split a record's payload into fields and require at least `count` of them.
 *
 * Extra fields beyond `count` are permitted: a trailing name may legitimately
 * contain spaces, and the caller joins the remainder itself. That is why this
 * only enforces a lower bound.
 */
function fields(rest: string, count: number, tag: string, lineNo: number): string[] {
  const parts = rest.length === 0 ? [] : rest.split(' ');
  if (parts.length < count) {
    throw new ScrError(`${tag} needs ${count} fields, got ${parts.length}`, lineNo);
  }
  return parts;
}

function requireHeat(byId: Map<number, HeatLayer>, id: number, lineNo: number): HeatLayer {
  const h = byId.get(id);
  if (!h) throw new ScrError(`heat record references undeclared layer ${id}`, lineNo);
  return h;
}

function lastRoute(byId: Map<number, Route>, lineNo: number): Route {
  let last: Route | undefined;
  for (const r of byId.values()) last = r;
  if (!last) throw new ScrError('STEP record before any ROUTE record', lineNo);
  return last;
}

function decodeFeature(rest: string, lineNo: number): Feature {
  const f = fields(rest, 6, 'F', lineNo);
  const id = int(f[0]!);
  const layerId = int(f[1]!);
  const classId = int(f[2]!);
  const kind = decodeGeomKind(f[3]!, lineNo);
  const attrSet = int(f[4]!);
  const payload = f.slice(5).join(' ');

  return { id, layerId, classId, kind, attrSet, geometry: decodeGeometry(kind, payload) };
}

function decodeGeomKind(tag: string, lineNo: number): GeomKind {
  switch (tag) {
    case 'P':
      return 'point';
    case 'L':
      return 'line';
    case 'G':
      return 'polygon';
    case 'B':
      return 'building';
    default:
      throw new ScrError(`unknown geometry kind "${tag}"`, lineNo);
  }
}

function decodeGeometry(kind: GeomKind, payload: string) {
  switch (kind) {
    case 'point': {
      const path = decodePath(payload);
      if (path.length === 0) throw new ScrError('point geometry is empty');
      return { kind: 'point' as const, point: path[0]! };
    }
    case 'line': {
      const lines = payload
        .split('|')
        .filter((s) => s !== '')
        .map(decodePathAuto);
      return { kind: 'line' as const, lines };
    }
    case 'polygon':
      return { kind: 'polygon' as const, polygon: decodePolygon(payload) };
    case 'building':
      return { kind: 'building' as const, polygon: decodePolygon(payload) };
  }
}

export { decodeDocument as decode };
export type { Prop, AttrValue };
export { KEY_STRING_CEILING };

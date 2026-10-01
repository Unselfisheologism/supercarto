import type {
  AttrValue,
  GridLine,
  GridPoint,
  GridPolygon,
  HeatLayer,
  Prop,
} from './types.js';
import { ScrError } from './errors.js';

/** Separates polygon parts. Chosen over winding-order inference so decoding is unambiguous. */
export const PART_SEPARATOR = '||';
const RING_SEPARATOR = '|';
const VERTEX_SEPARATOR = ';';
const DELTA_PREFIX = 'd:';

// ---------------------------------------------------------------------------
// Coordinate lists
// ---------------------------------------------------------------------------

/** Encode an absolute path as `x,y;x,y;...`. */
export function encodePath(line: GridLine): string {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const p = line[i]!;
    if (i > 0) out += VERTEX_SEPARATOR;
    out += `${p.x},${p.y}`;
  }
  return out;
}

/**
 * Encode a path as a delta list: the first vertex absolute, the rest as
 * displacements. Small deltas tokenize in fewer tokens than large absolutes,
 * which is the entire reason this exists.
 *
 * The payload is one flat comma-separated number stream, matching the spec:
 * `d:100,100,50,0,0,50` is three vertices. It is deliberately not
 * `;`-separated like an absolute path, which keeps the number stream uniform
 * and removes any chance of mixing the two conventions inside one payload.
 */
export function encodeDeltaPath(line: GridLine): string {
  if (line.length === 0) return '';
  const parts: string[] = [];
  const first = line[0]!;
  parts.push(`${first.x},${first.y}`);
  for (let i = 1; i < line.length; i++) {
    const prev = line[i - 1]!;
    const cur = line[i]!;
    parts.push(`${cur.x - prev.x},${cur.y - prev.y}`);
  }
  return DELTA_PREFIX + parts.join(',');
}

/** Parse `x,y;x,y;...`, absolute. */
export function decodePath(text: string): GridLine {
  if (text === '') return [];
  const out: GridLine = [];
  for (const chunk of text.split(VERTEX_SEPARATOR)) {
    if (chunk === '') continue;
    out.push(parsePoint(chunk));
  }
  return out;
}

/**
 * Parse `d:x,y,dx,dy,...`, resolving the running position.
 *
 * The whole payload is one comma-separated number stream, where the first pair
 * is absolute and every later pair is a displacement. It is not `;`-separated
 * like an absolute path, so it must be split on commas.
 */
export function decodeDeltaPath(text: string): GridLine {
  const body = text.slice(DELTA_PREFIX.length);
  if (body === '') return [];
  const nums = body.split(',').filter((s) => s !== '');
  if (nums.length < 2) {
    throw new ScrError(`delta path needs at least one vertex, got "${text}"`);
  }
  if (nums.length % 2 !== 0) {
    throw new ScrError(`delta path has odd coordinate count in "${text}"`);
  }
  let x = int(nums[0]!);
  let y = int(nums[1]!);
  const out: GridLine = [{ x, y }];
  for (let i = 2; i < nums.length; i += 2) {
    x += int(nums[i]!);
    y += int(nums[i + 1]!);
    out.push({ x, y });
  }
  return out;
}

/** Parse either form, detecting the `d:` prefix. */
export function decodePathAuto(text: string): GridLine {
  return text.startsWith(DELTA_PREFIX) ? decodeDeltaPath(text) : decodePath(text);
}

/** Choose delta for long paths (where it pays) and absolute for short ones. */
export function encodePathSmart(line: GridLine): string {
  return line.length >= 4 ? encodeDeltaPath(line) : encodePath(line);
}

// ---------------------------------------------------------------------------
// Rings and polygons
// ---------------------------------------------------------------------------

function closeRing(line: GridLine): GridLine {
  if (line.length === 0) return line;
  const a = line[0]!;
  const b = line[line.length - 1]!;
  if (a.x === b.x && a.y === b.y) return line;
  return [...line, { x: a.x, y: a.y }];
}

/** Open a ring, dropping a duplicated closing vertex. Rings are implicitly closed. */
function openRing(line: GridLine): GridLine {
  if (line.length < 2) return line;
  const a = line[0]!;
  const b = line[line.length - 1]!;
  if (a.x === b.x && a.y === b.y) return line.slice(0, -1);
  return line;
}

/** Encode a polygon as `ext|hole||ext2|hole2`. */
export function encodePolygon(polygon: GridPolygon): string {
  return polygon
    .map((part) => part.rings.map(encodePathSmart).join(RING_SEPARATOR))
    .join(PART_SEPARATOR);
}

/**
 * Decode a polygon. `||` separates parts, `|` separates rings. The first ring of
 * each part is the exterior; the rest are holes.
 */
export function decodePolygon(text: string): GridPolygon {
  if (text === '') return [];
  const parts: GridPolygon = [];
  for (const partText of text.split(PART_SEPARATOR)) {
    const rings = partText
      .split(RING_SEPARATOR)
      .filter((r) => r !== '')
      .map((r) => decodePathAuto(r));
    if (rings.length > 0) parts.push({ rings });
  }
  return parts;
}

/** Ring area in grid units, sign indicating winding. Used for orientation fixes. */
export function signedRingArea(ring: GridLine): number {
  const r = closeRing(ring);
  let sum = 0;
  for (let i = 0; i < r.length - 1; i++) {
    const a = r[i]!;
    const b = r[i + 1]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

// ---------------------------------------------------------------------------
// Point payloads
// ---------------------------------------------------------------------------

export function encodePoint(p: GridPoint): string {
  return p.z === undefined ? `${p.x},${p.y}` : `${p.x},${p.y},${p.z}`;
}

function parsePoint(chunk: string): GridPoint {
  const parts = chunk.split(',');
  if (parts.length < 2) throw new ScrError(`malformed point "${chunk}"`);
  const p: GridPoint = { x: int(parts[0]!), y: int(parts[1]!) };
  if (parts.length >= 3 && parts[2] !== '') p.z = int(parts[2]!);
  return p;
}

// ---------------------------------------------------------------------------
// Heat encodings
// ---------------------------------------------------------------------------

/** `X <id> x,y,v;x,y,v` — sparse cells. */
export function encodeSparseHeat(h: HeatLayer): string[] {
  const cells = h.cells ?? [];
  const body = cells.map((c) => `${c.x},${c.y},${c.value}`).join(VERTEX_SEPARATOR);
  return body === '' ? [] : [`X ${h.id} ${body}`];
}

/** `D <id> <row> x,len,v;x,len,v` — run-length rows. */
export function encodeRleHeat(h: HeatLayer): string[] {
  const rows = h.rows ?? [];
  const out: string[] = [];
  for (const row of rows) {
    if (row.runs.length === 0) continue;
    const body = row.runs.map((r) => `${r.x},${r.len},${r.value}`).join(VERTEX_SEPARATOR);
    out.push(`D ${h.id} ${row.y} ${body}`);
  }
  return out;
}

/** `HC <id> <cell> <value>` — externally indexed cells. */
export function encodeIndexedHeat(h: HeatLayer): string[] {
  return (h.indexed ?? []).map((c) => `HC ${h.id} ${c.cell} ${c.value}`);
}

export function encodeHeatBody(h: HeatLayer): string[] {
  switch (h.encoding) {
    case 'rle':
      return encodeRleHeat(h);
    case 'cell':
      return encodeIndexedHeat(h);
    case 'sparse':
    default:
      return encodeSparseHeat(h);
  }
}

/** Parse an `X` payload body into cells. */
export function decodeSparseCells(text: string): { x: number; y: number; value: number }[] {
  const out: { x: number; y: number; value: number }[] = [];
  for (const chunk of text.split(VERTEX_SEPARATOR)) {
    if (chunk === '') continue;
    const parts = chunk.split(',');
    if (parts.length < 3) throw new ScrError(`malformed heat cell "${chunk}"`);
    out.push({ x: int(parts[0]!), y: int(parts[1]!), value: num(parts[2]!) });
  }
  return out;
}

/** Parse a `D` payload body into runs. */
export function decodeRleRuns(text: string): { x: number; len: number; value: number }[] {
  const out: { x: number; len: number; value: number }[] = [];
  for (const chunk of text.split(VERTEX_SEPARATOR)) {
    if (chunk === '') continue;
    const parts = chunk.split(',');
    if (parts.length < 3) throw new ScrError(`malformed heat run "${chunk}"`);
    out.push({ x: int(parts[0]!), len: int(parts[1]!), value: num(parts[2]!) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Attribute values
// ---------------------------------------------------------------------------

/** `key=s123;12=18;13=true` */
export function encodeProps(props: Prop[]): string {
  return props
    .map((p) => {
      const v = p.value;
      let rendered: string;
      switch (v.t) {
        case 'ref':
          rendered = `s${v.ref}`;
          break;
        case 'num':
          rendered = String(v.num);
          break;
        case 'bool':
          rendered = v.bool ? 'true' : 'false';
          break;
        case 'token':
          rendered = v.token;
          break;
      }
      return `${p.key}=${rendered}`;
    })
    .join(VERTEX_SEPARATOR);
}

/**
 * Parse `key=value` pairs. A value of the form `s<digits>` becomes a string
 * reference; a bare token stays a token so that `s`-ambiguity is never silently
 * resolved the wrong way.
 */
export function decodeProps(text: string): Prop[] {
  if (text === '' || text === '0') return [];
  const out: Prop[] = [];
  for (const chunk of text.split(VERTEX_SEPARATOR)) {
    if (chunk === '') continue;
    const eq = chunk.indexOf('=');
    if (eq < 0) throw new ScrError(`malformed property "${chunk}"`);
    const key = int(chunk.slice(0, eq));
    const raw = chunk.slice(eq + 1);
    out.push({ key, value: parseAttrValue(raw) });
  }
  return out;
}

function parseAttrValue(raw: string): AttrValue {
  if (/^s\d+$/.test(raw)) return { t: 'ref', ref: int(raw.slice(1)) };
  if (raw === 'true') return { t: 'bool', bool: true };
  if (raw === 'false') return { t: 'bool', bool: false };
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw)) return { t: 'num', num: Number(raw) };
  return { t: 'token', token: raw };
}

// ---------------------------------------------------------------------------
// Scalar parsing
// ---------------------------------------------------------------------------

/** Strict integer parse. Rejects `1.5`, `abc`, and `1e3` rather than coercing. */
export function int(text: string): number {
  if (!/^-?\d+$/.test(text)) throw new ScrError(`expected integer, got "${text}"`);
  return Number(text);
}

export function num(text: string): number {
  const n = Number(text);
  if (!Number.isFinite(n)) throw new ScrError(`expected number, got "${text}"`);
  return n;
}

export { closeRing, openRing };

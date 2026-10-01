import type { GridLine, GridPoint } from '../wire/types.js';
import { lonLatToTile } from './project.js';
import type { LonLat } from './project.js';

// ---------------------------------------------------------------------------
// Bounding boxes
// ---------------------------------------------------------------------------

export interface Bbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function emptyBbox(): Bbox {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function expandBbox(box: Bbox, p: GridPoint): Bbox {
  if (p.x < box.minX) box.minX = p.x;
  if (p.y < box.minY) box.minY = p.y;
  if (p.x > box.maxX) box.maxX = p.x;
  if (p.y > box.maxY) box.maxY = p.y;
  return box;
}

export function unionBbox(a: Bbox, b: Bbox): Bbox {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function bboxOfLine(line: GridLine): Bbox {
  const box = emptyBbox();
  for (const p of line) expandBbox(box, p);
  return box;
}

export function bboxIntersects(a: Bbox, b: Bbox): boolean {
  return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
}

export function bboxContains(outer: Bbox, inner: Bbox): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.minY >= outer.minY &&
    inner.maxX <= outer.maxX &&
    inner.maxY <= outer.maxY
  );
}

export function bboxCenter(box: Bbox): GridPoint {
  return {
    x: Math.round((box.minX + box.maxX) / 2),
    y: Math.round((box.minY + box.maxY) / 2),
  };
}

export function bboxWidth(b: Bbox): number {
  return b.maxX - b.minX;
}

export function bboxHeight(b: Bbox): number {
  return b.maxY - b.minY;
}

// ---------------------------------------------------------------------------
// Simplification
// ---------------------------------------------------------------------------

function perpDistance(p: GridPoint, a: GridPoint, b: GridPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
  const clamped = Math.max(0, Math.min(1, t));
  const projX = a.x + clamped * dx;
  const projY = a.y + clamped * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

/**
 * Visvalingam-Whyatt simplification.
 *
 * Repeatedly drops the vertex that collapses the least area, until every
 * remaining vertex collapses by more than the tolerance. This preserves shape
 * where it matters and removes detail where it does not, which is what an agent
 * navigating a street needs.
 *
 * Iterative with an explicit heap rather than recursive: real map data hands us
 * 50,000-vertex lines, and a recursive version overflows the stack.
 */
export function simplifyLine(line: GridLine, tolerance: number): GridLine {
  const n = line.length;
  if (tolerance <= 0 || n <= 2) return line;

  // Effective (not squared) area threshold, derived from the tolerance.
  const tolArea = tolerance * tolerance;

  // Doubly-linked list over the live vertices.
  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    prev[i] = i - 1;
    next[i] = i + 1;
  }
  next[n - 1] = -1;

  // A binary min-heap over (effectiveArea, index). Lazy deletion: entries for
  // already-removed vertices are skipped when popped.
  const area = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    area[i] = effectiveArea(line, i, prev, next);
  }
  const heap = new MinHeap<number>();
  for (let i = 1; i < n - 1; i++) heap.push(area[i]!, i);

  const alive = new Uint8Array(n).fill(1);

  while (heap.size > 0) {
    const top = heap.pop()!;
    const i = top.value;
    // Skip stale entries: the vertex may already be gone, or its area may have
    // changed since it was pushed.
    if (!alive[i]) continue;
    if (area[i]! > tolArea) break;
    if (top.priority !== area[i]!) continue;

    alive[i] = 0;
    const p = prev[i]!;
    const q = next[i]!;

    if (p >= 0) next[p] = q;
    if (q >= 0) prev[q] = p;

    // The neighbours' collapse areas just changed, so re-push them.
    if (p > 0 && p < n - 1) {
      area[p] = effectiveArea(line, p, prev, next);
      heap.push(area[p]!, p);
    }
    if (q > 0 && q < n - 1) {
      area[q] = effectiveArea(line, q, prev, next);
      heap.push(area[q]!, q);
    }
  }

  const out: GridLine = [];
  for (let i = 0; i < n; i++) if (alive[i] === 1) out.push(line[i]!);
  return out.length >= 2 ? out : line;
}

/** Twice the area of the triangle a vertex would collapse, given its live neighbours. */
function effectiveArea(
  line: GridLine,
  i: number,
  prev: Int32Array,
  next: Int32Array,
): number {
  const p = prev[i]!;
  const q = next[i]!;
  if (p < 0 || q < 0) return Number.POSITIVE_INFINITY;
  const a = line[p]!;
  const b = line[i]!;
  const c = line[q]!;
  return Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
}

/** Minimal binary min-heap keyed on a numeric priority. */
class MinHeap<T> {
  private prio: number[] = [];
  private vals: T[] = [];

  get size(): number {
    return this.vals.length;
  }

  push(priority: number, value: T): void {
    this.prio.push(priority);
    this.vals.push(value);
    let i = this.vals.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prio[parent]! <= this.prio[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): { priority: number; value: T } | undefined {
    if (this.vals.length === 0) return undefined;
    const priority = this.prio[0]!;
    const value = this.vals[0]!;
    const lastPrio = this.prio.pop()!;
    const lastVal = this.vals.pop()!;
    if (this.vals.length > 0) {
      this.prio[0] = lastPrio;
      this.vals[0] = lastVal;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.prio.length && this.prio[l]! < this.prio[smallest]!) smallest = l;
        if (r < this.prio.length && this.prio[r]! < this.prio[smallest]!) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return { priority, value };
  }

  private swap(a: number, b: number): void {
    [this.prio[a], this.prio[b]] = [this.prio[b]!, this.prio[a]!];
    [this.vals[a], this.vals[b]] = [this.vals[b]!, this.vals[a]!];
  }
}

/** Drop consecutive duplicates, which simplify can create. */
export function dedupeLine(line: GridLine, closed = false): GridLine {
  const out: GridLine = [];
  for (const p of line) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push(p);
  }
  if (closed && out.length > 1) {
    const a = out[0]!;
    const b = out[out.length - 1]!;
    if (a.x === b.x && a.y === b.y) out.pop();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vertex welding
// ---------------------------------------------------------------------------

/**
 * Quantize a point to a welding grid. Roads that share an intersection arrive
 * with coordinates a fraction of a grid unit apart; welding snaps them together
 * so the topology compiler can find the junction instead of missing it.
 */
export function weldKey(p: GridPoint, quantum: number): string {
  return `${Math.round(p.x / quantum)},${Math.round(p.y / quantum)}`;
}

export function clusterKey(p: GridPoint, quantum: number): string {
  return weldKey(p, quantum);
}

// ---------------------------------------------------------------------------
// Cardinal direction
// ---------------------------------------------------------------------------

/**
 * Compass bearing in degrees, 0 = north, clockwise.
 *
 * Note the grid y axis points south (it follows the screen/tile convention), so
 * the sign is flipped relative to the usual math convention.
 */
export function bearing(a: GridPoint, b: GridPoint): number {
  const dx = b.x - a.x;
  const dy = -(b.y - a.y);
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

const COMPASS = [
  'north',
  'northeast',
  'east',
  'southeast',
  'south',
  'southwest',
  'west',
  'northwest',
] as const;

export type Compass = (typeof COMPASS)[number];

/**
 * Reduce a bearing to one of eight compass words.
 *
 * Eight, not sixteen: "north" costs one token, "north by east" costs five, and
 * the difference does not change a routing decision.
 */
export function compassOf(a: GridPoint, b: GridPoint): Compass {
  const deg = bearing(a, b);
  const idx = Math.round(deg / 45) % 8;
  return COMPASS[idx]!;
}

/** The compass word 180 degrees opposite. */
export function oppositeCompass(c: Compass): Compass {
  const map: Record<Compass, Compass> = {
    north: 'south',
    northeast: 'southwest',
    east: 'west',
    southeast: 'northwest',
    south: 'north',
    southwest: 'northeast',
    west: 'east',
    northwest: 'southeast',
  };
  return map[c];
}

/** Turn taken when arriving on `from->via` and leaving via `via->to`. */
export function turnFrom(inbound: Compass, outbound: Compass): string {
  const order: Compass[] = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  const step = 45;
  const delta = ((order.indexOf(outbound) - order.indexOf(inbound)) * step + 360) % 360;
  if (delta === 0) return 'straight';
  if (delta < 180) return 'right';
  return 'left';
}

// ---------------------------------------------------------------------------
// Zoom heuristics
// ---------------------------------------------------------------------------

/**
 * Pick a slippy zoom for a radius in metres. Coarse deliberately: an agent
 * reasoning about a neighbourhood wants the neighbourhood, and extra zoom costs
 * tokens without adding an answer.
 */
export function zoomForRadius(radiusM: number): number {
  if (radiusM <= 100) return 18;
  if (radiusM <= 250) return 17;
  if (radiusM <= 500) return 16;
  if (radiusM <= 1000) return 15;
  if (radiusM <= 2500) return 14;
  if (radiusM <= 5000) return 13;
  if (radiusM <= 25000) return 12;
  if (radiusM <= 100000) return 10;
  if (radiusM <= 500000) return 8;
  return 6;
}

/** Tile containing a lon/lat, clamped into range so a pole never yields NaN. */
export function tileOf(p: LonLat, z: number): { z: number; x: number; y: number } {
  const n = 2 ** z;
  const { x, y } = lonLatToTile(p.lon, p.lat, z);
  return { z, x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

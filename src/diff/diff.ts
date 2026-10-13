import type { Feature, ScrDocument } from '../wire/types.js';

/**
 * State diffs: what changed between two documents.
 *
 * Benefit #5 of the planning doc. An agent that moves does not need the whole
 * map again; it needs `+` (entered view), `-` (left view) and `~` (updated).
 * Compared by wire feature id, which is stable across documents because
 * ingest prefers the source's own id. Geometry compares exactly - grid
 * integers, no tolerance - because a moved vertex is a change worth
 * reporting, not noise to absorb.
 *
 * Precondition: both documents share envelope, extent and projection (the
 * benchmark ingests both fixtures with their union bbox). Otherwise
 * quantization differs per doc and identical source geometry compares dirty.
 * Layer, class and attributes compare by resolved name/content, which is
 * immune to per-document interning counters; geometry has no such luxury.
 */
export type ChangeOp = '+' | '-' | '~';

export interface FeatureChange {
  op: ChangeOp;
  id: number;
  /** For `~`: which aspects differ (`geometry`, `layer`, `class`, `attributes`). */
  aspects: string[];
}

function geomKey(f: Feature): string {
  return JSON.stringify(f.geometry);
}

/**
 * Resolved attributes: key strings to plain values, so two independently
 * ingested documents compare by content rather than by interned ids (which
 * are per-document counters and never equal across docs).
 */
function resolvedAttrs(f: Feature, doc: ScrDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const set = doc.attrSets.get(f.attrSet);
  if (!set) return out;
  for (const p of set.props) {
    const key = doc.strings.get(p.key) ?? `key${p.key}`;
    const v = p.value;
    out[key] = v.t === 'ref' ? (doc.strings.get(v.ref) ?? v.ref) : v.t === 'num' ? v.num : v.t === 'bool' ? v.bool : v.token;
  }
  return out;
}

function aspectsOf(a: Feature, da: ScrDocument, b: Feature, db: ScrDocument): string[] {
  const out: string[] = [];
  // Names, not ids: layer and class ids are per-document interning counters.
  if ((da.layers.get(a.layerId)?.name ?? a.layerId) !== (db.layers.get(b.layerId)?.name ?? b.layerId)) {
    out.push('layer');
  }
  if ((da.classes.get(a.classId)?.name ?? a.classId) !== (db.classes.get(b.classId)?.name ?? b.classId)) {
    out.push('class');
  }
  if (a.kind !== b.kind || geomKey(a) !== geomKey(b)) out.push('geometry');
  if (JSON.stringify(resolvedAttrs(a, da)) !== JSON.stringify(resolvedAttrs(b, db))) {
    out.push('attributes');
  }
  return out;
}

export function diffDocuments(a: ScrDocument, b: ScrDocument): FeatureChange[] {
  const am = new Map(a.features.map((f) => [f.id, f]));
  const bm = new Map(b.features.map((f) => [f.id, f]));
  const out: FeatureChange[] = [];
  for (const [id, fa] of [...am.entries()].sort((x, y) => x[0] - y[0])) {
    const fb = bm.get(id);
    if (!fb) {
      out.push({ op: '-', id, aspects: [] });
      continue;
    }
    const aspects = aspectsOf(fa, a, fb, b);
    if (aspects.length > 0) out.push({ op: '~', id, aspects });
  }
  for (const [id] of [...bm.entries()].sort((x, y) => x[0] - y[0])) {
    if (!am.has(id)) out.push({ op: '+', id, aspects: [] });
  }
  // Deterministic across runs: removals and changes in id order, then
  // additions in id order. A diff that shuffles is untestable.
  return out.sort((x, y) => x.id - y.id);
}

/** Human-readable name of a feature, resolved through the document's tables. */
function featureLabel(f: Feature, doc: ScrDocument): string {
  const layer = doc.layers.get(f.layerId)?.name ?? `layer${f.layerId}`;
  const attrs = doc.attrSets.get(f.attrSet);
  let name = '';
  if (attrs) {
    for (const p of attrs.props) {
      if (doc.strings.get(p.key) === 'name' && p.value.t === 'ref') {
        name = doc.strings.get(p.value.ref) ?? '';
        break;
      }
    }
  }
  return name ? `${name} (${layer})` : `feature ${f.id} (${layer})`;
}

/**
 * Render changes as the planning doc's `+`/`-`/`~` lines.
 *
 * Names resolve from whichever document holds the feature (the new one for
 * additions and updates, the old one for removals), so a removed place is
 * still named rather than numbered.
 */
export function renderDiff(changes: readonly FeatureChange[], a: ScrDocument, b: ScrDocument): string {
  const byId = (doc: ScrDocument) => new Map(doc.features.map((f) => [f.id, f]));
  const am = byId(a);
  const bm = byId(b);
  return changes
    .map((c) => {
      if (c.op === '-') {
        const f = am.get(c.id);
        return `- ${c.id} ${f ? featureLabel(f, a) : ''}`.trimEnd();
      }
      const f = bm.get(c.id);
      const label = f ? featureLabel(f, b) : '';
      const suffix = c.op === '~' ? ` (${c.aspects.join(', ')})` : '';
      return `${c.op} ${c.id} ${label}${suffix}`.trimEnd();
    })
    .join('\n');
}

import { decodeDocument } from '../wire/decode.js';
import { diffDocuments, renderDiff, type FeatureChange } from '../diff/diff.js';
import type { ScrDocument } from '../wire/types.js';
import { toMaplet, type MapletRequest } from '../pipeline.js';
import { type BboxEnvelope } from '../wire/types.js';
import type { BboxQuery } from '../source/types.js';
import type { GeoJsonFeatureCollection } from '../ingest/geojson.js';

/**
 * The agent moves: session views.
 *
 * A moving agent keeps its map in local RAM as the SCR string each call
 * returns. `moveMaplet` is the engine behind the `localize` tool: it takes
 * the agent's current map, a fresh fetch for the new view box, and returns
 * only the +/-/~ delta plus the new compact state. The LLM context never
 * re-pays for the streets it already knows; the diff names what changed and
 * the harness swaps the stored string.
 *
 * One envelope, the session's, quantizes every view: it is read from the
 * agent's document and pinned into the re-ingest, so the same place always
 * lands on the same grid point and the diff compares geometry exactly rather
 * than quantization noise. That is the precondition every diff run needs.
 */
export interface SessionMoveOptions extends Omit<MapletRequest, 'input'> {}

export interface SessionCounts {
  added: number;
  removed: number;
  updated: number;
}

export interface SessionMoveResult {
  /** What changed from the agent's map to the new view: +, - and ~ records. */
  changes: FeatureChange[];
  /** The rendered diff, one line per change. */
  report: string;
  /** Record counts per op. */
  counts: SessionCounts;
  /** The new view's compact state: the harness stores this, not the LLM. */
  scr: string;
  /** The new view's compiled graph, budget-fit like any other maplet. */
  yaml: string;
  /** Token accounting for the new view. */
  metrics: {
    yamlTokens: number;
    wireBytes: number;
    wireTokens: number;
  };
  /** The view header: the document meta center label, explicitly. */
  view: { center: string; note?: string };
}

export function moveMaplet(
  scr: string,
  features: GeoJsonFeatureCollection,
  opts: SessionMoveOptions = {},
): SessionMoveResult {
  const prev = decodeDocument(scr);
  const view = toMaplet(features, {
    ...opts,
    envelope: prev.envelope,
  });
  const changes = diffDocuments(prev, view.doc);
  const report = renderDiff(changes, prev, view.doc);
  const counts: SessionCounts = {
    added: changes.filter((c) => c.op === '+').length,
    removed: changes.filter((c) => c.op === '-').length,
    updated: changes.filter((c) => c.op === '~').length,
  };
  return {
    changes,
    report,
    counts,
    scr: view.scr,
    yaml: view.yaml,
    metrics: {
      yamlTokens: view.metrics.tokens,
      wireBytes: view.metrics.wireBytes,
      wireTokens: view.metrics.wireTokens,
    },
    view: {
      center: view.graph.meta.center,
      ...(view.graph.meta.note ? { note: view.graph.meta.note } : {}),
    },
  };
}

/** Decode-only re-export so callers can inspect the document they hold. */
export function sessionDoc(scr: string): ScrDocument {
  return decodeDocument(scr);
}

/**
 * Whether a view box can be quantized on the session envelope's grid.
 *
 * A wrapped envelope (`west > east`, the antimeridian) is one grid only on
 * the east-side span `[west, 180]`: the projection is linear in Mercator X,
 * so features inside `[-180, east]` would land on negative grid x, off the
 * document's own coordinate system. A view inside that span is refused -
 * the agent gets a clear instruction to open a new session rather than a
 * diff that a foreign grid would make a lie.
 */
export function sessionEnvelopeContains(
  env: BboxEnvelope,
  bbox: BboxQuery,
): boolean {
  const latOk = bbox.south >= env.south && bbox.north <= env.north;
  if (!latOk) return false;
  if (env.west <= env.east) {
    return bbox.west >= env.west && bbox.east <= env.east;
  }
  // Antimeridian: coverage is [west, 180] plus [-180, east], but only the
  // first span quantizes onto the document's grid.
  return bbox.west >= env.west && bbox.east <= 180;
}

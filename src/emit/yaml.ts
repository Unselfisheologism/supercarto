import type { GraphEdge, GraphNode, SpatialGraph } from '../compile/graph.js';
import { isMeaningfulIndoor, type IndoorGraph } from '../compile/indoor.js';
import type { GridScale } from '../geo/scale.js';

/**
 * Token estimation.
 *
 * BPE tokenizers split on word boundaries, punctuation runs, and digits. A rough
 * but well-behaved model is `ceil(chars / 4)` for prose and slightly worse for
 * digit-dense text, because numbers break into one token per 1-3 digits. Using
 * one consistent estimate matters more than its exact calibration: the budgeter
 * only needs to be right to within ~10% to stop emitting features.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/** Quote a scalar for YAML flow style. Only quote when it must be. */
export function yamlString(value: string): string {
  if (value === '') return '""';
  // Plain scalars are safe when they are not YAML-special and not ambiguous
  // with a number or boolean. Quoting everything costs a token per value and
  // buys nothing for a model that is reading, not a parser being pedantic.
  const needsQuote =
    /^[\s]|[\s]$/.test(value) ||
    /[:#\[\]{}&*!|>'"%@`,]/.test(value) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(value) ||
    /^-?\d+(\.\d+)?$/.test(value) ||
    value === '-' ||
    value === '...';
  return needsQuote ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export interface EmitOptions {
  /**
   * Per-axis metres per grid unit, from `gridScaleFor(doc)`. This is what turns
   * the compiler's grid-space distances into metres. When omitted, distances
   * are emitted as grid units with a `u` suffix so the agent is never misled
   * into reading them as metres.
   */
  readonly scale?: GridScale;
  /** Include the `tools:` list. On by default; it stops the agent guessing. */
  readonly includeTools?: boolean;
  /** Include the `omitted:` block. On by default; honesty about gaps. */
  readonly includeOmitted?: boolean;
  /** Include heat summaries. Default true. */
  readonly includeHeat?: boolean;
  /**
   * Include the indoor `levels:` block. Default true.
   *
   * The block is omitted entirely when the source described no indoor space, so
   * an outdoor maplet does not carry an empty `indoor:` key that a model has to
   * reason about.
   */
  readonly includeIndoor?: boolean;
}

export interface EmitResult {
  yaml: string;
  tokens: number;
  chars: number;
}

/** Render a spatial graph as LLM-native YAML flow style. */
export function emitGraph(graph: SpatialGraph, opts: EmitOptions = {}): EmitResult {
  const scale = opts.scale;
  const out: string[] = [];

  out.push('map:');
  out.push(`  center: ${yamlString(graph.meta.center)}`);
  if (graph.meta.radius) out.push(`  radius: ${yamlString(graph.meta.radius)}`);
  if (graph.meta.lod) out.push(`  lod: ${yamlString(graph.meta.lod)}`);
  if (graph.meta.source) out.push(`  source: ${yamlString(graph.meta.source)}`);
  if (graph.meta.note) out.push(`  note: ${yamlString(graph.meta.note)}`);

  out.push('nodes:');
  if (graph.nodes.length === 0) {
    out.push('  {}');
  } else {
    for (const n of graph.nodes) out.push(`  ${n.id}: ${nodeBody(n)}`);
  }

  out.push('edges:');
  if (graph.edges.length === 0) {
    out.push('  {}');
  } else {
    for (const e of graph.edges) out.push(`  ${e.from}->${e.to}: ${edgeBody(e, scale)}`);
  }

  if (graph.obstacles.length > 0) {
    out.push('obstacles:');
    for (const o of graph.obstacles) {
      const parts = [`edge: ${yamlString(o.edge)}`, `type: ${yamlString(o.type)}`];
      if (o.blocks) parts.push('blocks: true');
      out.push(`  - {${parts.join(', ')}}`);
    }
  }

  if (opts.includeHeat !== false && graph.heat.length > 0) {
    out.push('heat:');
    for (const h of graph.heat) {
      out.push(`  ${yamlString(h.name)}: {max: ${h.max}, mean: ${h.mean}}`);
      for (const spot of h.hotspots) {
        out.push(
          `    - {at: "${spot.lat},${spot.lon}", v: ${spot.value}, rel: ${spot.rel}}`,
        );
      }
    }
  }

  if (opts.includeIndoor !== false && isMeaningfulIndoor(graph.indoor)) {
    out.push(...indoorLines(graph.indoor));
  }

  if (opts.includeOmitted !== false && graph.omitted.length > 0) {
    out.push('omitted:');
    for (const o of graph.omitted) {
      const parts = [`layer: ${yamlString(o.layer)}`, `count: ${o.count}`];
      if (o.near !== 'unspecified') parts.push(`near: ${yamlString(o.near)}`);
      if (o.note) parts.push(`note: ${yamlString(o.note)}`);
      out.push(`  - {${parts.join(', ')}}`);
    }
  }

  if (opts.includeTools !== false && graph.tools.length > 0) {
    out.push('tools:');
    for (const t of graph.tools) out.push(`  - ${t}`);
  }

  const yaml = out.join('\n') + '\n';
  return { yaml, tokens: estimateTokens(yaml), chars: yaml.length };
}

/**
 * Render the indoor block.
 *
 * Shape decisions, all of them made for the reader rather than the parser:
 *
 * - The storey number is a map key (`0:`, `1:`) so a model can say "level 1"
 *   after reading one token, instead of parsing a `level: 1` field per node.
 * - Vertical links are stated once, as a shaft with the list of levels it
 *   serves. Repeating a lift node on every floor would cost more tokens than
 *   the information is worth and would hide that it is one lift.
 * - `missing` is emitted when the data implies untagged storeys, so the agent
 *   knows "level 2 has no data" rather than "level 2 does not exist".
 */
function indoorLines(graph: IndoorGraph): string[] {
  const out: string[] = ['indoor:'];
  out.push(`  storeys: ${graph.levels.map((l) => l.level).join(',') || 'none'}`);
  out.push(`  ${graph.multiStorey ? 'multi_storey: true' : 'multi_storey: false'}`);

  for (const level of graph.levels) {
    out.push(`  ${level.level}: {label: ${yamlString(level.label)}, rooms: ${level.nodes.length}}`);
    for (const n of level.nodes) {
      const parts = [`type: ${n.kind}`];
      if (n.name) parts.push(`name: ${yamlString(n.name)}`);
      if (n.wheelchair !== undefined) parts.push(`wheelchair: ${n.wheelchair}`);
      out.push(`    ${n.id}: {${parts.join(', ')}}`);
    }
    for (const e of level.edges) {
      const parts = [`dist: ${e.distM}m`];
      if (e.blocked) parts.push('blocked: true');
      if (e.door) parts.push(`door: ${yamlString(e.door)}`);
      out.push(`    ${e.from}->${e.to}: {${parts.join(', ')}}`);
    }
  }

  for (const v of graph.vertical) {
    const parts = [`type: ${v.kind}`, `levels: [${v.levels.join(',')}]`];
    if (v.wheelchair) parts.push('wheelchair: true');
    if (v.name) parts.push(`name: ${yamlString(v.name)}`);
    out.push(`  ${v.id}: {${parts.join(', ')}}`);
  }

  if (graph.missingLevels.length > 0) {
    out.push(`  missing: [${graph.missingLevels.join(',')}]`);
  }
  for (const o of graph.omitted) {
    out.push(`  omitted: - {level: ${o.level}, note: ${yamlString(o.reason)}}`);
  }
  return out;
}

function nodeBody(n: GraphNode): string {
  const parts: string[] = [];
  parts.push(`type: ${n.kind}`);
  if (n.name) parts.push(`name: ${yamlString(n.name)}`);
  if (n.tags && n.tags.length > 0) {
    parts.push(`tags: [${n.tags.map(yamlString).join(', ')}]`);
  }
  if (n.heightM !== undefined) parts.push(`height: ${n.heightM}m`);
  if (n.lat !== undefined && n.lon !== undefined) {
    parts.push(`at: "${n.lat},${n.lon}"`);
  }
  return `{${parts.join(', ')}}`;
}

function edgeBody(e: GraphEdge, scale: GridScale | undefined): string {
  const parts: string[] = [];
  // The critical decision: emit a distance the model can reason about directly.
  // Metres when the envelope's scale is known, grid units labelled as such when
  // it is not. Applying the scale per axis is what keeps an east-west distance
  // correct in a bbox whose width and height differ.
  const usableScale =
    scale && Number.isFinite(scale.x) && Number.isFinite(scale.y) ? scale : undefined;
  const metres = usableScale ? Math.hypot(e.dx * usableScale.x, e.dy * usableScale.y) : Number.NaN;

  if (Number.isFinite(metres)) {
    parts.push(`dist: ${Math.round(metres)}m`);
  } else if (Number.isFinite(e.dist)) {
    // Scale is unusable, but the raw geometry is sound. Label it as grid units
    // so the agent does not mistake 2048 units for 2048 metres.
    parts.push(`dist: ${Math.round(e.dist)}u`);
  } else {
    // A non-finite distance means the geometry itself is broken. Say so
    // explicitly rather than writing "NaN", which a model will read as a value.
    parts.push('dist: unknown');
  }
  parts.push(`dir: ${e.dir}`);
  if (e.path) parts.push(`path: ${e.path}`);
  if (e.crosswalk) parts.push('crosswalk: true');
  if (e.blocked) parts.push('blocked: true');
  return `{${parts.join(', ')}}`;
}

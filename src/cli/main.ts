#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import {
  VERSION,
  SuperCarto,
  cartoFromEnv,
  decodeDocument,
  encodeDocument,
  estimateTokens,
  fromGeoJson,
  toMaplet,
  encodeBinaryPacked,
  decodeBinaryPacked,
  isScrBinary,
  mainMcp,
  startApiServer,
  type BboxEnvelope,
  type GeoJsonFeatureCollection,
  type MapSource,
} from '../index.js';

interface Flags {
  [key: string]: string | boolean;
}

function parseArgs(argv: string[]): { cmd: string; flags: Flags; positional: string[] } {
  const cmd = argv[0] ?? 'help';
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, flags, positional };
}

function num(v: string | boolean | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`expected a number, got "${String(v)}"`);
  return n;
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function loadJson(path: string | undefined): GeoJsonFeatureCollection {
  const text = path && path !== '-' ? readFileSync(path, 'utf8') : readStdin();
  if (text.trim() === '') {
    throw new Error('no input: pass a file path or pipe JSON on stdin');
  }
  return JSON.parse(text) as GeoJsonFeatureCollection;
}

function writeOut(text: string, out: string | boolean | undefined): void {
  if (out === true || out === undefined) {
    process.stdout.write(text);
  } else {
    writeFileSync(String(out), text, 'utf8');
    process.stderr.write(`wrote ${text.length} bytes to ${String(out)}\n`);
  }
}

const HELP = `supercarto ${VERSION} - LLM-native spatial middleware

USAGE
  supercarto <command> [options]

COMMANDS
  fetch    Fetch live map data around a coordinate and compile it into an
           agent-ready graph. No API key needed.
  route    Turn-by-turn directions between two coordinates.
  weather  Current conditions and forecast at a coordinate. No API key needed.
  traffic  Congestion and realistic arrival time. Needs TOMTOM_API_KEY or
           HERE_API_KEY; without one it reports free-flow and says so.
  compile <file.geojson>   Compile a local GeoJSON file into a YAML map graph.
  encode  <file.geojson>   Compile a local file to the SCR wire format.
  decode  <file.scr>       Inspect an SCR document (text or binary).
  bench   <file.geojson>   Report token cost across budgets.
bench:tasks             Run the task-level accuracy benchmark against
                           GeoJSON and OSM baselines. See docs/benchmark.md.
  bench:arena             Run the benchmark through an Arena Browser session,
                           metered by a call budget and resumable.
                           --budget <n> [--model <slug>] [--seeds <n>] [--dry]
  serve                    Start the HTTP API server.
  mcp                      Start the MCP server on stdio, for agent clients.
  help                     Show this message.

LIVE COMMANDS
  fetch --lat <n> --lon <n> [--radiusM 300] [--budget 1024]
         [--layers road,poi] [--format yaml|json] [--out path]
  route --from <lat,lon> --to <lat,lon> [--mode walk|bike|drive]
  weather --lat <n> --lon <n> [--hours 12] [--format json]
  traffic --from <lat,lon> --to <lat,lon> [--mode drive]
  serve [--port 8787]
  mcp   [--max-tokens 8192]

DATA SOURCES
  PMTILES / SUPERCARTO_PMTILES   URL or path to a PMTiles archive. When set,
                                  it replaces Overpass as the primary source.
                                  Far faster and not rate limited.
  OVERPASS_ENDPOINT              Point at your own Overpass instance.
  TOMTOM_API_KEY / HERE_API_KEY   Enable live traffic conditions.
  SUPERCARTO_NO_TERRAIN=1         Disable elevation lookups.

COMMON OPTIONS
  --budget <n>       Target token budget for the output (default 1024)
  --layers <a,b,c>   Keep only these layers
  --bbox <w,s,e,n>   Force the envelope instead of deriving it
  --out <path>       Write to a file instead of stdout
  --radius <label>   Radius label for the map metadata, e.g. 250m
  --codec <c>        Binary encode/decode: raw | gzip | brotli | zstd
  --metrics          Print token metrics to stderr

NOTES
  Live data comes from the public Overpass API by default, which is rate
  limited and slow. Set PMTILES for production.
  The wire format (SCR) is for machines; the YAML graph is for the model.
  A maplet tells the agent which tools this deployment can actually answer.
`;

async function main(): Promise<void> {
  const { cmd, flags, positional } = parseArgs(process.argv.slice(2));

  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return;

    case 'fetch': {
      const lat = num(flags.lat, NaN);
      const lon = num(flags.lon, NaN);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new Error('fetch requires --lat and --lon');
      }
      const carto = buildCarto(flags);
      const budget = num(flags.budget, 1024);
      const layers = typeof flags.layers === 'string'
        ? flags.layers.split(',').map((s) => s.trim())
        : undefined;

      process.stderr.write(
        `fetching live map data around ${lat},${lon} (${num(flags.radiusM, 300)}m)...\n`,
      );

      const result = await carto.maplet({
        lat,
        lon,
        radiusM: num(flags.radiusM, 300),
        layers,
        budget,
      });

      if (flags.format === 'json') {
        writeOut(
          JSON.stringify(
            {
              yaml: result.yaml,
              metrics: result.metrics,
              fetchedFrom: result.fetchedFrom,
              fetchMs: result.fetchMs,
              warnings: result.warnings,
              sourceTruncated: result.sourceTruncated,
            },
            null,
            2,
          ) + '\n',
          flags.out,
        );
      } else {
        writeOut(result.yaml, flags.out);
      }
      process.stderr.write(
        `tokens ${result.metrics.yamlTokens}/${budget}  nodes ${result.graph.nodes.length}  ` +
          `edges ${result.graph.edges.length}  from ${result.fetchedFrom} in ${result.fetchMs}ms\n`,
      );
      if (result.sourceTruncated) {
        process.stderr.write('note: source hit its feature cap; this area is denser than the cap allows\n');
      }
      for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);
      return;
    }

    case 'route': {
      const from = parseLatLon(String(flags.from ?? ''));
      const to = parseLatLon(String(flags.to ?? ''));
      if (!from || !to) throw new Error('route requires --from <lat,lon> and --to <lat,lon>');
      const carto = buildCarto(flags);
      const res = await carto.route({
        from,
        to,
        mode: (typeof flags.mode === 'string' ? flags.mode : 'walk') as 'walk' | 'bike' | 'drive',
      });
      const lines = [
        `route (${res.route.mode}) via ${res.source}`,
        `total ${res.route.dist ?? '?'}m, ${res.route.time ?? '?'}s`,
        '',
      ];
      for (const s of res.route.steps) {
        lines.push(`${s.n}. ${s.instruction}${s.dist !== undefined ? ` (${s.dist}m)` : ''}`);
      }
      writeOut(lines.join('\n') + '\n', flags.out);
      return;
    }

    case 'weather': {
      const lat = num(flags.lat, NaN);
      const lon = num(flags.lon, NaN);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new Error('weather requires --lat and --lon');
      }
      const carto = buildCarto(flags);
      const w = await carto.weatherAt(lat, lon, num(flags.hours, 12));
      if (!w) throw new Error('weather is not configured');
      if (w.degraded) {
        process.stderr.write(`weather unavailable: ${w.degraded}\n`);
        process.exitCode = 1;
        return;
      }
      if (flags.format === 'json') {
        writeOut(JSON.stringify(w, null, 2) + '\n', flags.out);
        return;
      }
      const lines = [
        `now  ${w.now.summary}, ${round1(w.now.tempC)}C (feels ${round1(w.now.feelsLikeC)}C), ` +
          `wind ${round1(w.now.windKmh)}km/h, precip ${w.now.precipitation}`,
      ];
      for (const h of w.hourly.slice(0, num(flags.hours, 12))) {
        lines.push(
          `  ${h.at}  ${round1(h.tempC)}C  ${pad(w.now.precipitation === 'none' ? h.precipitation : h.precipitation)}` +
            `  ${round1(h.windKmh)}km/h`,
        );
      }
      for (const d of w.daily) {
        lines.push(
          `  ${d.date}  ${round1(d.tempMinC)}-${round1(d.tempMaxC)}C  ` +
            `${round1(d.precipitationMm)}mm  ${Math.round(d.precipitationProbPct)}% chance`,
        );
      }
      writeOut(lines.join('\n') + '\n', flags.out);
      return;
    }

    case 'traffic': {
      const from = parseLatLon(String(flags.from ?? ''));
      const to = parseLatLon(String(flags.to ?? ''));
      if (!from || !to) throw new Error('traffic requires --from <lat,lon> and --to <lat,lon>');
      const carto = buildCarto(flags);
      const res = await carto.routeWithTraffic({
        from,
        to,
        mode: (typeof flags.mode === 'string' ? flags.mode : 'drive') as 'walk' | 'bike' | 'drive',
      });
      if (flags.format === 'json') {
        writeOut(JSON.stringify(res, null, 2) + '\n', flags.out);
        return;
      }
      const lines: string[] = [];
      if (res.freeFlowOnly) {
        lines.push('traffic: unknown (no flow source configured)');
        lines.push(`free-flow estimate: ${res.freeFlowS}s, ignores congestion`);
        lines.push(`note: ${res.unavailable ?? ''}`);
      } else {
        lines.push(`traffic ${res.level}, worst segment ${res.worstLevel}`);
        lines.push(
          `${res.durationS}s including ${res.delayS}s delay (free flow ${res.freeFlowS}s)`,
        );
        for (const s of res.segments.filter((x) => x.level === 'heavy' || x.level === 'severe').slice(0, 5)) {
          lines.push(`  ${s.level}${s.road ? ` on ${s.road}` : ''}`);
        }
        lines.push(`source: ${res.source}`);
      }
      writeOut(lines.join('\n') + '\n', flags.out);
      return;
    }

case 'bench:tasks': {
      const { mainBenchTasks } = await import('../bench/cli.js');
      process.exitCode = await mainBenchTasks(process.argv.slice(3));
      break;
    }
    case 'bench:arena': {
      const { runBench } = await import('../bench/cli-run.js');
      process.exitCode = await runBench(process.argv.slice(3));
      break;
    }
    case 'bench:opencode': {
      const { runBench } = await import('../bench/cli-run.js');
      process.exitCode = await runBench(process.argv.slice(3), { driver: 'opencode' });
      break;
    }

    case 'serve': {
      startApiServer(num(flags.port, 8787), { carto: buildCarto(flags) });
      return;
    }

    case 'mcp': {
      mainMcp();
      return;
    }

    case 'compile': {
      const gj = loadJson(positional[0]);
      const bbox = typeof flags.bbox === 'string' ? parseBbox(flags.bbox) : undefined;
      const layers =
        typeof flags.layers === 'string' ? flags.layers.split(',').map((s) => s.trim()) : undefined;

      const result = toMaplet(gj, {
        bbox,
        layers,
        budget: num(flags.budget, 1024),
        radiusLabel: typeof flags.radius === 'string' ? flags.radius : undefined,
        compile: {
          weld: flags.weld === undefined ? undefined : num(flags.weld, 2),
        },
        emit: { includeTools: flags.tools !== false },
      });

      writeOut(result.yaml, flags.out);
      if (flags.metrics) {
        const m = result.metrics;
        process.stderr.write(
          `tokens ${m.yamlTokens}/${m.budget}  nodes ${m.nodes}  edges ${m.edges}  ` +
            `dropped ${m.droppedNodes}  wire ${m.wireBytes}B\n`,
        );
      }
      return;
    }

    case 'encode': {
      const codec = typeof flags.codec === 'string' ? (flags.codec as 'raw' | 'gzip' | 'brotli' | 'zstd') : undefined;
      if (codec) {
        const gj = loadJson(positional[0]);
        const bbox = typeof flags.bbox === 'string' ? parseBbox(flags.bbox) : undefined;
        const doc = fromGeoJson(gj, bbox ? { envelope: bbox } : {});
        const packed = encodeBinaryPacked(doc, codec ? { codec } : {});
        if (typeof flags.out === 'string') {
          writeFileSync(flags.out, packed);
          process.stderr.write(
            `wrote ${packed.length} binary bytes to ${flags.out} (${codec})\n`,
          );
        } else {
          // stdout is text, so binary goes to a file. Writing raw bytes to a
          // terminal would corrupt it.
          process.stderr.write(
            `--codec requires --out <path>; refusing to write binary to stdout\n`,
          );
          process.exitCode = 1;
        }
        return;
      }

      const gj = loadJson(positional[0]);
      const bbox = typeof flags.bbox === 'string' ? parseBbox(flags.bbox) : undefined;
      const result = toMaplet(gj, { bbox, budget: num(flags.budget, 1_000_000) });
      // Re-encode with grouping off: this output is for machines, and grouping
      // is a readability cost with no benefit here.
      writeOut(encodeDocument(result.doc, { group: false }), flags.out);
      return;
    }

    case 'decode': {
      const raw =
        positional[0] && positional[0] !== '-'
          ? new Uint8Array(readFileSync(positional[0]))
          : new Uint8Array(Buffer.from(readStdin(), 'utf8'));

      // Binary and text are distinguished by the frame marker, so a caller can
      // hand `decode` either without saying which.
      const bytes = new Uint8Array(raw);
      const doc = isScrBinary(bytes) ? decodeBinaryPacked(bytes) : decodeDocument(new TextDecoder().decode(bytes));
      const summary = {
        version: doc.version,
        envelope: doc.envelope,
        projection: doc.projection,
        extent: doc.extent,
        buffer: doc.buffer,
        meta: doc.meta,
        layers: [...doc.layers.values()].map((l) => l.name),
        classes: doc.classes.size,
        strings: doc.strings.size,
        attributeSets: doc.attrSets.size,
        features: doc.features.length,
        heatLayers: doc.heat.length,
        omissions: doc.omissions,
        refs: doc.refs,
        routes: doc.routes.length,
        encoding: isScrBinary(bytes) ? 'binary' : 'text',
        estimatedTokens: estimateTokens(new TextDecoder().decode(raw)),
        bytes: raw.length,
      };
      writeOut(JSON.stringify(summary, null, 2) + '\n', flags.out);
      return;
    }

    case 'bench': {
      const gj = loadJson(positional[0]);
      const raw = JSON.stringify(gj);
      const rawTokens = estimateTokens(raw);

      const bbox = typeof flags.bbox === 'string' ? parseBbox(flags.bbox) : undefined;
      const doc = fromGeoJson(gj, bbox ? { envelope: bbox } : {});

      const lines: string[] = [];
      lines.push(`source      ${(Buffer.byteLength(raw) / 1024).toFixed(1)} KB raw GeoJSON, ~${rawTokens} tokens`);
      lines.push(`compacted   ${doc.features.length} features, ${doc.layers.size} layers`);

      const scr = encodeDocument(doc, { group: false });
      lines.push(
        `SCR wire    ${(Buffer.byteLength(scr) / 1024).toFixed(1)} KB, ~${estimateTokens(scr)} tokens`,
      );
      lines.push('');
      lines.push('budget   tokens   nodes  edges  dropped   vs raw');
      lines.push('-------  ------  -----  -----  -------  -------');

      for (const budget of [256, 512, 1024, 2048, 4096, 8192]) {
        // Go through the pipeline, not the raw budgeter: the pipeline verifies
        // the emitted output against the budget, and reporting its internal
        // estimate here would overstate what a caller actually receives.
        const result = toMaplet(gj, { bbox, budget });
        const saved = ((1 - result.metrics.yamlTokens / rawTokens) * 100).toFixed(1);
        lines.push(
          `${String(budget).padStart(7)}  ${String(result.metrics.yamlTokens).padStart(6)}  ` +
            `${String(result.metrics.nodes).padStart(5)}  ${String(result.metrics.edges).padStart(5)}  ` +
            `${String(result.metrics.droppedNodes).padStart(7)}  ${String(`${saved}%`).padStart(7)}`,
        );
      }
      process.stderr.write(lines.join('\n') + '\n');
      return;
    }

    default:
      process.stderr.write(`unknown command "${cmd}"\n\n${HELP}`);
      process.exitCode = 1;
  }
}

function round1(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '?';
  return String(Math.round(n * 10) / 10);
}

function pad(s: string): string {
  return s.padEnd(8, ' ');
}

function parseLatLon(text: string): { lat: number; lon: number } | undefined {
  const parts = text.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return undefined;
  return { lat: parts[0]!, lon: parts[1]! };
}

/**
 * Build a SuperCarto instance from flags and the environment.
 *
 * A thin wrapper over the shared factory. It used to construct its own sources,
 * which is how the CLI and the MCP server ended up disagreeing about where map
 * data came from - the CLI learned to read PMTiles and the server did not, and
 * an operator had no way to see the difference.
 */
function buildCarto(flags: Flags): SuperCarto {
  return cartoFromEnv({
    ...(typeof flags.pmtiles === 'string' ? { pmtiles: flags.pmtiles } : {}),
    ...(typeof flags.overpass === 'string' ? { overpass: flags.overpass } : {}),
    ...(typeof flags.elevation === 'string' ? { elevation: flags.elevation } : {}),
    ...(flags.overpassFallback === false ? { overpassFallback: false } : {}),
  });
}

function parseBbox(text: string): BboxEnvelope {
  const parts = text.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`--bbox must be "west,south,east,north", got "${text}"`);
  }
  return {
    type: 'bbox',
    west: parts[0]!,
    south: parts[1]!,
    east: parts[2]!,
    north: parts[3]!,
  };
}

try {
  await main();
} catch (err) {
  process.stderr.write(`supercarto: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}

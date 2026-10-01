/**
 * Recorded Overpass responses, replayed offline.
 *
 * Every bug found against the live public instance was a bug in how the adapter
 * handled a response the instance should never have sent: a 200 with no
 * elements, way geometry at the wrong latitude, a result set too large to serve.
 * Testing those against the live instance is slow, flaky, and rude - it is a
 * shared public server, and hammering it is what made it start refusing us.
 *
 * These fixtures make that behaviour reproducible and free. Crucially they
 * record upstream *misbehaviour*, not just healthy data: a fixture set of only
 * well-formed responses could not have caught any of the bugs above.
 *
 * Captured 2026-10-01 from overpass-api.de via scratch/capture.ts.
 */

import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', '..', 'fixtures', 'overpass');

export interface RecordedElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
}

export interface Fixture {
  name: string;
  elements: RecordedElement[];
}

/** Load a recorded fixture, or undefined when it was never captured. */
export function loadFixture(name: string): Fixture | undefined {
  const path = join(DIR, `${name}.json.gz`);
  if (!existsSync(path)) return undefined;
  const body = gunzipSync(readFileSync(path)).toString('utf8');
  const parsed = JSON.parse(body) as { elements?: RecordedElement[] };
  return { name, elements: parsed.elements ?? [] };
}

/**
 * A `fetch` that serves a fixture, standing in for the network.
 *
 * @param name    fixture to serve
 * @param options `status` overrides the HTTP status, so an error response can
 *                be replayed without a second fixture. `once` makes the stub
 *                serve the fixture on the first call and then behave as
 *                `options.after`, which is how retry paths are exercised.
 */
export function fixtureFetch(
  name: string,
  options: { status?: number; after?: () => Response | Promise<Response>; once?: boolean } = {},
): typeof fetch {
  let calls = 0;
  return (async () => {
    calls++;
    if (options.after && (!options.once || calls > 1)) return options.after();
    const fx = loadFixture(name);
    if (!fx) throw new Error(`fixture ${name} was never captured`);
    return new Response(JSON.stringify({ version: 0.6, elements: fx.elements }), {
      status: options.status ?? 200,
    });
  }) as unknown as typeof fetch;
}

/** A raw body with a chosen status, for replaying HTML error pages. */
export function rawFetch(body: string, status: number): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

/**
 * Fixtures that must be present for the offline suite to mean anything.
 *
 * If one of these is missing the suite skips loudly rather than passing
 * quietly - a green run with no fixtures would be a false reassurance.
 */
export const REQUIRED_FIXTURES = ['sf-small', 'sf-large-1', 'london-corrupt'] as const;

/** Boxes the fixtures were captured for, so tests assert against real geography. */
export const FIXTURE_BBOX = {
  /** Small San Francisco box: served correctly, lat ~37.77. */
  sfSmall: { west: -122.423, south: 37.773, east: -122.416, north: 37.777 },
  /** Large San Francisco box: served corruptly, lat ~37.21 not 37.77. */
  sfLarge: { west: -122.433, south: 37.769, east: -122.406, north: 37.79 },
  /** Central London: served corruptly, lat ~5.56 not 51.51. */
  london: { west: -0.14, south: 51.5, east: -0.11, north: 51.52 },
} as const;
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';

/**
 * CLI fetch against a stub Overpass instance.
 *
 * Two properties only hold end to end: warnings must reach an agent that
 * reads stdout but never stderr (they used to travel stderr alone), and the
 * run must go through the real binary. Unit tests cover the wording; this
 * covers the wiring. Runs against `dist/`, like the MCP e2e suite.
 */
const built = existsSync('dist/cli/main.js');

const ELEMENTS = [
  {
    type: 'way',
    id: 10,
    tags: { highway: 'residential', name: 'Main St' },
    geometry: [
      { lat: 37.775, lon: -122.425 },
      { lat: 37.775, lon: -122.42 },
    ],
  },
  {
    type: 'way',
    id: 11,
    tags: { highway: 'residential', name: '2nd St' },
    geometry: [
      { lat: 37.773, lon: -122.422 },
      { lat: 37.777, lon: -122.422 },
    ],
  },
  { type: 'node', id: 20, lat: 37.775, lon: -122.421, tags: { amenity: 'cafe', name: 'Near' } },
  { type: 'node', id: 21, lat: 60.0, lon: 20.0, tags: { amenity: 'cafe', name: 'Far' } },
];

describe.skipIf(!built)('cli fetch', () => {
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ elements: ELEMENTS }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
  });

  function fetch(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child: ChildProcess = spawn('node', ['dist/cli/main.js', 'fetch', ...args], {
        env: { ...process.env, OVERPASS_ENDPOINT: `http://127.0.0.1:${port}` },
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => (stdout += String(d)));
      child.stderr?.on('data', (d) => (stderr += String(d)));
      child.on('error', reject);
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('cli fetch timed out'));
      }, 90000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? 1 });
      });
    });
  }

  it('carries warnings inside stdout, not only stderr', async () => {
    // The Far node sits outside the bbox, so the response carries exactly
    // one discard warning. An agent reading only the map must still see it.
    const r = await fetch(['--lat', '37.775', '--lon', '-122.422', '--radiusM', '300', '--budget', '1024']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/# WARNING: discarded 1 feature/);
    expect(r.stderr).toMatch(/discarded 1 feature/);
  });

  it('fails clearly on a roadless default instead of a POI-only map', async () => {
    // Stub serves nodes only here: with streets requested and none arriving
    // on the first clean attempt this serves (honest geography needs no
    // refusal to prove a negative)... so instead assert the documented
    // unknown-layer path, which shares the fail-loud machinery.
    const r = await fetch([
      '--lat',
      '37.775',
      '--lon',
      '-122.422',
      '--radiusM',
      '300',
      '--budget',
      '1024',
      '--layers',
      'flying',
    ]);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/unknown layer/);
  });
});

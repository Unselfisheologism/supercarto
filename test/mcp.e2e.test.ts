import { describe, expect, it, beforeAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';

/**
 * End-to-end tests for the MCP server as a real process.
 *
 * These exist because every other MCP test calls the server in-process, which
 * cannot see the transport. Three of the failure modes that matter most only
 * appear when messages arrive on a real pipe:
 *
 *  - stdout pollution. A stray `console.log` anywhere in the module graph
 *    corrupts the JSON-RPC stream and the client stops working, with no error
 *    pointing at the cause.
 *  - chunk boundaries. A request split across two writes must be reassembled;
 *    several requests coalesced into one write must be split.
 *  - lifetime. The server must answer a tail message with no trailing newline,
 *    and must exit when its stdin closes, or the host hangs on shutdown.
 *
 * The suite runs against `dist/`, so `npm run build` must precede it.
 */

const SERVER = ['dist/cli/main.js', 'mcp'];
const built = existsSync('dist/cli/main.js');

interface Harness {
  child: ChildProcess;
  lines: string[];
  invalid: string[];
  send(req: unknown): Promise<any>;
  /** Resolve once `n` stdout lines have arrived, or the timeout expires. */
  settle(n: number, ms?: number): Promise<void>;
  exited(ms?: number): Promise<boolean>;
}

function harness(): Harness {
  const child = spawn('node', SERVER, { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines: string[] = [];
  const invalid: string[] = [];
  const pending = new Map<number, (v: any) => void>();

  createInterface({ input: child.stdout }).on('line', (line) => {
    if (line.trim() === '') return;
    lines.push(line);
    try {
      const msg = JSON.parse(line);
      const id = msg?.id;
      if (typeof id === 'number') {
        pending.get(id)?.(msg);
        pending.delete(id);
      }
    } catch {
      // Anything unparseable on stdout is protocol corruption, not a response.
      invalid.push(line);
    }
  });

  const settle = (n: number, ms = 20000) =>
    new Promise<void>((resolve) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        if (lines.length >= n || Date.now() - t0 > ms) {
          clearInterval(tick);
          resolve();
        }
      }, 25);
    });

  const send = (req: Record<string, unknown>, timeoutMs = 20000): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = req.id as number;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no response for id=${id}`));
      }, timeoutMs);
      pending.set(id, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      child.stdin!.write(`${JSON.stringify(req)}\n`);
    });

  const exited = (ms = 15000): Promise<boolean> => {
    // The process may already be gone, in which case no exit event is coming.
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return Promise.race([
      new Promise<boolean>((r) => child.once('exit', () => r(true))),
      new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
    ]);
  };

  return { child, lines, invalid, send, settle, exited };
}

describe.skipIf(!built)('MCP server over a real pipe', () => {
  let h: Harness;

  beforeAll(() => {
    expect(built, 'run `npm run build` before these tests').toBe(true);
  });

  it('completes the handshake and advertises its tools', async () => {
    h = harness();
    const init = await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(init.result.serverInfo.name).toBe('supercarto');
    expect(typeof init.result.protocolVersion).toBe('string');
    expect(init.result.capabilities.tools).toBeDefined();

    const list = await h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['get_maplet', 'route', 'search_places', 'expand_feature']),
    );
    for (const t of list.result.tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.description.length).toBeGreaterThan(20);
    }
    h.child.kill();
  });

  it('says nothing in reply to a notification', async () => {
    h = harness();
    await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const before = h.lines.length;
    h.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    await new Promise((r) => setTimeout(r, 400));
    // Replying to a notification with a response id confuses strict clients.
    expect(h.lines.length).toBe(before);
    h.child.kill();
  });

  it('reassembles a request split across writes', async () => {
    h = harness();
    const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    h.child.stdin!.write(req.slice(0, 20));
    await new Promise((r) => setTimeout(r, 250));
    h.child.stdin!.write(`${req.slice(20)}\n`);
    await h.settle(1);
    expect(h.lines).toHaveLength(1);
    expect(JSON.parse(h.lines[0]!).id).toBe(1);
    h.child.kill();
  });

  it('splits several messages arriving in one write', async () => {
    h = harness();
    h.child.stdin!.write(
      [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
      ].join('\n') + '\n',
    );
    await h.settle(3);
    expect(h.lines).toHaveLength(3);
    expect(h.invalid).toHaveLength(0);
    h.child.kill();
  });

  it('answers a tail message that has no trailing newline, then exits', async () => {
    h = harness();
    h.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    const exiting = h.exited();
    h.child.stdin!.end();
    await h.settle(1);
    expect(JSON.parse(h.lines[0]!).result).toEqual({});
    // The host stops a server by closing stdin. Hanging here leaves the host
    // waiting on a process that will never exit.
    expect(await exiting).toBe(true);
  });

  it('exits on an empty EOF with no request at all', async () => {
    h = harness();
    await new Promise((r) => setTimeout(r, 1200));
    const exiting = h.exited();
    h.child.stdin!.end();
    expect(await exiting).toBe(true);
  });

  it('reports malformed JSON as a protocol error and keeps serving', async () => {
    h = harness();
    h.child.stdin!.write('{not json\n');
    await h.settle(1);
    const err = JSON.parse(h.lines[0]!);
    expect(err.id).toBeNull();
    expect(err.error.code).toBe(-32700);

    // A parse error must not poison the session.
    const after = await h.send({ jsonrpc: '2.0', id: 9, method: 'ping' });
    expect(after.result).toEqual({});
    h.child.kill();
  });

  it('keeps stdout pure JSON-RPC throughout a session', async () => {
    h = harness();
    await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    await h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const bad = await h.send({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    });
    expect(bad.result.isError).toBe(true);
    expect(h.invalid).toHaveLength(0);
    h.child.kill();
  });

  it('returns agent-readable errors for bad arguments', async () => {
    h = harness();
    await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const res = await h.send({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'get_maplet', arguments: { lat: 'north', lon: 0 } },
    });
    // A tool error is what the model sees; a thrown exception would surface as
    // a protocol failure instead.
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/lat/);
    h.child.kill();
  });

  it('answers get_daylight without any source configured', async () => {
    // Daylight is arithmetic, not a lookup, so it must work on a deployment
    // with no elevation, weather, or traffic source. This is the test that
    // would fail if the tool were accidentally gated behind a capability.
    h = harness();
    await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const res = await h.send({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'get_daylight',
        arguments: { lat: 37.77, lon: -122.42, at: '2026-06-21T20:00:00Z' },
      },
    });
    expect(res.result.isError).toBeFalsy();
    const text = res.result.content[0].text as string;
    expect(text).toMatch(/elevation:/);
    // Three states, and the answer is in words rather than a bare boolean.
    expect(text).toMatch(/state: (day|civil|nautical|night)/);
    expect(text).toMatch(/needs light: (yes|no)/);
    // Solar noon in San Francisco in June, so both times are real.
    expect(text).toMatch(/sunrise: 2026-06-21T/);
    expect(text).toMatch(/sunset: 2026-06-2\dT/);
    h.child.kill();
  });

  it('reports polar night rather than inventing a sunrise', async () => {
    h = harness();
    await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const res = await h.send({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'get_daylight',
        arguments: { lat: 78.2, lon: 15.6, at: '2026-12-21T11:00:00Z' },
      },
    });
    const text = res.result.content[0].text as string;
    expect(text).toMatch(/polar night/);
    expect(text).not.toMatch(/sunrise:/);
    h.child.kill();
  });

  it('rejects an unparseable instant instead of guessing one', async () => {
    h = harness();
    await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const res = await h.send({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'get_daylight', arguments: { lat: 0, lon: 0, at: 'next tuesday' } },
    });
    expect(res.result.isError).toBe(true);
    h.child.kill();
  });
});
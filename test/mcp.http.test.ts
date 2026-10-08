import { describe, expect, it } from 'vitest';
import { McpHttpServer, strictSessionsFrom } from '../src/server/http-mcp.js';
import { McpStdioServer } from '../src/server/stdio.js';
import { SuperCarto } from '../src/index.js';

/**
 * Streamable HTTP transport.
 *
 * stdio is unreachable to anything that is not a parent process, which excludes
 * every harness worth being tested by. These tests pin the parts a strict client
 * actually depends on: the two response forms the spec allows, the 406 when the
 * client will not say what it accepts, and 202 for a notification-only batch.
 */

const carto = () => new SuperCarto();

async function withServer(fn: (s: McpHttpServer, url: string) => Promise<void>): Promise<void> {
  const server = new McpHttpServer({ carto: carto(), port: 0 });
  const { url } = await server.listen();
  try {
    await fn(server, url);
  } finally {
    await server.close();
  }
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
};

describe('mcp over streamable http', () => {
  it('answers initialize over POST and issues a session id', async () => {
    await withServer(async (_s, url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(INIT),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: { serverInfo: { name: string } } };
      expect(body.result.serverInfo.name).toBe('supercarto');
      expect(res.headers.get('mcp-session-id')).toMatch(/^sc-/);
    });
  });

  it('lists the same tools as the stdio server', async () => {
    // Two tool sets would mean a client sees different capabilities depending on
    // transport, which is the kind of bug that only appears in someone else's CI.
    const http = new McpHttpServer({ carto: carto(), port: 0 });
    const stdio = new McpStdioServer({ carto: carto() });
    expect(http.listTools().map((t) => t.name)).toEqual(stdio.listTools().map((t) => t.name));
  });

  it('serves tools/list as JSON', async () => {
    await withServer(async (_s, url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });
      const body = (await res.json()) as { result: { tools: { name: string }[] } };
      expect(body.result.tools.length).toBeGreaterThan(0);
      expect(body.result.tools.map((t) => t.name)).toContain('get_maplet');
    });
  });

  it('serves the same request as SSE when the client asks for text/event-stream', async () => {
    await withServer(async (_s, url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const text = await res.text();
      expect(text).toContain('data: ');
      // The payload inside the event must still be valid JSON-RPC.
      const line = text.split('\n').find((l) => l.startsWith('data: '))!;
      const parsed = JSON.parse(line.slice(6)) as { result: { tools: unknown[] } };
      expect(parsed.result.tools.length).toBeGreaterThan(0);
    });
  });

  it('returns 406 when the client will not say what it accepts', async () => {
    // Guessing is how a transport bug presents as "the server ignores me".
    await withServer(async (_s, url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/plain' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
      });
      expect(res.status).toBe(406);
    });
  });

  it('returns 202 with no body for a notification-only request', async () => {
    await withServer(async (_s, url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      expect(res.status).toBe(202);
      expect(await res.text()).toBe('');
    });
  });

  it('answers a JSON-RPC batch as an array', async () => {
    await withServer(async (_s, url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 5, method: 'ping' },
          { jsonrpc: '2.0', id: 6, method: 'tools/list' },
        ]),
      });
      const body = (await res.json()) as unknown[];
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
    });
  });

  it('rejects a malformed body with a parse error, not a crash', async () => {
    await withServer(async (_s, url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: '{not json',
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: number } };
      expect(body.error.code).toBe(-32700);
    });
  });

  it('reports a missing tool as a tool error, not a protocol error', async () => {
    await withServer(async (_s, url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'no_such_tool', arguments: {} },
        }),
      });
      const body = (await res.json()) as { result: { isError: boolean } };
      expect(body.result.isError).toBe(true);
    });
  });

  it('serves a health probe an operator can hit without speaking MCP', async () => {
    await withServer(async (_s, url) => {
      const res = await fetch(url.replace(/\/mcp$/, '/health'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { transport: string; tools: number };
      expect(body.transport).toBe('streamable-http');
      expect(body.tools).toBeGreaterThan(0);
    });
  });

  it('rejects GET on the JSON-RPC path with 405 and an Allow header', async () => {
    await withServer(async (_s, url) => {
      const res = await fetch(url);
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toContain('POST');
    });
  });

  it('404s an unknown route rather than answering it', async () => {
    await withServer(async (_s, url) => {
      const res = await fetch(url.replace(/\/mcp$/, '/nope'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' }),
      });
      expect(res.status).toBe(404);
    });
  });

  it('completes a full client handshake, echoing the session id back', async () => {
    // The sequence a strict client actually performs. It shipped broken: the CLI
    // passed `allowForeignSessions: flag === 'true'`, which inverts the flag, so the
    // default run rejected the very session id it had just issued and a strict
    // client could not get past `initialize`. The unit tests missed it because
    // they construct the server directly and never exercise the CLI wiring.
    await withServer(async (_s, url) => {
      const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

      const init = await fetch(url, {
        method: 'POST',
        headers: h,
        body: JSON.stringify(INIT),
      });
      const sid = init.headers.get('mcp-session-id');
      expect(sid).toBeTruthy();

      // The initialized notification, carrying the session id the server issued.
      const notif = await fetch(url, {
        method: 'POST',
        headers: { ...h, 'mcp-session-id': sid! },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      expect(notif.status).toBe(202);

      const list = await fetch(url, {
        method: 'POST',
        headers: { ...h, 'mcp-session-id': sid! },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });
      expect(list.status).toBe(200);
      const body = (await list.json()) as { result: { tools: unknown[] } };
      expect(body.result.tools.length).toBeGreaterThan(0);
    });
  });

  it('reads --strict-sessions so that strict means reject, not accept', () => {
    // The inversion this pins: strict=true must reject unknown sessions.
    expect(strictSessionsFrom([])).toBe(false);
    expect(strictSessionsFrom(['--strict-sessions', 'true'])).toBe(true);
    expect(strictSessionsFrom(['--strict-sessions', 'false'])).toBe(false);
    expect(strictSessionsFrom(['--strict-sessions'])).toBe(true);
  });

  it('accepts a foreign session id, because it keeps no session state', async () => {
    // Strict mode is opt-in. A stateless server has nothing to protect, and
    // rejecting a client's own id helps nobody.
    await withServer(async (_s, url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'mcp-session-id': 'from-another-client',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
      });
      expect(res.status).toBe(200);
    });
  });
});
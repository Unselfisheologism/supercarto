import process from 'node:process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { SuperCarto } from '../live.js';
import { cartoFromEnv } from '../config.js';
import { McpStdioServer, type StdioServerOptions } from './stdio.js';

/**
 * MCP over Streamable HTTP.
 *
 * The stdio server speaks the protocol correctly but is unreachable to anything
 * that is not a parent process. That excludes every harness worth running
 * against: GABench expects an HTTP MCP server, and MCP-Atlas / MCP-Universe
 * connect to an endpoint. So this is not a convenience feature, it is the
 * difference between being testable by other people and not.
 *
 * ## What the transport requires
 *
 * Per the Streamable HTTP spec, one endpoint (`POST /mcp`) carries JSON-RPC in a
 * POST body, and the server answers in one of two ways:
 *
 *  - **JSON**, when `Accept` includes `application/json`.
 *  - **SSE**, when `Accept` includes `text/event-stream`. The response is a
 *    `text/event-stream` whose body carries `data:` lines, and may be terminated
 *    by closing the connection.
 *
 * Both are implemented because strict clients negotiate on `Accept` and a server
 * that only speaks JSON returns 406 to them.
 *
 * ## Session handling
 *
 * A stateful server assigns a session id at `initialize` and requires it on every
 * later request via `Mcp-Session-Id`. A stateless server ignores it. This one is
 * **stateless by default**: each POST is self-contained and there is no
 * per-session state to lose, so a load balancer needs no affinity and a restart
 * drops nothing.
 *
 * The counter-argument is real and worth stating: some clients send
 * `notifications/initialized` and then expect the server to remember the
 * negotiation. A stateless server treats that as a no-op, which is correct but
 * means a client that requires session affinity will not work. That is a
 * deliberate trade, not an oversight.
 *
 * ## Why not keep stdio as the only path
 *
 * Both are supported. `supercarto mcp` is stdio; `supercarto mcp-http` is this.
 * A single-connection stdio server is still the lowest-latency option for a local
 * agent, and nothing about HTTP makes it better for that case.
 */

const PROTOCOL_VERSION = '2024-11-05';
const JSONRPC_VERSION = '2.0';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface HttpServerOptions extends StdioServerOptions {
  /** Defaults to 127.0.0.1, not 0.0.0.0. */
  host?: string;
  /** Defaults to 8788, one above the REST server so both can run. */
  port?: number;
  /**
   * Accept requests bearing a session id this server did not issue.
   *
   * True by default, and correct for a stateless server: the id is informational.
   */
  allowForeignSessions?: boolean;
}

/** One JSON-RPC message, or a batch of them. */
function normalise(body: unknown): JsonRpcRequest[] {
  if (Array.isArray(body)) return body as JsonRpcRequest[];
  if (body && typeof body === 'object') return [body as JsonRpcRequest];
  return [];
}

export class McpHttpServer {
  private readonly delegate: McpStdioServer;
  private readonly host: string;
  private readonly port: number;
  private readonly allowForeignSessions: boolean;
  private readonly sessions = new Set<string>();
  private server: ReturnType<typeof createServer> | null = null;

  constructor(opts: HttpServerOptions = {}) {
    this.delegate = new McpStdioServer(opts);
    this.host = opts.host ?? '127.0.0.1';
    this.port = opts.port ?? 8788;
    this.allowForeignSessions = opts.allowForeignSessions ?? true;
  }

  /** Tool descriptors, so a test can assert parity with the stdio server. */
  listTools(): ReturnType<McpStdioServer['listTools']> {
    return this.delegate.listTools();
  }

  /** Handle one POST body, returning the JSON-RPC responses (empty for notifications). */
  async handleBody(body: unknown): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (const req of normalise(body)) {
      const res = await this.delegate.handle(req as never);
      if (res !== null) out.push(res);
    }
    return out;
  }

  /**
   * The session id to hand back, if this request was an `initialize`.
   *
   * Issued even though the server is stateless, because clients that send the
   * header unconditionally should not be rejected on the first request.
   */
  private issueSession(): string {
    const id = `sc-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    this.sessions.add(id);
    // Bounded: a stateless server does not need to remember these, so keeping an
    // unbounded set would be a leak dressed up as bookkeeping.
    if (this.sessions.size > 256) {
      const oldest = this.sessions.values().next().value;
      if (oldest) this.sessions.delete(oldest);
    }
    return id;
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Health check first, so an operator can probe the port without speaking MCP.
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          server: 'supercarto',
          transport: 'streamable-http',
          protocolVersion: PROTOCOL_VERSION,
          tools: this.listTools().length,
        }),
      );
      return;
    }

    if (req.method !== 'POST') {
      // 405 with an Allow header, which is what the spec asks for.
      res.writeHead(405, { allow: 'POST, GET', 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'use POST for JSON-RPC, GET /health for a probe' }));
      return;
    }

    const url = (req.url ?? '/').split('?')[0]!;
    if (url !== '/mcp' && url !== '/') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `no route for ${url}` }));
      return;
    }

    const session = req.headers['mcp-session-id'];
    if (typeof session === 'string' && !this.sessions.has(session) && !this.allowForeignSessions) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown session' }));
      return;
    }

    const chunks: Buffer[] = [];
    let tooLarge = false;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      chunks.push(buf);
      // A maplet is bounded by its own token budget, so this ceiling is generous.
      // It exists to stop an unbounded body from becoming an unbounded allocation.
      if (chunks.reduce((n, c) => n + c.length, 0) > 32 * 1024 * 1024) {
        tooLarge = true;
        break;
      }
    }

    if (tooLarge) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'request body too large' }));
      return;
    }

    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    try {
      body = raw === '' ? null : JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: JSONRPC_VERSION,
          id: null,
          error: { code: -32700, message: 'parse error' },
        }),
      );
      return;
    }

    const requests = normalise(body);
    const isInitialize = requests.some((r) => r.method === 'initialize');
    const responses = await this.handleBody(body);
    const newSession = isInitialize ? this.issueSession() : undefined;

    const accept = String(req.headers.accept ?? '');
    const wantsSse = accept.includes('text/event-stream');
    const wantsJson = accept.includes('application/json') || accept.includes('*/*');

    if (!wantsSse && !wantsJson) {
      // 406 rather than a silent default. A client that will not say what it
      // accepts cannot be served correctly, and guessing wrong is how a transport
      // bug presents as "the server just ignores me".
      res.writeHead(406, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: `Accept must include application/json or text/event-stream; got "${accept}"`,
        }),
      );
      return;
    }

    const headers: Record<string, string> = {};
    if (newSession) headers['mcp-session-id'] = newSession;

    if (wantsSse) {
      // The spec's SSE form: each JSON-RPC message is one `data:` line. A
      // notification-only request legitimately produces no events, so the stream
      // is simply closed.
      res.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
      for (const r of responses) res.write(`data: ${JSON.stringify(r)}\n\n`);
      res.end();
      return;
    }

    // JSON form. A notifications-only batch has no messages to return, and the
    // spec says that is 202 with no body rather than an empty `result`.
    if (responses.length === 0) {
      res.writeHead(202, headers);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(responses.length === 1 ? responses[0] : responses));
  }

  /** Start listening. Resolves with the bound address. */
  listen(): Promise<{ host: string; port: number; url: string }> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.onRequest(req, res).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: message }));
          } else {
            res.end();
          }
        });
      });
      this.server = server;
      server.once('error', reject);
      server.listen(this.port, this.host, () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : this.port;
        resolve({ host: this.host, port, url: `http://${this.host}:${port}/mcp` });
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Entry point for `supercarto mcp-http`. */
export async function mainMcpHttp(argv: string[] = []): Promise<number> {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const port = Number(get('--port') ?? process.env.SUPERCARTO_MCP_PORT ?? '8788');
  const host = get('--host') ?? process.env.SUPERCARTO_MCP_HOST ?? '127.0.0.1';
  const maxTokens = Number(get('--max-tokens') ?? process.env.SUPERCARTO_MCP_MAX_TOKENS ?? '8192');

  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    process.stderr.write('port must be between 0 and 65535\n');
    return 1;
  }

  const server = new McpHttpServer({
    carto: cartoFromEnv(),
    host,
    port,
    maxTokens,
    // A strict session check is opt-in, because this server holds no session state
    // to protect and rejecting a client's own id helps nobody.
    allowForeignSessions: (get('--strict-sessions') ?? 'false') === 'true',
  });

  const bound = await server.listen();
  // stdout, not stderr: an operator pipes this and a log line on stdout corrupts it.
  process.stderr.write(
    `supercarto mcp-http listening on ${bound.url}\n` +
      `  health:  GET  http://${bound.host}:${bound.port}/health\n` +
      `  jsonrpc: POST http://${bound.host}:${bound.port}/mcp\n` +
      `  tools:   ${server.listTools().map((t) => t.name).join(', ')}\n`,
  );

  const shutdown = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return 0;
}
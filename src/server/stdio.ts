import process from 'node:process';
import { SuperCarto } from '../live.js';
import { cartoFromEnv } from '../config.js';
import { defineTools, type McpTool, type ToolResult } from './mcp.js';
import { VERSION } from '../index.js';

/**
 * MCP server over stdio.
 *
 * The protocol is newline-delimited JSON-RPC 2.0. Three methods matter:
 * `initialize`, `tools/list`, and `tools/call`. The rest are notifications with
 * no response, which is why unknown methods return null rather than an error -
 * replying to a notification with a response id confuses strict clients.
 */

const PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface StdioServerOptions {
  carto?: SuperCarto;
  maxTokens?: number;
  /** Defaults to stdout, overridable for tests. */
  write?: (line: string) => void;
}

export class McpStdioServer {
  private readonly tools: Map<string, McpTool>;
  private readonly write: (line: string) => void;
  private readonly carto: SuperCarto;

  constructor(opts: StdioServerOptions = {}) {
    this.carto = opts.carto ?? new SuperCarto();
    this.tools = new Map(
      defineTools(this.carto, opts.maxTokens ?? 8192).map((t) => [t.name, t]),
    );
    this.write = opts.write ?? ((line) => process.stdout.write(`${line}\n`));
  }

  /** Tool descriptors, for `tools/list` and for inspection. */
  listTools(): Array<Omit<McpTool, 'handler'>> {
    return [...this.tools.values()].map(({ handler: _handler, ...rest }) => rest);
  }

  /** Handle one parsed request. Returns the response object, or null. */
  async handle(req: JsonRpcRequest): Promise<Record<string, unknown> | null> {
    const isNotification = req.id === undefined || req.id === null;

    switch (req.method) {
      case 'initialize':
        return this.respond(req, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'supercarto', version: VERSION },
        });

      case 'notifications/initialized':
      case 'initialized':
        return null;

      case 'ping':
        return this.respond(req, {});

      case 'tools/list':
        return this.respond(req, {
          tools: this.listTools().map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });

      case 'tools/call': {
        const params = req.params ?? {};
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const tool = this.tools.get(name);
        if (!tool) {
          // A bad tool name is reported as a tool error rather than a protocol
          // error, which is what clients surface to the model usefully.
          return this.respond(req, {
            content: [{ type: 'text', text: `error: unknown tool "${name}"` }],
            isError: true,
          });
        }
        try {
          const result = await tool.handler(args);
          return this.respond(req, result);
        } catch (err) {
          const result: ToolResult = {
            content: [
              { type: 'text', text: `error: ${err instanceof Error ? err.message : String(err)}` },
            ],
            isError: true,
          };
          return this.respond(req, result);
        }
      }

      default:
        if (isNotification) return null;
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32601, message: `method not found: ${req.method}` },
        };
    }
  }

  private respond(req: JsonRpcRequest, result: unknown): Record<string, unknown> {
    return { jsonrpc: '2.0', id: req.id ?? null, result };
  }

  /** Read newline-delimited JSON-RPC from a stream until it closes. */
  async serve(input: NodeJS.ReadableStream = process.stdin): Promise<void> {
    let buffer = '';
    for await (const chunk of input) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line === '') continue;
        await this.handleLine(line);
      }
    }
    // A final line without a trailing newline is still a valid message.
    const tail = buffer.trim();
    if (tail !== '') await this.handleLine(tail);
  }

  private async handleLine(line: string): Promise<void> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line) as JsonRpcRequest;
    } catch {
      // A parse error gets a null id, per JSON-RPC.
      this.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'parse error' },
        }),
      );
      return;
    }
    const res = await this.handle(req);
    if (res !== null) this.write(JSON.stringify(res));
  }
}

/** Entry point for `supercarto mcp`. */
export function mainMcp(): void {
  const server = new McpStdioServer({ carto: defaultCarto() });
  server.serve().catch((err: unknown) => {
    process.stderr.write(`supercarto mcp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}

/**
 * The `SuperCarto` an operator gets with no arguments.
 *
 * Delegates to the shared factory so the MCP server and the CLI cannot end up
 * configured differently, which had already happened once: the CLI learned to
 * read PMTiles and the server did not, and nothing reported the difference.
 */
function defaultCarto(): SuperCarto {
  return cartoFromEnv();
}
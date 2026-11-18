import type { IncomingHttpHeaders, RequestListener, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ApiClient } from './api-client.ts';
import { registerTools } from './tools.ts';

function sendError(res: ServerResponse, status: number, message: string): void {
  res
    .writeHead(status, { 'content-type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/**
 * The caller's credentials, passed on to the engineer API on each of its
 * calls so the API sees the same user. Add a header name here to forward it too.
 */
const forwardedHeaders = ['cookie'] as const;

function pickForwardedHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of forwardedHeaders) {
    const value = headers[name];
    if (typeof value === 'string') picked[name] = value;
  }
  return picked;
}

/**
 * Stateless Streamable HTTP: every POST gets a fresh server and transport, so
 * there are no sessions to track and GET (server-initiated streams) and DELETE
 * (session end) have nothing to do. The host server mounts it on a path and
 * guards it; the handler checks neither. `clientFor` makes the API client
 * for one request, given the request's `forwardedHeaders`.
 */
export function createMcpHandler(clientFor: (headers: Record<string, string>) => ApiClient): RequestListener {
  return (req, res) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed.');

    const server = new McpServer({ name: 'factory', version: '0.0.0' });
    registerTools(server, clientFor(pickForwardedHeaders(req.headers)));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch((error: unknown) => {
        console.error('mcp request failed:', error);
        if (!res.headersSent) sendError(res, 500, 'Internal server error.');
      });
  };
}

import type { RequestListener, ServerResponse } from 'node:http';
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
 * Stateless Streamable HTTP: every POST gets a fresh server and transport, so
 * there are no sessions to track and GET (server-initiated streams) and DELETE
 * (session end) have nothing to do. The host server mounts it on a path and
 * guards it; the handler checks neither.
 */
export function createMcpHandler(client: ApiClient): RequestListener {
  return (req, res) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed.');

    const server = new McpServer({ name: 'factory', version: '0.0.0' });
    registerTools(server, client);
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

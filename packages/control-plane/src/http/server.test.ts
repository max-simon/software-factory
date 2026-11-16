import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { createServer, mcpPath } from './server.ts';

async function startServer(t: TestContext): Promise<{ port: number; mcpCalls: string[] }> {
  const mcpCalls: string[] = [];
  const server = createServer([], {
    mcp: (req, res) => {
      mcpCalls.push(`${req.method} ${req.url}`);
      res.writeHead(200).end();
    },
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port, mcpCalls };
}

// fetch() does not let callers set Host, so requests go through node:http.
function post(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end('{}');
  });
}

test('hands local requests to the MCP path to the MCP handler, with the query', async (t) => {
  const { port, mcpCalls } = await startServer(t);
  assert.equal(await post(port, `${mcpPath}?x=1`, { host: 'localhost:4700', origin: 'http://localhost:5173' }), 200);
  assert.deepEqual(mcpCalls, [`POST ${mcpPath}?x=1`]);
});

test('refuses non-local hosts or origins on the MCP path before the handler', async (t) => {
  const { port, mcpCalls } = await startServer(t);
  assert.equal(await post(port, mcpPath, { host: 'evil.example:4700' }), 403);
  assert.equal(await post(port, mcpPath, { origin: 'https://evil.example' }), 403);
  assert.deepEqual(mcpCalls, []);
});

test('leaves other paths to the routes', async (t) => {
  const { port, mcpCalls } = await startServer(t);
  assert.equal(await post(port, `${mcpPath}/other`), 404);
  assert.deepEqual(mcpCalls, []);
});

import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { createServer, mcpPath, type Request, type Route } from './server.ts';

const session = 'factory_session=good';

async function startServer(t: TestContext): Promise<{ port: number; mcpCalls: string[]; seen: Request[] }> {
  const mcpCalls: string[] = [];
  const seen: Request[] = [];
  const handle: Route['handle'] = (req) => {
    seen.push(req);
    return { status: 200, body: {}, headers: { 'x-extra': 'yes' } };
  };
  const routes: Route[] = [
    { method: 'GET', path: '/private', handle },
    { method: 'POST', path: '/open', public: true, handle },
    { method: 'GET', path: '/agent/thing', handle },
  ];
  const server = createServer(routes, {
    authenticate: (headers) => (headers.cookie === session ? { userId: 'u1', via: 'session' } : undefined),
    staticFiles: async (path) => (path === '/index.html' ? { content: Buffer.from('<html>'), contentType: 'text/html' } : undefined),
    mcp: (req, res) => {
      mcpCalls.push(`${req.method} ${req.url}`);
      res.writeHead(200).end();
    },
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port, mcpCalls, seen };
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

// fetch() does not let callers set Host, so requests go through node:http.
function send(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : '{}');
  });
}

const post = async (port: number, path: string, headers: Record<string, string> = {}): Promise<number> =>
  (await send(port, 'POST', path, headers)).status;

test('hands signed-in local requests to the MCP path to the MCP handler, with the query', async (t) => {
  const { port, mcpCalls } = await startServer(t);
  assert.equal(await post(port, `${mcpPath}?x=1`, { host: 'localhost:4700', origin: 'http://localhost:5173', cookie: session }), 200);
  assert.deepEqual(mcpCalls, [`POST ${mcpPath}?x=1`]);
});

test('refuses the MCP path without a session with a JSON 401', async (t) => {
  const { port, mcpCalls } = await startServer(t);
  for (const headers of [{}, { cookie: 'factory_session=bad' }] as Array<Record<string, string>>) {
    const reply = await send(port, 'POST', mcpPath, headers);
    assert.equal(reply.status, 401);
    assert.equal(reply.headers['content-type'], 'application/json');
    assert.equal(JSON.parse(reply.body).error.code, 'unauthorized');
  }
  assert.deepEqual(mcpCalls, []);
});

test('refuses non-local hosts or origins on the MCP path before the handler', async (t) => {
  const { port, mcpCalls } = await startServer(t);
  assert.equal(await post(port, mcpPath, { host: 'evil.example:4700', cookie: session }), 403);
  assert.equal(await post(port, mcpPath, { origin: 'https://evil.example', cookie: session }), 403);
  assert.deepEqual(mcpCalls, []);
});

test('leaves other paths to the routes', async (t) => {
  const { port, mcpCalls } = await startServer(t);
  assert.equal(await post(port, `${mcpPath}/other`, { cookie: session }), 404);
  assert.deepEqual(mcpCalls, []);
});

test('routes need a session unless public or under /agent/, and get the principal', async (t) => {
  const { port, seen } = await startServer(t);
  assert.equal((await send(port, 'GET', '/private')).status, 401);
  assert.equal((await send(port, 'GET', '/private', { cookie: 'factory_session=bad' })).status, 401);
  assert.equal(seen.length, 0);
  const reply = await send(port, 'GET', '/private', { cookie: session });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['x-extra'], 'yes');
  assert.deepEqual(seen[0]!.principal, { userId: 'u1', via: 'session' });
  assert.equal(seen[0]!.clientAddress, '127.0.0.1');
  assert.equal(seen[0]!.secure, false);
  assert.equal((await send(port, 'POST', '/open')).status, 200);
  assert.equal(seen[1]!.principal, undefined);
  assert.equal((await send(port, 'GET', '/agent/thing')).status, 200);
});

test('serves static files signed out, but answers other unknown paths with 401 unless signed in', async (t) => {
  const { port } = await startServer(t);
  const file = await send(port, 'GET', '/index.html');
  assert.equal(file.status, 200);
  assert.equal(file.body, '<html>');
  assert.equal((await send(port, 'GET', '/projects')).status, 401);
  assert.equal((await send(port, 'POST', '/index.html')).status, 401);
  assert.equal((await send(port, 'GET', '/projects', { cookie: session })).status, 404);
  assert.equal((await send(port, 'GET', '/agent/unknown')).status, 404);
});

test('the browser guard runs before authentication', async (t) => {
  const { port } = await startServer(t);
  assert.equal((await send(port, 'GET', '/private', { origin: 'https://evil.example' })).status, 403);
});

test('answers WebSocket upgrades with 404 when nothing handles them', async (t) => {
  const { port } = await startServer(t);
  const reply = await send(port, 'GET', '/private', { connection: 'Upgrade', upgrade: 'websocket', cookie: session });
  assert.equal(reply.status, 404);
  assert.equal(JSON.parse(reply.body).error.code, 'not_found');
});

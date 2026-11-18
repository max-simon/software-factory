import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createUser, disableUser, type Principal } from '@factory/core';
import { createApiClient, createMcpHandler } from '@factory/mcp';
import { SqliteAccessTokenRepository } from '../adapters/sqlite-access-token-repository.ts';
import { SqliteSessionRepository } from '../adapters/sqlite-session-repository.ts';
import { SqliteUserRepository } from '../adapters/sqlite-user-repository.ts';
import { AccessTokenService, hashAccessToken } from '../auth/access-token-service.ts';
import { LoginThrottle } from '../auth/login-throttle.ts';
import { SessionService } from '../auth/session-service.ts';
import { authRoutes } from './auth-routes.ts';
import { authenticateRequest } from './authenticate.ts';
import { createServer, mcpPath, type Route } from './server.ts';
import { sessionCookieName } from './session-cookie.ts';
import { tokenRoutes } from './token-routes.ts';

const minute = 60_000;
const day = 86_400_000;

async function setup(t: TestContext) {
  let clock = Date.parse('2026-11-12T10:00:00.000Z');
  const now = () => clock;
  const users = new SqliteUserRepository(':memory:');
  for (const [id, username] of [['u1', 'ada'], ['u2', 'bob']] as const) {
    users.insert(createUser({ username }, { id, now: '2026-11-12T10:00:00.000Z' }));
  }
  const sessions = new SessionService({
    sessions: new SqliteSessionRepository(':memory:'),
    users,
    idleTimeoutMs: 12 * 3_600_000,
    maxLifetimeMs: 7 * day,
    now,
  });
  const store = new SqliteAccessTokenRepository(':memory:');
  let ids = 0;
  const tokens = new AccessTokenService({ tokens: store, users, now, newId: () => `tok${++ids}` });
  // Stand in for the engineer routes; GET /projects is what the MCP tool list_projects calls.
  const seen: Principal[] = [];
  const whoami: Route = { method: 'GET', path: '/whoami', handle: ({ principal }) => ({ status: 200, body: principal }) };
  const projects: Route = {
    method: 'GET',
    path: '/projects',
    handle: ({ principal }) => {
      seen.push(principal!);
      return { status: 200, body: [] };
    },
  };
  const routes = [
    ...authRoutes({
      authenticator: { authenticate: async () => undefined },
      sessions,
      accounts: { rename: () => assert.fail('not used'), changePassword: () => assert.fail('not used') },
      users,
      throttle: new LoginThrottle(),
      clientThrottle: new LoginThrottle(),
    }),
    ...tokenRoutes(tokens),
    whoami,
    projects,
  ];
  let base = '';
  const server = createServer(routes, {
    authenticate: authenticateRequest(sessions, tokens),
    mcp: createMcpHandler((headers) => createApiClient(base, headers)),
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;

  const signIn = (userId: string) => `${sessionCookieName}=${sessions.createSession(userId).token}`;
  const ada = signIn('u1');
  const bob = signIn('u2');
  const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const response = await fetch(base + path, {
      method,
      headers,
      ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : undefined };
  };
  const issue = async (cookie: string, body: unknown = { name: 'laptop' }) => {
    const reply = await call('POST', '/auth/tokens', { cookie }, body);
    assert.equal(reply.status, 201, JSON.stringify(reply.json));
    return { ...reply.json, bearer: { authorization: `Bearer ${reply.json.token}` } };
  };
  return { users, store, seen, port, call, issue, ada, bob, signIn, advance: (ms: number) => (clock += ms) };
}

test('POST /auth/tokens returns the token once, stored only as its hash', async (t) => {
  const { store, call, issue, ada } = await setup(t);
  const created = await issue(ada, { name: '  laptop ', expiresInDays: 30 });
  assert.match(created.token, /^fct_[\w-]{43}$/);
  const { token, bearer, ...metadata } = created;
  assert.deepEqual(metadata, { id: 'tok1', name: 'laptop', createdAt: '2026-11-12T10:00:00.000Z', expiresAt: '2026-12-12T10:00:00.000Z' });
  assert.equal(store.getByHash(token), undefined);
  assert.equal(store.getByHash(hashAccessToken(token))?.userId, 'u1');
  const listed = await call('GET', '/auth/tokens', { cookie: ada });
  assert.deepEqual(listed, { status: 200, json: [metadata] });
  assert.ok(!JSON.stringify(listed.json).includes(token));
  assert.ok(!JSON.stringify(listed.json).includes(hashAccessToken(token)));
});

test('a bearer token acts as its user', async (t) => {
  const { call, issue, ada } = await setup(t);
  const { bearer } = await issue(ada);
  assert.deepEqual(await call('GET', '/whoami', bearer), { status: 200, json: { userId: 'u1', via: 'token' } });
  assert.deepEqual((await call('GET', '/whoami', { cookie: ada })).json, { userId: 'u1', via: 'session' });
  assert.deepEqual((await call('GET', '/auth/me', bearer)).json, { id: 'u1', username: 'ada', displayName: 'ada' });
  // Signed in, an unknown path is a 404 rather than a 401.
  assert.equal((await call('GET', '/nope', bearer)).status, 404);
  assert.equal((await call('GET', '/whoami', { authorization: `bearer ${bearer.authorization.slice(7)}` })).status, 200);
});

test('records the last use at most once a minute', async (t) => {
  const { store, call, issue, ada, advance } = await setup(t);
  const { token, bearer } = await issue(ada);
  const lastUsed = () => store.getByHash(hashAccessToken(token))!.lastUsedAt;
  assert.equal(lastUsed(), undefined);
  await call('GET', '/whoami', bearer);
  assert.equal(lastUsed(), '2026-11-12T10:00:00.000Z');
  advance(minute - 1);
  await call('GET', '/whoami', bearer);
  assert.equal(lastUsed(), '2026-11-12T10:00:00.000Z');
  advance(1);
  await call('GET', '/whoami', bearer);
  assert.equal(lastUsed(), '2026-11-12T10:01:00.000Z');
  assert.equal((await call('GET', '/auth/tokens', { cookie: ada })).json[0].lastUsedAt, '2026-11-12T10:01:00.000Z');
});

test('invalid, unknown and non-bearer Authorization headers get 401 without falling back to the cookie', async (t) => {
  const { call, issue, ada } = await setup(t);
  const { token } = await issue(ada);
  for (const authorization of ['Bearer fct_unknown', 'Bearer', '', `Basic ${token}`, `Bearer ${token.slice(4)}`, `Bearer ${token} extra`]) {
    const reply = await call('GET', '/whoami', { authorization, cookie: ada });
    assert.equal(reply.status, 401, authorization);
    assert.equal(reply.json.error.code, 'unauthorized');
  }
});

test('a revoked token gets 401; a user can only revoke its own', async (t) => {
  const { call, issue, ada, bob } = await setup(t);
  const { id, bearer } = await issue(ada);
  const other = await issue(bob, { name: 'desktop' });
  assert.deepEqual((await call('GET', '/auth/tokens', { cookie: bob })).json.map((token: { id: string }) => token.id), [other.id]);
  const foreign = await call('DELETE', `/auth/tokens/${id}`, { cookie: bob });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.json.error.code, 'not_found');
  assert.equal((await call('GET', '/whoami', bearer)).status, 200);
  assert.equal((await call('DELETE', `/auth/tokens/${id}`, { cookie: ada })).status, 204);
  assert.equal((await call('GET', '/whoami', bearer)).status, 401);
  assert.equal((await call('DELETE', `/auth/tokens/${id}`, { cookie: ada })).status, 404);
  assert.deepEqual((await call('GET', '/auth/tokens', { cookie: ada })).json, []);
  assert.equal((await call('GET', '/whoami', other.bearer)).status, 200);
});

test('a token stops working when it expires, and stays listed', async (t) => {
  const { call, issue, ada, signIn, advance } = await setup(t);
  const { bearer } = await issue(ada, { name: 'ci', expiresInDays: 1 });
  const forever = await issue(ada, { name: 'laptop' });
  advance(day - 1);
  assert.equal((await call('GET', '/whoami', bearer)).status, 200);
  advance(1);
  assert.equal((await call('GET', '/whoami', bearer)).status, 401);
  assert.equal((await call('GET', '/whoami', forever.bearer)).status, 200);
  // Ada's session went idle meanwhile.
  const listed = (await call('GET', '/auth/tokens', { cookie: signIn('u1') })).json;
  assert.deepEqual(listed.map((token: { name: string; expiresAt?: string }) => [token.name, token.expiresAt]), [
    ['ci', '2026-11-13T10:00:00.000Z'],
    ['laptop', undefined],
  ]);
});

test('the tokens of a disabled user get 401', async (t) => {
  const { users, call, issue, ada } = await setup(t);
  const { bearer } = await issue(ada);
  users.update(disableUser(users.get('u1')!, '2026-11-12T11:00:00.000Z'));
  assert.equal((await call('GET', '/whoami', bearer)).status, 401);
});

test('managing tokens and logging out need a session: a token gets 403', async (t) => {
  const { call, issue, ada } = await setup(t);
  const { id, bearer } = await issue(ada);
  for (const [method, path, body] of [
    ['GET', '/auth/tokens'],
    ['POST', '/auth/tokens', { name: 'another' }],
    ['DELETE', `/auth/tokens/${id}`],
    ['POST', '/auth/logout'],
  ] as const) {
    const reply = await call(method, path, bearer, body);
    assert.equal(reply.status, 403, `${method} ${path}`);
    assert.equal(reply.json.error.code, 'session_required');
  }
  assert.equal((await call('GET', '/auth/tokens', { cookie: ada })).json.length, 1);
  assert.equal((await call('GET', '/whoami', bearer)).status, 200);
  // Without any credentials, it is the usual 401.
  assert.equal((await call('GET', '/auth/tokens')).status, 401);
});

test('validates the name and the expiry', async (t) => {
  const { call, ada } = await setup(t);
  const cases: Array<[unknown, RegExp]> = [
    [{}, /name must be a string/],
    [{ name: 3 }, /name must be a string/],
    [{ name: '  ' }, /1 to 100 characters/],
    [{ name: 'x'.repeat(101) }, /1 to 100 characters/],
    [{ name: 'ci', expiresInDays: 0 }, /whole number from 1 to 3650/],
    [{ name: 'ci', expiresInDays: 1.5 }, /whole number from 1 to 3650/],
    [{ name: 'ci', expiresInDays: '30' }, /whole number from 1 to 3650/],
    [{ name: 'ci', expiresInDays: 3651 }, /whole number from 1 to 3650/],
    [{ name: 'ci', scope: 'all' }, /unknown fields: scope/],
    ['[]', /must be a JSON object/],
  ];
  for (const [body, message] of cases) {
    const reply = await call('POST', '/auth/tokens', { cookie: ada }, body);
    assert.equal(reply.status, 400, JSON.stringify(body));
    assert.match(reply.json.error.message, message);
  }
  assert.deepEqual((await call('GET', '/auth/tokens', { cookie: ada })).json, []);
});

// fetch() does not let callers set Host or Origin freely, so this goes through node:http.
function statusOf(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      res.resume().on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the browser guard applies to bearer requests too', async (t) => {
  const { port, issue, ada } = await setup(t);
  const { bearer } = await issue(ada);
  assert.equal(await statusOf(port, '/whoami', bearer), 200);
  assert.equal(await statusOf(port, '/whoami', { ...bearer, origin: 'http://localhost:5173' }), 200);
  assert.equal(await statusOf(port, '/whoami', { ...bearer, origin: 'https://evil.example' }), 403);
  assert.equal(await statusOf(port, '/whoami', { ...bearer, host: 'evil.example:4700' }), 403);
  // The MCP handler answers GET with 405, so a 403 means the guard stopped it first.
  assert.equal(await statusOf(port, mcpPath, bearer), 405);
  assert.equal(await statusOf(port, mcpPath, { ...bearer, origin: 'https://evil.example' }), 403);
});

/** One stateless MCP tool call over plain HTTP, as an MCP client sends it. */
async function callMcpTool(port: number, name: string, headers: Record<string, string>) {
  const response = await fetch(`http://127.0.0.1:${port}${mcpPath}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
  });
  const text = await response.text();
  if (!response.ok) return { status: response.status, json: JSON.parse(text) };
  // A Streamable HTTP reply may come as a server-sent event stream with the result in its data line.
  const data = text.startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data: '))!.slice(6);
  return { status: response.status, json: JSON.parse(data) };
}

test('/mcp needs a valid token or session; a token makes the tools run as its user', async (t) => {
  const { seen, port, issue, ada } = await setup(t);
  const { id, bearer } = await issue(ada);
  const refused: Array<Record<string, string>> = [{}, { authorization: 'Bearer fct_unknown' }, { authorization: 'Bearer fct_unknown', cookie: ada }];
  for (const headers of refused) {
    const reply = await callMcpTool(port, 'list_projects', headers);
    assert.equal(reply.status, 401);
    assert.equal(reply.json.error.code, 'unauthorized');
  }
  assert.deepEqual(seen, []);

  const reply = await callMcpTool(port, 'list_projects', bearer);
  assert.equal(reply.status, 200);
  assert.equal(reply.json.result.isError, undefined, JSON.stringify(reply.json));
  assert.deepEqual(JSON.parse(reply.json.result.content[0].text), []);
  // The MCP handler passed the token on, so the engineer API saw the same user, by token.
  assert.deepEqual(seen, [{ userId: 'u1', via: 'token' }]);

  await fetch(`http://127.0.0.1:${port}/auth/tokens/${id}`, { method: 'DELETE', headers: { cookie: ada } });
  assert.equal((await callMcpTool(port, 'list_projects', bearer)).status, 401);
});

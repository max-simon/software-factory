import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createUser, disableUser, localProvider } from '@factory/core';
import { SqliteSessionRepository } from '../adapters/sqlite-session-repository.ts';
import { SqliteUserRepository } from '../adapters/sqlite-user-repository.ts';
import { LocalPasswordAuthenticator } from '../auth/local-password-authenticator.ts';
import { LoginThrottle } from '../auth/login-throttle.ts';
import { ScryptPasswordHasher } from '../auth/passwords.ts';
import { hashSessionToken, SessionService } from '../auth/session-service.ts';
import { authRoutes } from './auth-routes.ts';
import { createServer, type Request, type Route } from './server.ts';
import { readSessionToken } from './session-cookie.ts';

const hasher = new ScryptPasswordHasher({ N: 2 ** 10 });
const password = 'correct horse battery';
const hour = 3_600_000;
const day = 24 * hour;

async function setup(t: TestContext) {
  let clock = Date.parse('2026-11-12T10:00:00.000Z');
  const now = () => clock;
  const users = new SqliteUserRepository(':memory:');
  for (const [id, username] of [['u1', 'ada'], ['u2', 'bob']] as const) {
    users.insert(createUser({ username, displayName: username.toUpperCase() }, { id, now: '2026-11-12T10:00:00.000Z' }));
    users.setPasswordHash(id, await hasher.hash(password));
  }
  const store = new SqliteSessionRepository(':memory:');
  const sessions = new SessionService({ sessions: store, users, idleTimeoutMs: 12 * hour, maxLifetimeMs: 7 * day, now });
  const routes = authRoutes({
    authenticator: new LocalPasswordAuthenticator({ users, passwords: users, hasher }),
    sessions,
    users,
    throttle: new LoginThrottle({ now }),
  });
  // Stands in for the engineer routes.
  const whoami: Route = { method: 'GET', path: '/whoami', handle: ({ principal }) => ({ status: 200, body: principal }) };
  const server = createServer([...routes, whoami], {
    authenticate: (headers) => sessions.resolve(readSessionToken(headers)),
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = async (method: string, path: string, options: { body?: unknown; cookie?: string } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: options.cookie === undefined ? {} : { cookie: options.cookie },
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : undefined };
  };
  const login = async (username = 'ada', pw = password) => {
    const response = await call('POST', '/auth/login', { body: { username, password: pw } });
    const setCookie = response.headers.get('set-cookie') ?? '';
    return { ...response, setCookie, cookie: setCookie.split(';')[0]! };
  };
  /** Calls the login route's handler directly, as from `clientAddress`. */
  const loginFrom = (clientAddress: string, username: string, pw: string, secure = false) =>
    routes[0]!.handle({ params: {}, headers: {}, body: { username, password: pw }, clientAddress, secure } satisfies Request);
  return { users, store, call, login, loginFrom, advance: (ms: number) => (clock += ms) };
}

test('login sets a session cookie that signs the user in', async (t) => {
  const { call, login } = await setup(t);
  const { status, json, setCookie, cookie } = await login(' ADA ');
  assert.equal(status, 200);
  assert.deepEqual(json, { id: 'u1', username: 'ada', displayName: 'ADA' });
  assert.match(setCookie, /^factory_session=[\w-]{43}; Max-Age=604800; Path=\/; HttpOnly; SameSite=Strict$/);
  assert.deepEqual((await call('GET', '/auth/me', { cookie })).json, { id: 'u1', username: 'ada', displayName: 'ADA' });
  assert.deepEqual((await call('GET', '/whoami', { cookie })).json, { userId: 'u1', via: 'session' });
});

test('the cookie is Secure when the request came over TLS', async (t) => {
  const { loginFrom } = await setup(t);
  const response = await loginFrom('10.0.0.1', 'ada', password, true);
  assert.match(response.headers!['set-cookie']!, /; HttpOnly; SameSite=Strict; Secure$/);
});

test('stores only the hash of the session token', async (t) => {
  const { store, login } = await setup(t);
  const { cookie } = await login();
  const token = cookie.split('=')[1]!;
  assert.equal(store.get(token), undefined);
  assert.equal(store.get(hashSessionToken(token))?.userId, 'u1');
});

test('a wrong password, an unknown username and a disabled user get the same 401', async (t) => {
  const { users, call, login } = await setup(t);
  users.update(disableUser(users.get('u2')!, '2026-11-12T11:00:00.000Z'));
  const replies = [await login('ada', 'wrong password!'), await login('nobody'), await login('bob')];
  for (const reply of replies) {
    assert.equal(reply.status, 401);
    assert.equal(reply.setCookie, '');
    assert.deepEqual(reply.json, { error: { code: 'login_failed', message: 'wrong username or password' } });
  }
  assert.equal((await call('POST', '/auth/login', { body: { username: 'ada' } })).status, 400);
});

test('only the login is open without a session', async (t) => {
  const { call } = await setup(t);
  for (const [method, path] of [['GET', '/auth/me'], ['POST', '/auth/logout'], ['GET', '/whoami']] as const) {
    const { status, json } = await call(method, path);
    assert.equal(status, 401, path);
    assert.equal(json.error.code, 'unauthorized');
  }
  assert.equal((await call('GET', '/whoami', { cookie: 'factory_session=forged' })).status, 401);
});

test('logout ends that session only and clears the cookie', async (t) => {
  const { call, login } = await setup(t);
  const first = (await login()).cookie;
  const second = (await login()).cookie;
  const response = await call('POST', '/auth/logout', { cookie: first });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('set-cookie'), 'factory_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict');
  assert.equal((await call('GET', '/auth/me', { cookie: first })).status, 401);
  assert.equal((await call('GET', '/auth/me', { cookie: second })).status, 200);
});

test('a session ends after 12 idle hours, and use keeps it alive', async (t) => {
  const { store, call, login, advance } = await setup(t);
  const { cookie } = await login();
  for (let i = 0; i < 3; i++) {
    advance(12 * hour - 1);
    assert.equal((await call('GET', '/whoami', { cookie })).status, 200);
  }
  advance(12 * hour);
  assert.equal((await call('GET', '/whoami', { cookie })).status, 401);
  assert.equal(store.get(hashSessionToken(cookie.split('=')[1]!)), undefined);
});

test('a session ends 7 days after login, however active', async (t) => {
  const { call, login, advance } = await setup(t);
  const { cookie } = await login();
  for (let i = 0; i < 14; i++) {
    advance(12 * hour - 1);
    assert.equal((await call('GET', '/whoami', { cookie })).status, 200);
  }
  advance(14);
  assert.equal((await call('GET', '/whoami', { cookie })).status, 401);
});

test('a login prunes ended sessions', async (t) => {
  const { store, login, advance } = await setup(t);
  const old = (await login('bob')).cookie.split('=')[1]!;
  advance(13 * hour);
  await login();
  assert.equal(store.get(hashSessionToken(old)), undefined);
});

test('the sessions of a disabled user are refused', async (t) => {
  const { users, call, login } = await setup(t);
  const { cookie } = await login();
  users.update(disableUser(users.get('u1')!, '2026-11-12T11:00:00.000Z'));
  assert.equal((await call('GET', '/auth/me', { cookie })).status, 401);
  assert.equal((await call('GET', '/whoami', { cookie })).status, 401);
});

test('repeated failures from one client lock it out with 429 and retry-after, whichever username', async (t) => {
  const { login, advance } = await setup(t);
  for (const username of ['a1', 'a2', 'a3', 'a4', 'a5']) assert.equal((await login(username)).status, 401);
  const locked = await login();
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.get('retry-after'), '30');
  assert.equal(locked.setCookie, '');
  assert.deepEqual(locked.json, { error: { code: 'too_many_attempts', message: 'too many failed logins, try again later' } });
  advance(29_000);
  assert.equal((await login()).headers.get('retry-after'), '1');
  advance(1_000);
  assert.equal((await login()).status, 200);
  // The success reset the client: the next failure is not locked out.
  assert.equal((await login('a6')).status, 401);
  assert.equal((await login()).status, 200);
});

test('repeated failures for one username lock it out from every client, and a success resets it', async (t) => {
  const { loginFrom, advance } = await setup(t);
  for (let i = 1; i <= 5; i++) assert.equal((await loginFrom(`10.0.0.${i}`, 'ada', 'wrong password!')).status, 401);
  const locked = await loginFrom('10.0.0.9', 'ADA', password);
  assert.equal(locked.status, 429);
  assert.deepEqual(locked.headers, { 'retry-after': '30' });
  assert.equal((await loginFrom('10.0.0.9', 'bob', password)).status, 200);
  advance(30_000);
  assert.equal((await loginFrom('10.0.0.9', 'ada', password)).status, 200);
  assert.equal((await loginFrom('10.0.0.1', 'ada', 'wrong password!')).status, 401);
  assert.equal((await loginFrom('10.0.0.1', 'ada', password)).status, 200);
});

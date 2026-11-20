import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { markInProgress, startTask, type ExecutionRuntime } from '@factory/core';
import { WebSocket } from 'ws';
import { SqliteTaskRepository } from '../adapters/sqlite-task-repository.ts';
import { hashAgentToken } from '../agent-token.ts';
import { createServices } from '../services.ts';
import { ShellService } from '../shell-service.ts';
import { ada, noIssues, testAuth } from '../test-support.ts';
import { createServer } from './server.ts';
import { shellRoutes, shellUpgrade } from './shell-routes.ts';

const token = 'ab'.repeat(32);
const otherToken = 'cd'.repeat(32);
const fixedNow = '2026-11-12T10:00:00.000Z';

const unusedRuntime: Omit<ExecutionRuntime, 'notifyShell'> = {
  start: async () => ({ executionId: 'unused' }),
  listExecutions: async () => [],
  remove: async () => {},
  notify: async () => {},
  restart: async () => {},
};

/** The full server with two running tasks, `task-1` (agent token `token`) and `task-2` (`otherToken`). */
async function startApi(t: TestContext) {
  const repository = new SqliteTaskRepository(':memory:');
  let taskCounter = 0;
  const notified: string[] = [];
  const runtime: ExecutionRuntime = { ...unusedRuntime, notifyShell: async (executionId) => void notified.push(executionId) };
  const { tasks, service, agent } = createServices({ repository, issues: noIssues, runtime, newId: () => `task-${++taskCounter}` });
  for (const [i, agentToken] of [token, otherToken].entries()) {
    const created = service.create({ projectId: 'p1', title: `Task ${i}`, specification: 's' }, ada);
    repository.save(markInProgress(startTask(created), { tokenHash: hashAgentToken(agentToken), executionId: `c-${i + 1}` }, fixedNow));
  }
  let shellCounter = 0;
  const shells = new ShellService({ tasks, runtime, idleTimeoutMs: 60_000, secrets: [], newId: () => `s${++shellCounter}` });
  const auth = testAuth();
  const server = createServer(shellRoutes(shells, agent), {
    authenticate: auth.authenticate,
    upgrade: shellUpgrade(shells, agent, auth.authenticate),
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const open: WebSocket[] = [];
  t.after(() => {
    open.forEach((socket) => socket.terminate());
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as AddressInfo).port;
  const connect = (path: string, headers: Record<string, string>): WebSocket => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    open.push(socket);
    return socket;
  };
  const listShells = async (agentToken = token) => {
    const response = await fetch(`http://127.0.0.1:${port}/agent/shells`, { headers: { authorization: `Bearer ${agentToken}` } });
    return { status: response.status, json: await response.json() };
  };
  return { auth, notified, connect, listShells };
}

const shellPath = '/tasks/task-1/shell?cols=80&rows=24';

/** The plain HTTP response that refused a handshake. */
function refusalOf(socket: WebSocket): Promise<{ status: number; code: string }> {
  return new Promise((resolve, reject) => {
    socket.on('open', () => reject(new Error('the handshake succeeded')));
    socket.on('error', reject);
    socket.on('unexpected-response', (_request, response) => {
      let body = '';
      response.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, code: JSON.parse(body).error.code }));
    });
  });
}

const closeOf = async (socket: WebSocket): Promise<{ code: number; reason: string }> => {
  const [code, reason] = (await once(socket, 'close')) as [number, Buffer];
  return { code, reason: reason.toString() };
};

const nextMessage = async (socket: WebSocket): Promise<string> => {
  const [data] = (await once(socket, 'message')) as [Buffer];
  return data.toString();
};

test('refuses browser handshakes before the upgrade', async (t) => {
  const { auth, connect } = await startApi(t);
  const cases: Array<[string, string, Record<string, string>, number, string]> = [
    ['a foreign Origin', shellPath, { cookie: auth.cookie, origin: 'https://evil.example' }, 403, 'forbidden'],
    ['a foreign Host', shellPath, { cookie: auth.cookie, host: 'evil.example' }, 403, 'forbidden'],
    ['no session', shellPath, {}, 401, 'unauthorized'],
    ['an access token', shellPath, { authorization: auth.authorization }, 403, 'session_required'],
    ['a size out of range', '/tasks/task-1/shell?cols=0&rows=24', { cookie: auth.cookie }, 400, 'invalid_request'],
    ['no size', '/tasks/task-1/shell', { cookie: auth.cookie }, 400, 'invalid_request'],
    ['a fractional size', '/tasks/task-1/shell?cols=80.5&rows=24', { cookie: auth.cookie }, 400, 'invalid_request'],
    ['an unknown path', '/tasks/task-1/other', { cookie: auth.cookie }, 404, 'not_found'],
  ];
  for (const [what, path, headers, status, code] of cases) {
    assert.deepEqual(await refusalOf(connect(path, headers)), { status, code }, what);
  }
});

test('refuses runner handshakes without a valid agent token', async (t) => {
  const { connect } = await startApi(t);
  for (const headers of [{}, { authorization: `Bearer ${'ef'.repeat(32)}` }] as Array<Record<string, string>>) {
    assert.deepEqual(await refusalOf(connect('/agent/shells/s1', headers)), { status: 401, code: 'unauthorized' });
  }
});

test('a refusal from the service closes the browser socket with 4000 and its reason', async (t) => {
  const { auth, connect } = await startApi(t);
  const browser = connect('/tasks/nope/shell?cols=80&rows=24', { cookie: auth.cookie });
  assert.deepEqual(await closeOf(browser), { code: 4000, reason: 'task nope not found' });
});

test('shortens a refusal reason to what a close frame can carry', async (t) => {
  const { auth, connect } = await startApi(t);
  const id = 'x'.repeat(200);
  const { code, reason } = await closeOf(connect(`/tasks/${id}/shell?cols=80&rows=24`, { cookie: auth.cookie }));
  assert.equal(code, 4000);
  assert.equal(reason, `task ${id}`.slice(0, 123));
});

test('relays a shell between the browser and the runner that attached to its request', async (t) => {
  const { auth, notified, connect, listShells } = await startApi(t);
  const browser = connect(shellPath, { cookie: auth.cookie });
  await once(browser, 'open');
  assert.deepEqual(notified, ['c-1']);
  assert.equal((await listShells()).json.requests[0].id, 's1');

  const runner = connect('/agent/shells/s1', { authorization: `Bearer ${token}` });
  await once(runner, 'open');
  browser.send(Buffer.from('ls\r'));
  assert.equal(await nextMessage(runner), 'ls\r');
  runner.send(Buffer.from('file.txt\r\n'));
  assert.equal(await nextMessage(browser), 'file.txt\r\n');
  assert.deepEqual((await listShells()).json, { requests: [] });

  const closed = closeOf(browser);
  runner.close(1000, 'exit 0');
  assert.deepEqual(await closed, { code: 1000, reason: 'exit 0' });
});

test('refuses a runner for another task and a second runner for the same request', async (t) => {
  const { auth, connect } = await startApi(t);
  const browser = connect(shellPath, { cookie: auth.cookie });
  await once(browser, 'open');

  const foreign = connect('/agent/shells/s1', { authorization: `Bearer ${otherToken}` });
  assert.deepEqual(await closeOf(foreign), { code: 4000, reason: 'shell request s1 not found' });

  const runner = connect('/agent/shells/s1', { authorization: `Bearer ${token}` });
  await once(runner, 'open');
  const second = connect('/agent/shells/s1', { authorization: `Bearer ${token}` });
  assert.deepEqual(await closeOf(second), { code: 4000, reason: 'shell request s1 not found' });
});

test('GET /agent/shells lists the pending requests of the caller’s task only', async (t) => {
  const { auth, connect, listShells } = await startApi(t);
  for (const path of [shellPath, '/tasks/task-2/shell?cols=100&rows=30']) await once(connect(path, { cookie: auth.cookie }), 'open');

  const { status, json } = await listShells(otherToken);
  assert.equal(status, 200);
  assert.deepEqual(json, {
    requests: [{ id: 's2', taskId: 'task-2', size: { cols: 100, rows: 30 }, requestedBy: ada.userId, createdAt: json.requests[0].createdAt }],
  });
  assert.equal((await listShells('ef'.repeat(32))).status, 401);
});

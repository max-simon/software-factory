import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { ApiError, ConnectionError, createApiClient, type ApiClient } from './api-client.ts';

interface Seen {
  method?: string;
  url?: string;
  cookie?: string;
  body: string;
}

let server: Server;
let client: ApiClient;
let seen: Seen;
let reply: { status: number; body: unknown } = { status: 200, body: {} };

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen = { method: req.method, url: req.url, cookie: req.headers.cookie, body: Buffer.concat(chunks).toString('utf8') };
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  client = createApiClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
});

after(() => server.close());

test('createTask posts the task and returns the created view', async () => {
  reply = { status: 201, body: { id: 't1' } };
  const task = await client.createTask({ projectId: 'p1', title: 'T', specification: 'S', repoUrl: 'https://github.com/a/b' });
  assert.equal(task.id, 't1');
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/tasks');
  assert.deepEqual(JSON.parse(seen.body), { projectId: 'p1', title: 'T', specification: 'S', repoUrl: 'https://github.com/a/b' });
});

test('listTasks and getTask use GET', async () => {
  reply = { status: 200, body: [] };
  assert.deepEqual(await client.listTasks(), []);
  assert.equal(`${seen.method} ${seen.url}`, 'GET /tasks');
  reply = { status: 200, body: { id: 'a/b' } };
  await client.getTask('a/b');
  assert.equal(seen.url, '/tasks/a%2Fb');
});

test('startTask posts to the start route without a body', async () => {
  reply = { status: 200, body: { id: 't1' } };
  await client.startTask('t1');
  assert.equal(`${seen.method} ${seen.url}`, 'POST /tasks/t1/start');
  assert.equal(seen.body, '');
});

test('cancelTask and restartTask post to their routes without a body', async () => {
  reply = { status: 200, body: { id: 't1' } };
  await client.cancelTask('t1');
  assert.equal(`${seen.method} ${seen.url} ${seen.body}`, 'POST /tasks/t1/cancel ');
  await client.restartTask('t1');
  assert.equal(`${seen.method} ${seen.url} ${seen.body}`, 'POST /tasks/t1/restart ');
});

test('deleteTask sends DELETE and accepts an empty 204', async () => {
  reply = { status: 204, body: undefined };
  assert.equal(await client.deleteTask('a/b'), undefined);
  assert.equal(`${seen.method} ${seen.url}`, 'DELETE /tasks/a%2Fb');
});

test('maps an error body to ApiError', async () => {
  reply = { status: 409, body: { error: { code: 'invalid_transition', message: 'cannot start' } } };
  await assert.rejects(client.startTask('t1'), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 409);
    assert.equal(error.code, 'invalid_transition');
    assert.equal(error.message, 'cannot start');
    return true;
  });
});

test('maps a non-JSON error response to ApiError with a generic code', async () => {
  reply = { status: 502, body: 'bad gateway' };
  await assert.rejects(client.listTasks(), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 502);
    assert.equal(error.code, 'unknown');
    return true;
  });
});

test('reports an unreachable control plane with its URL', async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = (closed.address() as AddressInfo).port;
  await new Promise((resolve) => closed.close(resolve));
  const offline = createApiClient(`http://127.0.0.1:${port}`);
  await assert.rejects(offline.listTasks(), (error: unknown) => {
    assert.ok(error instanceof ConnectionError);
    assert.match(error.message, new RegExp(`http://127.0.0.1:${port}`));
    return true;
  });
});

test('sends the given headers on every request', async () => {
  const { port } = server.address() as AddressInfo;
  const withCookie = createApiClient(`http://127.0.0.1:${port}`, { cookie: 'factory_session=abc' });
  reply = { status: 200, body: [] };
  await withCookie.listTasks();
  assert.equal(seen.cookie, 'factory_session=abc');
  reply = { status: 201, body: { id: 't1' } };
  await withCookie.createTask({ projectId: 'p1', title: 'T', specification: 'S' });
  assert.equal(seen.cookie, 'factory_session=abc');
  assert.equal(JSON.parse(seen.body).title, 'T');
  await client.listTasks();
  assert.equal(seen.cookie, undefined);
});

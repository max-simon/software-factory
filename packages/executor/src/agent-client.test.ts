import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { AgentApiError, createAgentClient } from './agent-client.ts';
import { sampleTask } from './test-support.ts';

interface Received {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

let received: Received[] = [];
let respond: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => json(res, 200, { task: sampleTask() });

const server = createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  received.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization, body: text ? JSON.parse(text) : undefined });
  respond(req, res);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());

const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const client = createAgentClient(baseUrl, 'secret-token');

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function reset(handler?: typeof respond): void {
  received = [];
  if (handler) respond = handler;
}

test('sends the bearer token and JSON body and returns the task', async () => {
  reset();
  const plan = [{ title: 'Step', status: 'pending' as const }];
  const task = await client.reportPlan(plan);
  assert.equal(task.id, 't1');
  assert.deepEqual(received, [{ method: 'PUT', url: '/agent/plan', authorization: 'Bearer secret-token', body: { plan } }]);
});

test('maps every operation to its route', async () => {
  reset((_req, res) => json(res, 200, { task: sampleTask() }));
  await client.getTask();
  await client.reportDecision({ problem: 'p', options: [], reasoning: 'r' });
  await client.reportArtifact({ title: 't', kind: 'k', content: 'c' });
  await client.reportPullRequest({ url: 'https://github.com/o/r/pull/1', title: 't' });
  await client.reportMetrics({ durationMs: 1500, costUsd: 0.25 });
  await client.reportReady();
  await client.reportFailure('broken');
  await client.acceptWork(['f1', 'f2']);
  assert.deepEqual(
    received.map((r) => `${r.method} ${r.url}`),
    [
      'GET /agent/task',
      'POST /agent/decisions',
      'POST /agent/artifacts',
      'POST /agent/pull-requests',
      'POST /agent/metrics',
      'POST /agent/ready',
      'POST /agent/failure',
      'POST /agent/work/accept',
    ],
  );
  assert.deepEqual(received[4]!.body, { durationMs: 1500, costUsd: 0.25 });
  assert.deepEqual(received[6]!.body, { reason: 'broken' });
  assert.deepEqual(received[7]!.body, { followUpIds: ['f1', 'f2'] });
});

test('project reads unwrap the project, the summaries and the task view', async () => {
  const project = { id: 'p1', createdAt: 'c', updatedAt: 'u', title: 'Shop', description: '' };
  const summary = { id: 't2', title: 'Other', status: 'ready', labels: [], pullRequests: [], updatedAt: 'u' };
  reset((req, res) => {
    if (req.url === '/agent/project') return json(res, 200, { project });
    if (req.url === '/agent/project/tasks') return json(res, 200, { tasks: [summary] });
    json(res, 200, { task: sampleTask({ id: 't2' }) });
  });
  assert.deepEqual(await client.getProject(), project);
  assert.deepEqual(await client.listProjectTasks(), [summary]);
  assert.equal((await client.getProjectTask('t 2/x')).id, 't2');
  assert.deepEqual(
    received.map((r) => `${r.method} ${r.url} ${r.authorization}`),
    [
      'GET /agent/project Bearer secret-token',
      'GET /agent/project/tasks Bearer secret-token',
      'GET /agent/project/tasks/t%202%2Fx Bearer secret-token',
    ],
  );
});

test('sendHeartbeat posts phase and activity and accepts an empty 204 reply', async () => {
  reset((_req, res) => res.writeHead(204).end());
  assert.equal(await client.sendHeartbeat({ phase: 'working', activity: 'Thinking' }), undefined);
  assert.deepEqual(received, [
    { method: 'POST', url: '/agent/heartbeat', authorization: 'Bearer secret-token', body: { phase: 'working', activity: 'Thinking' } },
  ]);
});

test('requestWork asks with an awaiting_work heartbeat and returns the work, or nothing', async () => {
  const work = { followUps: [{ id: 'f1', createdAt: 'c', message: 'm' }], inputIds: ['q1'] };
  reset((_req, res) => json(res, 200, { work }));
  assert.deepEqual(await client.requestWork(), work);
  assert.deepEqual(received, [
    { method: 'POST', url: '/agent/heartbeat', authorization: 'Bearer secret-token', body: { phase: 'awaiting_work' } },
  ]);
  reset((_req, res) => json(res, 200, {}));
  assert.equal(await client.requestWork(), undefined);
});

test('askQuestion returns the task and the recorded question', async () => {
  const question = { id: 'q1', problem: 'Port?', type: 'text', options: [] };
  reset((_req, res) => json(res, 201, { task: sampleTask(), question }));
  const result = await client.askQuestion({ problem: 'Port?', type: 'text', options: [] });
  assert.deepEqual(result.question, question);
  assert.deepEqual(received[0]!.body, { problem: 'Port?', type: 'text', options: [] });
});

test('a non-2xx response throws the server error code and message', async () => {
  reset((_req, res) => json(res, 409, { error: { code: 'questions_not_allowed', message: 'decide yourself' } }));
  await assert.rejects(client.askQuestion({ problem: 'p', type: 'text', options: [] }), (error) => {
    assert.ok(error instanceof AgentApiError);
    assert.deepEqual([error.status, error.code, error.message], [409, 'questions_not_allowed', 'decide yourself']);
    return true;
  });
});

test('a non-JSON error response still throws with the status', async () => {
  reset((_req, res) => res.writeHead(502).end('bad gateway'));
  await assert.rejects(client.getTask(), { name: 'AgentApiError', code: 'unexpected_response', status: 502 });
});

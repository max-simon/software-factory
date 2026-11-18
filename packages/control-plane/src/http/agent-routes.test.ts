import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { markInProgress, startTask, type ExecutionRuntime, type NewTask } from '@factory/core';
import { SqliteProjectRepository } from '../adapters/sqlite-project-repository.ts';
import { SqliteTaskRepository } from '../adapters/sqlite-task-repository.ts';
import { hashAgentToken } from '../agent-token.ts';
import { ProjectService } from '../project-service.ts';
import { createServices } from '../services.ts';
import { agentRoutes } from './agent-routes.ts';
import { engineerRoutes } from './engineer-routes.ts';
import { createServer } from './server.ts';
import { ada, sequentialItemIds, testAuth } from '../test-support.ts';

const token = 'ab'.repeat(32);
const otherToken = 'cd'.repeat(32);
const fixedNow = '2026-11-12T10:00:00.000Z';

const supervisedTask: NewTask = {
  projectId: 'p1',
  title: 'Add login',
  specification: 'Implement login',
  repoUrl: 'https://github.com/acme/app',
  autonomyMode: 'supervised',
};

class FakeRuntime implements ExecutionRuntime {
  start = async () => ({ executionId: 'unused' });
  listExecutions = async (): Promise<string[]> => [];
  remove = async (): Promise<void> => {};
  notify = async () => ({});
  restart = async () => ({});
}

type Call = (
  method: string,
  path: string,
  /**
   * `cookie` defaults to a signed-in engineer's outside `/agent/*` and to none on agent routes;
   * `authorization` to the task's agent token on agent routes and to none elsewhere.
   */
  options?: { body?: unknown; authorization?: string | null; cookie?: string | null },
) => Promise<{ status: number; json: any }>;

/** Starts the full server with one running task whose agent token is `token`. */
async function startApi(t: TestContext, input: NewTask = supervisedTask, now = () => fixedNow): Promise<Call> {
  const repository = new SqliteTaskRepository(':memory:');
  let counter = 0;
  const { tasks, service, agent } = createServices({
    repository,
    runtime: new FakeRuntime(),
    newId: () => `task-${++counter}`,
    newItemId: sequentialItemIds(),
    now,
  });
  const created = service.create(input, ada);
  repository.save(markInProgress(startTask(created), {
    tokenHash: hashAgentToken(token),
    executionId: 'c-1',
    agentConsole: { url: 'http://127.0.0.1:43021', password: 'console-secret' },
  }, fixedNow));

  let projectCounter = 0;
  const projects = new ProjectService({ repository: new SqliteProjectRepository(':memory:'), newId: () => `p${++projectCounter}` });
  projects.create({ title: 'Checkout', description: 'Everything about checkout' }, ada);
  projects.create({ title: 'Other' }, ada);
  const auth = testAuth();
  const server = createServer([...engineerRoutes(tasks, service, projects), ...agentRoutes(tasks, agent, projects)], {
    authenticate: auth.authenticate,
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return async (method, path, { body, authorization = path.startsWith('/agent/') ? `Bearer ${token}` : null, cookie = path.startsWith('/agent/') ? null : auth.cookie } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(authorization !== null && { authorization }), ...(cookie !== null && { cookie }) },
      ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : undefined };
  };
}

function assertAgentView(json: any): void {
  assert.equal('execution' in json.task, false);
  assert.equal(JSON.stringify(json).includes(hashAgentToken(token)), false);
  assert.equal(JSON.stringify(json).includes('console-secret'), false);
}

const plan = [
  { title: 'Explore', status: 'done' },
  { title: 'Implement', status: 'in_progress', nextStep: 'write the form' },
];
const decision = { problem: 'Session store', options: ['cookie', 'jwt'], chosen: 0, reasoning: 'simpler' };
const artifact = { title: 'Design', kind: 'markdown', content: '# Login' };
const pullRequest = { url: 'https://github.com/acme/app/pull/7', title: 'Add login' };
const radioQuestion = { problem: 'Which provider?', type: 'radio', options: ['github', 'google'] };

test('a supervised task runs the full agent sequence', async (t) => {
  const call = await startApi(t);
  const steps: Array<[string, string, unknown, number, string]> = [
    ['GET', '/agent/task', undefined, 200, 'in_progress'],
    ['PUT', '/agent/plan', { plan }, 200, 'in_progress'],
    ['POST', '/agent/decisions', decision, 200, 'in_progress'],
    ['POST', '/agent/artifacts', artifact, 200, 'in_progress'],
    ['POST', '/agent/questions', radioQuestion, 201, 'input_required'],
  ];
  for (const [method, path, body, status, taskStatus] of steps) {
    const response = await call(method, path, { body });
    assert.equal(response.status, status, path);
    assert.equal(response.json.task.status, taskStatus, path);
    assertAgentView(response.json);
  }

  const answered = await call('POST', '/tasks/task-1/questions/q1/answer', { body: { answer: ['github'] } });
  assert.equal(answered.json.status, 'in_progress');

  for (const [method, path, body, taskStatus] of [
    ['POST', '/agent/pull-requests', pullRequest, 'in_progress'],
    ['POST', '/agent/ready', undefined, 'ready'],
  ] as const) {
    const response = await call(method, path, { body });
    assert.equal(response.status, 200, path);
    assert.equal(response.json.task.status, taskStatus, path);
    assertAgentView(response.json);
  }

  const { json } = await call('GET', '/agent/task');
  assert.deepEqual(json.task.plan, plan);
  assert.deepEqual(json.task.decisions, [{ id: 'd1', createdAt: fixedNow, ...decision }]);
  assert.deepEqual(json.task.artifacts, [{ id: 'a1', createdAt: fixedNow, ...artifact }]);
  assert.deepEqual(json.task.pullRequests, [{ ...pullRequest, status: 'open' }]);
  assert.deepEqual(json.task.questions, [{ id: 'q1', createdAt: fixedNow, ...radioQuestion, answer: ['github'], answeredBy: 'u1' }]);
  assert.equal(json.task.updatedAt, fixedNow);
});

test('a decision without options is recorded as text', async (t) => {
  const call = await startApi(t);
  const textDecision = { problem: 'Session store', options: [], reasoning: 'the app already uses cookies' };
  const response = await call('POST', '/agent/decisions', { body: textDecision });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.task.decisions, [{ id: 'd1', createdAt: fixedNow, ...textDecision }]);
});

test('approval requests block until the engineer reviews every item', async (t) => {
  const call = await startApi(t);
  const requested = await call('POST', '/agent/decisions', { body: { ...decision, requestApproval: true } });
  assert.equal(requested.json.task.status, 'input_required');
  assert.deepEqual(requested.json.task.decisions, [{ id: 'd1', createdAt: fixedNow, ...decision, approval: { status: 'pending' } }]);
  await call('POST', '/agent/artifacts', { body: { ...artifact, requestApproval: true } });

  const approved = await call('POST', '/tasks/task-1/items/d1/review', { body: { verdict: 'approved' } });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.status, 'input_required');
  const annotations = [{ quote: 'Login', comment: 'Call it sign-in' }];
  const changes = await call('POST', '/tasks/task-1/items/a1/review', {
    body: { verdict: 'changes_requested', comment: 'Add a sequence diagram', annotations },
  });
  assert.equal(changes.json.status, 'in_progress');
  assert.deepEqual(changes.json.artifacts[0].approval, {
    status: 'changes_requested',
    comment: 'Add a sequence diagram',
    annotations,
    reviewedBy: 'u1',
  });

  const again = await call('POST', '/tasks/task-1/items/a1/review', { body: { verdict: 'approved' } });
  assert.equal(again.status, 400);
  assert.equal(again.json.error.code, 'invalid_review');
});

test('questions get ids from the store and the stored question is returned', async (t) => {
  const call = await startApi(t);
  const first = await call('POST', '/agent/questions', { body: { problem: 'Why?', type: 'text', options: [] } });
  assert.equal(first.status, 201);
  assert.deepEqual(first.json.question, { id: 'q1', createdAt: fixedNow, problem: 'Why?', type: 'text', options: [] });
  const second = await call('POST', '/agent/questions', { body: { ...radioQuestion, type: 'checkbox' } });
  assert.equal(second.status, 201);
  assert.equal(second.json.question.id, 'q2');
  assert.equal(second.json.task.status, 'input_required');
  assert.deepEqual(second.json.task.questions.map((q: { id: string }) => q.id), ['q1', 'q2']);
  assertAgentView(second.json);
});

test('failure records the reason', async (t) => {
  const call = await startApi(t);
  const { status, json } = await call('POST', '/agent/failure', { body: { reason: 'tests do not compile' } });
  assert.equal(status, 200);
  assert.equal(json.task.status, 'failed');
  assert.equal(json.task.failureReason, 'tests do not compile');
  assertAgentView(json);
});

test('session metrics add up, also after the task has ended', async (t) => {
  const call = await startApi(t);
  const first = await call('POST', '/agent/metrics', { body: { durationMs: 60_000, costUsd: 0.5 } });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json.task.metrics, { durationMs: 60_000, costUsd: 0.5 });
  assertAgentView(first.json);
  await call('POST', '/agent/failure', { body: { reason: 'broken' } });
  const second = await call('POST', '/agent/metrics', { body: { durationMs: 1_500, costUsd: 0 } });
  assert.equal(second.status, 200);
  assert.deepEqual(second.json.task.metrics, { durationMs: 61_500, costUsd: 0.5 });
  const { json } = await call('GET', '/tasks/task-1');
  assert.deepEqual(json.metrics, { durationMs: 61_500, costUsd: 0.5 });
});

test('session metrics need the agent token', async (t) => {
  const call = await startApi(t);
  const { status } = await call('POST', '/agent/metrics', { body: { durationMs: 1, costUsd: 1 }, authorization: null });
  assert.equal(status, 401);
  const { json } = await call('GET', '/agent/task');
  assert.equal('metrics' in json.task, false);
});

test('a missing, malformed or unknown token returns 401', async (t) => {
  const call = await startApi(t);
  const cases: Array<[string, string | null]> = [
    ['missing header', null],
    ['unknown token', `Bearer ${otherToken}`],
    ['no scheme', token],
    ['wrong scheme', `Basic ${token}`],
    ['short token', 'Bearer abcd'],
    ['token hash instead of token', `Bearer ${hashAgentToken(token)}`],
  ];
  for (const [name, authorization] of cases) {
    for (const [method, path, body] of [['GET', '/agent/task', undefined], ['PUT', '/agent/plan', { plan }]] as const) {
      const { status, json } = await call(method, path, { authorization, body });
      assert.equal(status, 401, `${name} ${path}`);
      assert.equal(json.error.code, 'unauthorized', `${name} ${path}`);
    }
  }
  const { json } = await call('GET', '/agent/task');
  assert.deepEqual(json.task.plan, [], 'rejected calls must not change the task');
});

test('a question on an autonomous task returns 409 questions_not_allowed', async (t) => {
  const call = await startApi(t, { ...supervisedTask, autonomyMode: 'autonomous' });
  const { status, json } = await call('POST', '/agent/questions', { body: radioQuestion });
  assert.equal(status, 409);
  assert.equal(json.error.code, 'questions_not_allowed');
  assert.match(json.error.message, /decide yourself/);
});

test('a pull request of another repository returns 400 foreign_pull_request', async (t) => {
  const call = await startApi(t);
  const body = { ...pullRequest, url: 'https://github.com/other/app/pull/7' };
  const { status, json } = await call('POST', '/agent/pull-requests', { body });
  assert.equal(status, 400);
  assert.equal(json.error.code, 'foreign_pull_request');
});

test('reports after ready return 409 not_active', async (t) => {
  const call = await startApi(t);
  await call('POST', '/agent/ready');
  const { status, json } = await call('PUT', '/agent/plan', { body: { plan } });
  assert.equal(status, 409);
  assert.equal(json.error.code, 'not_active');
});

test('a heartbeat is stored with the control-plane time and leaves updatedAt alone', async (t) => {
  let now = fixedNow;
  const call = await startApi(t, supervisedTask, () => now);
  now = '2026-11-12T10:00:15.000Z';
  const sent = await call('POST', '/agent/heartbeat', { body: { phase: 'working', activity: '  Running Bash: yarn test  ' } });
  assert.equal(sent.status, 204);
  assert.equal(sent.json, undefined);

  const { json } = await call('GET', '/tasks/task-1');
  assert.deepEqual(json.execution.lastHeartbeat, { at: now, phase: 'working', activity: 'Running Bash: yarn test' });
  assert.equal(json.updatedAt, fixedNow);

  await call('POST', '/agent/heartbeat', { body: { phase: 'setting_up', activity: 'x'.repeat(300) } });
  const replaced = (await call('GET', '/tasks/task-1')).json.execution.lastHeartbeat;
  assert.equal(replaced.phase, 'setting_up');
  assert.equal(replaced.activity.length, 200);
  await call('POST', '/agent/heartbeat', { body: { phase: 'working', activity: ' ' } });
  assert.deepEqual((await call('GET', '/tasks/task-1')).json.execution.lastHeartbeat, { at: now, phase: 'working' });
});

test('a runner awaiting work first gets the task itself, accepts it, then gets nothing and goes idle', async (t) => {
  const call = await startApi(t);
  const first = await call('POST', '/agent/heartbeat', { body: { phase: 'awaiting_work' } });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { work: { followUps: [], inputIds: [] } });
  const repeated = await call('POST', '/agent/heartbeat', { body: { phase: 'awaiting_work' } });
  assert.deepEqual(repeated.json, first.json, 'a lost reply is simply asked for again');

  const accepted = await call('POST', '/agent/work/accept', { body: { followUpIds: [] } });
  assert.equal(accepted.status, 200);
  assertAgentView(accepted.json);
  await call('POST', '/agent/ready');
  const none = await call('POST', '/agent/heartbeat', { body: { phase: 'awaiting_work' } });
  assert.equal(none.status, 200);
  assert.deepEqual(none.json, {});
  const task = (await call('GET', '/tasks/task-1')).json;
  assert.equal(task.status, 'ready');
  assert.deepEqual(task.execution.worker, { state: 'idle', since: fixedNow });
  assert.deepEqual(task.execution.lastHeartbeat, { at: fixedNow, phase: 'awaiting_work' });
});

test('a runner that finds no work while the task is still in progress fails it', async (t) => {
  const call = await startApi(t);
  await call('POST', '/agent/work/accept', { body: { followUpIds: [] } });
  const none = await call('POST', '/agent/heartbeat', { body: { phase: 'awaiting_work' } });
  assert.deepEqual(none.json, {});
  const task = (await call('GET', '/tasks/task-1')).json;
  assert.equal(task.status, 'failed');
  assert.match(task.failureReason, /ended its turn without reporting/);
});

test('answers and follow-ups become work for the resumed session', async (t) => {
  const call = await startApi(t);
  await call('POST', '/agent/work/accept', { body: { followUpIds: [] } });
  await call('POST', '/agent/questions', { body: radioQuestion });
  await call('POST', '/tasks/task-1/follow-ups', { body: { message: 'Prefer GitHub' } });
  assert.deepEqual((await call('POST', '/agent/heartbeat', { body: { phase: 'awaiting_work' } })).json, {}, 'input is still open');

  await call('POST', '/tasks/task-1/questions/q1/answer', { body: { answer: ['github'] } });
  const { json } = await call('POST', '/agent/heartbeat', { body: { phase: 'awaiting_work' } });
  assert.deepEqual(json.work, {
    followUps: [{ id: 'f1', createdAt: fixedNow, message: 'Prefer GitHub', authorId: 'u1' }],
    inputIds: ['q1'],
  });
});

test('heartbeats are accepted after a failure and rejected once the task is done', async (t) => {
  const call = await startApi(t);
  await call('POST', '/agent/failure', { body: { reason: 'tests do not compile' } });
  const afterFailure = await call('POST', '/agent/heartbeat', { body: { phase: 'working' } });
  assert.equal(afterFailure.status, 204);
  await call('POST', '/tasks/task-1/follow-ups', { body: { message: 'Use Node 26' } });
  await call('POST', '/agent/work/accept', { body: { followUpIds: ['f1'] } });
  await call('POST', '/agent/ready');
  await call('POST', '/tasks/task-1/cancel');
  const { status, json } = await call('POST', '/agent/heartbeat', { body: { phase: 'working' } });
  assert.equal(status, 401, 'cancelling revokes the token');
  assert.equal(json.error.code, 'unauthorized');
});

test('a heartbeat without a valid token returns 401', async (t) => {
  const call = await startApi(t);
  const { status } = await call('POST', '/agent/heartbeat', { body: { phase: 'working' }, authorization: null });
  assert.equal(status, 401);
});

test('invalid bodies return 400 invalid_request', async (t) => {
  const call = await startApi(t);
  const cases: Array<[string, string, unknown]> = [
    ['PUT', '/agent/plan', undefined],
    ['PUT', '/agent/plan', { plan: 'explore' }],
    ['PUT', '/agent/plan', { plan: ['explore'] }],
    ['PUT', '/agent/plan', { plan: [{ title: '', status: 'done' }] }],
    ['PUT', '/agent/plan', { plan: [{ title: 'Explore', status: 'started' }] }],
    ['PUT', '/agent/plan', { plan: [{ title: 'Explore', status: 'done', nextStep: '' }] }],
    ['POST', '/agent/decisions', { ...decision, options: [] }],
    ['POST', '/agent/decisions', { ...decision, options: 'cookie' }],
    ['POST', '/agent/decisions', { ...decision, reasoning: undefined }],
    ['POST', '/agent/decisions', { ...decision, chosen: undefined }],
    ['POST', '/agent/decisions', { ...decision, options: undefined }],
    ['POST', '/agent/decisions', { ...decision, chosen: 2 }],
    ['POST', '/agent/decisions', { ...decision, chosen: 'cookie' }],
    ['POST', '/agent/artifacts', { ...artifact, kind: 1 }],
    ['POST', '/agent/artifacts', { title: 'Design', kind: 'markdown' }],
    ['POST', '/agent/artifacts', { ...artifact, needsApproval: true }],
    ['POST', '/agent/decisions', { ...decision, requestApprovals: true }],
    ['POST', '/agent/pull-requests', { url: pullRequest.url }],
    ['POST', '/agent/pull-requests', { ...pullRequest, status: 'merged' }],
    ['POST', '/agent/questions', { ...radioQuestion, problem: '' }],
    ['POST', '/agent/questions', { ...radioQuestion, type: 'select' }],
    ['POST', '/agent/questions', { ...radioQuestion, options: undefined }],
    ['POST', '/agent/questions', { ...radioQuestion, type: 'text' }],
    ['POST', '/agent/questions', { ...radioQuestion, options: ['github'] }],
    ['POST', '/agent/questions', { ...radioQuestion, type: 'checkbox', options: [] }],
    ['POST', '/agent/questions', { ...radioQuestion, options: ['github', 'github'] }],
    ['POST', '/agent/failure', {}],
    ['POST', '/agent/failure', { reason: ' ' }],
    ['POST', '/agent/decisions', '{not json'],
    ['POST', '/agent/heartbeat', {}],
    ['POST', '/agent/heartbeat', { phase: 'sleeping' }],
    ['POST', '/agent/heartbeat', { phase: 'waiting_for_follow_up' }],
    ['POST', '/agent/heartbeat', { phase: 'working', activity: 7 }],
    ['POST', '/agent/heartbeat', { phase: 'working', at: fixedNow }],
    ['POST', '/agent/metrics', undefined],
    ['POST', '/agent/metrics', { durationMs: 1 }],
    ['POST', '/agent/metrics', { costUsd: 1 }],
    ['POST', '/agent/metrics', { durationMs: -1, costUsd: 0 }],
    ['POST', '/agent/metrics', { durationMs: 1, costUsd: -0.01 }],
    ['POST', '/agent/metrics', { durationMs: '1', costUsd: 0 }],
    ['POST', '/agent/metrics', { durationMs: 1, costUsd: null }],
    ['POST', '/agent/metrics', { durationMs: 1, costUsd: 0, tokens: 3 }],
    ['POST', '/agent/metrics', [1, 0]],
    ['POST', '/agent/metrics', '{"durationMs":1e999,"costUsd":0}'],
  ];
  for (const [method, path, body] of cases) {
    const { status, json } = await call(method, path, { body });
    const name = `${path} ${typeof body === 'string' ? body : JSON.stringify(body)}`;
    assert.equal(status, 400, name);
    assert.equal(json.error.code, 'invalid_request', name);
  }
  const { json } = await call('GET', '/agent/task');
  assert.equal(json.task.status, 'in_progress');
  assert.deepEqual(json.task.questions, []);
  assert.equal('execution' in json.task, false);
  assert.equal('metrics' in json.task, false);
});

test('follow-ups reach the agent and are acknowledged as delivered', async (t) => {
  const call = await startApi(t);
  await call('POST', '/agent/work/accept', { body: { followUpIds: [] } });
  await call('POST', '/agent/ready');
  const sent = await call('POST', '/tasks/task-1/follow-ups', { body: { message: 'Also add a logout button' } });
  assert.equal(sent.json.status, 'in_progress');

  const { json } = await call('GET', '/agent/task');
  assert.deepEqual(json.task.followUps, [{ id: 'f1', createdAt: fixedNow, message: 'Also add a logout button', authorId: 'u1' }]);

  const delivered = await call('POST', '/agent/work/accept', { body: { followUpIds: ['f1'] } });
  assert.equal(delivered.status, 200);
  assert.equal((await call('GET', '/tasks/task-1')).json.execution.workAcceptedAt, fixedNow);
  assert.deepEqual(delivered.json.task.followUps, [
    { id: 'f1', createdAt: fixedNow, message: 'Also add a logout button', authorId: 'u1', deliveredAt: fixedNow },
  ]);
  assertAgentView(delivered.json);

  const reported = await call('POST', '/agent/pull-requests', { body: pullRequest });
  assert.equal(reported.status, 200, 'the resumed agent can report again');
  assert.equal((await call('POST', '/agent/ready')).json.task.status, 'ready');
});

test('a follow-up after a failure lets the agent continue', async (t) => {
  const call = await startApi(t);
  await call('POST', '/agent/failure', { body: { reason: 'tests do not compile' } });
  await call('POST', '/tasks/task-1/follow-ups', { body: { message: 'Use Node 26' } });
  const delivered = await call('POST', '/agent/work/accept', { body: { followUpIds: ['f1'] } });
  assert.equal(delivered.json.task.status, 'in_progress');
  assert.equal('failureReason' in delivered.json.task, false);
  assert.equal((await call('PUT', '/agent/plan', { body: { plan } })).status, 200);
});

test('accepting unknown follow-ups returns 404, malformed bodies 400', async (t) => {
  const call = await startApi(t);
  const unknown = await call('POST', '/agent/work/accept', { body: { followUpIds: ['f1'] } });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'unknown_follow_up');
  for (const body of [undefined, {}, { followUpIds: 'f1' }, { followUpIds: [1] }, { followUpIds: [''] }, { ids: [] }, { followUpIds: [], extra: 1 }]) {
    const { status, json } = await call('POST', '/agent/work/accept', { body });
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(json.error.code, 'invalid_request');
  }
  const rejected = await call('POST', '/agent/work/accept', { authorization: `Bearer ${otherToken}`, body: { followUpIds: [] } });
  assert.equal(rejected.status, 401);
});

const internalFields = ['execution'];

test('an agent reads its own project', async (t) => {
  const call = await startApi(t);
  const { status, json } = await call('GET', '/agent/project');
  assert.equal(status, 200);
  assert.deepEqual(json.project, {
    id: 'p1',
    title: 'Checkout',
    description: 'Everything about checkout',
    autoMerge: false,
    createdBy: 'u1',
    createdAt: json.project.createdAt,
    updatedAt: json.project.updatedAt,
  });
});

test('an agent lists the other tasks of its project without internal fields', async (t) => {
  const call = await startApi(t);
  await call('POST', '/agent/metrics', { body: { durationMs: 1, costUsd: 1 } });
  await call('POST', '/agent/heartbeat', { body: { phase: 'working' } });
  const sibling = await call('POST', '/tasks', { body: { ...supervisedTask, title: 'Add logout' } });
  await call('POST', '/tasks', { body: { ...supervisedTask, projectId: 'p2', title: 'Foreign' } });

  const { status, json } = await call('GET', '/agent/project/tasks');
  assert.equal(status, 200);
  assert.deepEqual(json.tasks.map((task: { id: string }) => task.id), [sibling.json.id]);
  const summaryFields = ['id', 'title', 'status', 'labels', 'repoUrl', 'baseBranch', 'pullRequests', 'updatedAt'];
  assert.deepEqual(Object.keys(json.tasks[0]).filter((key) => !summaryFields.includes(key)), []);
  for (const field of [...internalFields, 'metrics', 'specification']) assert.equal(field in json.tasks[0], false, field);
});

test('an agent reads a sibling task but not one of another project', async (t) => {
  const call = await startApi(t);
  await call('POST', '/agent/metrics', { body: { durationMs: 1, costUsd: 1 } });
  const sibling = await call('POST', '/tasks', { body: { ...supervisedTask, title: 'Add logout' } });
  const foreign = await call('POST', '/tasks', { body: { ...supervisedTask, projectId: 'p2' } });

  const read = await call('GET', `/agent/project/tasks/${sibling.json.id}`);
  assert.equal(read.status, 200);
  assert.equal(read.json.task.title, 'Add logout');
  assert.equal(read.json.task.specification, supervisedTask.specification);
  for (const field of internalFields) assert.equal(field in read.json.task, false, field);

  const own = await call('GET', '/agent/project/tasks/task-1');
  assert.equal(own.status, 200);
  assert.equal('execution' in own.json.task, false);

  const hidden = await call('GET', `/agent/project/tasks/${foreign.json.id}`);
  const unknown = await call('GET', '/agent/project/tasks/nope');
  assert.equal(hidden.status, 404);
  assert.equal(hidden.json.error.code, 'not_found');
  assert.equal(unknown.status, 404);
  assert.deepEqual(
    { ...hidden.json, error: { ...hidden.json.error, message: '' } },
    { ...unknown.json, error: { ...unknown.json.error, message: '' } },
  );
});

test('the project routes need the agent token', async (t) => {
  const call = await startApi(t);
  for (const path of ['/agent/project', '/agent/project/tasks', '/agent/project/tasks/task-1']) {
    const { status, json } = await call('GET', path, { authorization: null });
    assert.equal(status, 401, path);
    assert.equal(json.error.code, 'unauthorized', path);
  }
});

test('changes the agent makes are logged as the agent', async (t) => {
  const call = await startApi(t);
  await call('POST', '/agent/ready');
  const { json } = await call('GET', '/tasks/task-1/changes', { authorization: null });
  assert.deepEqual(json.at(-1), { at: fixedNow, actor: 'agent', field: 'status', from: 'in_progress', to: 'ready' });
});

test('agent routes need no session, and a session is no agent token', async (t) => {
  const call = await startApi(t);
  assert.equal((await call('GET', '/agent/task', { cookie: null })).status, 200);
  assert.equal((await call('GET', '/agent/nope', { cookie: null })).status, 404);
  const engineerCookie = await call('GET', '/tasks/task-1');
  assert.equal(engineerCookie.status, 200);
  const withoutToken = await call('GET', '/agent/task', { authorization: null, cookie: 'factory_session=x' });
  assert.equal(withoutToken.status, 401);
  assert.equal((await call('GET', '/tasks/task-1', { cookie: null })).status, 401);
  // An agent token is no personal access token, and an invalid one does not fall back to the cookie.
  assert.equal((await call('GET', '/tasks/task-1', { authorization: `Bearer ${token}`, cookie: null })).status, 401);
  assert.equal((await call('GET', '/tasks/task-1', { authorization: `Bearer ${token}` })).status, 401);
});

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import {
  addDecision,
  addPullRequest,
  createTask,
  detachExecution,
  disableUser,
  askQuestion,
  markFailed,
  markInProgress,
  markReady,
  renameUser,
  startTask,
  type ExecutionRuntime,
  type IssueProvider,
  type NewQuestion,
  type Task,
  type TaskAgent,
} from '@factory/core';
import { SqliteProjectRepository } from '../adapters/sqlite-project-repository.ts';
import type { SqliteUserRepository } from '../adapters/sqlite-user-repository.ts';
import { SqliteTaskRepository } from '../adapters/sqlite-task-repository.ts';
import { ProjectService } from '../project-service.ts';
import { ReviewTracker } from '../review-tracker.ts';
import { createServices } from '../services.ts';
import { engineerRoutes } from './engineer-routes.ts';
import { createServer } from './server.ts';
import { ada, sequentialItemIds, testAuth } from '../test-support.ts';

const validTask = {
  projectId: 'p1',
  title: 'Add login',
  specification: 'Implement login',
  repoUrl: 'https://github.com/acme/app',
};

const fixedNow = '2026-11-12T10:00:00.000Z';

class FakeRuntime implements ExecutionRuntime {
  start = async () => ({ executionId: 'unused' });
  listExecutions = async (): Promise<string[]> => [];
  readonly removed: string[] = [];
  remove = async (executionId: string): Promise<void> => {
    this.removed.push(executionId);
  };
  notify = async () => ({});
  restart = async () => ({});
}

interface Api {
  repository: SqliteTaskRepository;
  runtime: FakeRuntime;
  base: string;
  /** A `Cookie` header of the signed-in user `ada`; `call` sends it unless given another. */
  cookie: string;
  /** A `Cookie` header of the signed-in user `bob`. */
  bobCookie: string;
  users: SqliteUserRepository;
  call: (method: string, path: string, body?: unknown, cookie?: string) => Promise<{ status: number; json: any }>;
}

/** `unavailableAgent` defaults to every agent being available. */
async function startApi(
  t: TestContext,
  unavailableAgent?: (agent: TaskAgent) => string | undefined,
  reviews?: ReviewTracker,
  issues?: IssueProvider,
): Promise<Api> {
  const repository = new SqliteTaskRepository(':memory:');
  const runtime = new FakeRuntime();
  let counter = 0;
  const { authenticate, cookie, bobCookie, users } = testAuth();
  const { tasks, service } = createServices({
    repository,
    runtime,
    users,
    newId: () => `task-${++counter}`,
    newItemId: sequentialItemIds(),
    now: () => fixedNow,
    log: () => {},
    ...(issues !== undefined && { issues }),
  });
  let projectCounter = 0;
  const projects = new ProjectService({
    repository: new SqliteProjectRepository(':memory:'),
    newId: () => `p${++projectCounter}`,
    now: () => fixedNow,
  });
  projects.create({ title: 'Login', description: 'Sign-in for the app' }, ada);
  const server = createServer(engineerRoutes(tasks, service, projects, unavailableAgent, reviews), { authenticate }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call: Api['call'] = async (method, path, body, as = cookie) => {
    const response = await fetch(base + path, {
      method,
      headers: { cookie: as },
      ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : undefined };
  };
  return { repository, runtime, base, cookie, bobCookie, users, call };
}

const supervisedTask = { ...validTask, autonomyMode: 'supervised' };

test('create returns 201 with defaults and no tokenHash', async (t) => {
  const { call } = await startApi(t);
  const { status, json } = await call('POST', '/tasks', validTask);
  assert.equal(status, 201);
  assert.equal(json.id, 'task-1');
  assert.equal(json.status, 'draft');
  assert.equal(json.autonomyMode, 'autonomous');
  assert.equal(json.model, 'opus');
  assert.equal(json.agent, 'claude');
  assert.deepEqual(json.labels, []);
  assert.equal(json.createdAt, fixedNow);
  assert.equal('tokenHash' in json, false);
});

test('create accepts a task without repository, but not a base branch without one', async (t) => {
  const { call } = await startApi(t);
  const created = await call('POST', '/tasks', { projectId: 'p1', title: 't', specification: 's' });
  assert.equal(created.status, 201);
  assert.equal('repoUrl' in created.json, false);
  const rejected = await call('POST', '/tasks', { projectId: 'p1', title: 't', specification: 's', baseBranch: 'dev' });
  assert.equal(rejected.status, 400);
  assert.match(rejected.json.error.message, /baseBranch requires repoUrl/);
});

test('create keeps optional fields', async (t) => {
  const { call } = await startApi(t);
  const { json } = await call('POST', '/tasks', { ...supervisedTask, labels: ['a'], baseBranch: 'dev', model: 'sonnet', agent: 'opencode' });
  assert.equal(json.autonomyMode, 'supervised');
  assert.deepEqual(json.labels, ['a']);
  assert.equal(json.baseBranch, 'dev');
  assert.equal(json.model, 'sonnet');
  assert.equal(json.agent, 'opencode');
});

test('create refuses an agent without a usable credential with 400, and only on creation', async (t) => {
  const { call } = await startApi(t, (agent) =>
    agent === 'opencode' ? 'agent opencode needs ANTHROPIC_API_KEY, which is not set' : undefined,
  );
  const refused = await call('POST', '/tasks', { ...validTask, agent: 'opencode' });
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.json.error, {
    code: 'invalid_request',
    message: 'agent opencode needs ANTHROPIC_API_KEY, which is not set',
  });
  assert.deepEqual((await call('GET', '/tasks')).json, []);
  const created = await call('POST', '/tasks', validTask);
  assert.equal(created.status, 201);
  assert.equal(created.json.agent, 'claude');
});

test('create checks the default agent too', async (t) => {
  const { call } = await startApi(t, (agent) => `no credential for ${agent}`);
  const { status, json } = await call('POST', '/tasks', validTask);
  assert.equal(status, 400);
  assert.equal(json.error.message, 'no credential for claude');
});

test('create rejects invalid bodies with 400', async (t) => {
  const { call } = await startApi(t);
  const cases: Array<[string, unknown]> = [
    ['missing title', { projectId: 'p1', specification: 's', repoUrl: validTask.repoUrl }],
    ['missing projectId', { title: 't', specification: 's' }],
    ['http repoUrl', { ...validTask, repoUrl: 'http://github.com/acme/app' }],
    ['three path segments', { ...validTask, repoUrl: 'https://github.com/acme/app/tree' }],
    ['bad autonomyMode', { ...validTask, autonomyMode: 'reckless' }],
    ['bad model', { ...validTask, model: 'haiku' }],
    ['non-string model', { ...validTask, model: 1 }],
    ['bad agent', { ...validTask, agent: 'codex' }],
    ['non-string labels', { ...validTask, labels: [1, 2] }],
    ['non-JSON body', '{not json'],
    ['array body', []],
  ];
  for (const [name, body] of cases) {
    const { status, json } = await call('POST', '/tasks', body);
    assert.equal(status, 400, name);
    assert.equal(json.error.code, 'invalid_request', name);
  }
});

test('create rejects a body over 1 MiB', async (t) => {
  const { call } = await startApi(t);
  const { status, json } = await call('POST', '/tasks', { ...validTask, specification: 'x'.repeat(1024 * 1024) });
  assert.equal(status, 400);
  assert.equal(json.error.code, 'invalid_request');
});

test('list returns all tasks without tokenHash', async (t) => {
  const { call, repository } = await startApi(t);
  await call('POST', '/tasks', validTask);
  await call('POST', '/tasks', validTask);
  const { status, json } = await call('GET', '/tasks');
  assert.equal(status, 200);
  assert.deepEqual(json.map((task: Task) => task.id), ['task-1', 'task-2']);
  assert.equal(repository.list().length, 2);
  assert.ok(json.every((task: object) => !('tokenHash' in task)));
});

test('create rejects a task of an unknown project with 404', async (t) => {
  const { call } = await startApi(t);
  const { status, json } = await call('POST', '/tasks', { ...validTask, projectId: 'nope' });
  assert.equal(status, 404);
  assert.match(json.error.message, /project nope not found/);
  assert.deepEqual((await call('GET', '/tasks')).json, []);
});

test('projects are created, listed, shown and edited', async (t) => {
  const { call } = await startApi(t);
  const created = await call('POST', '/projects', { title: 'Billing' });
  assert.equal(created.status, 201);
  assert.deepEqual(created.json, { id: 'p2', createdAt: fixedNow, createdBy: 'u1', updatedAt: fixedNow, title: 'Billing', description: '', autoMerge: false });
  assert.deepEqual((await call('GET', '/projects')).json.map((p: { id: string }) => p.id), ['p1', 'p2']);
  assert.equal((await call('GET', '/projects/p1')).json.description, 'Sign-in for the app');
  const edited = await call('PATCH', '/projects/p1', { description: '', autoMerge: true });
  assert.equal(edited.status, 200);
  assert.deepEqual([edited.json.title, edited.json.description, edited.json.autoMerge], ['Login', '', true]);
  assert.equal((await call('GET', '/projects/nope')).status, 404);
  assert.equal((await call('PATCH', '/projects/nope', { title: 'x' })).status, 404);
});

test('project bodies are validated', async (t) => {
  const { call } = await startApi(t);
  const cases: Array<[string, string, unknown]> = [
    ['missing title', 'POST', {}],
    ['empty title', 'POST', { title: ' ' }],
    ['non-string description', 'POST', { title: 't', description: 1 }],
    ['unknown field', 'POST', { title: 't', owner: 'me' }],
    ['non-boolean autoMerge', 'POST', { title: 't', autoMerge: 'yes' }],
    ['empty title edit', 'PATCH', { title: '' }],
    ['unknown field edit', 'PATCH', { status: 'done' }],
  ];
  for (const [name, method, body] of cases) {
    const path = method === 'POST' ? '/projects' : '/projects/p1';
    assert.equal((await call(method, path, body)).status, 400, name);
  }
});

test('project tasks lists only that project, in rank order', async (t) => {
  const { call } = await startApi(t);
  await call('POST', '/projects', { title: 'Billing' });
  await call('POST', '/tasks', validTask);
  await call('POST', '/tasks', { ...validTask, projectId: 'p2' });
  await call('POST', '/tasks', validTask);
  const { status, json } = await call('GET', '/projects/p1/tasks');
  assert.equal(status, 200);
  assert.deepEqual(json.map((task: Task) => task.id), ['task-1', 'task-3']);
  assert.ok(json.every((task: object) => !('tokenHash' in task)));
  assert.equal((await call('GET', '/projects/nope/tasks')).status, 404);
});

test('move returns only the tasks of the project of the moved task', async (t) => {
  const { call } = await startApi(t);
  await call('POST', '/projects', { title: 'Billing' });
  await call('POST', '/tasks', validTask);
  await call('POST', '/tasks', { ...validTask, projectId: 'p2' });
  await call('POST', '/tasks', validTask);
  const { json } = await call('POST', '/tasks/task-3/move', { before: 'task-1' });
  assert.deepEqual(json.map((task: Task) => task.id), ['task-3', 'task-1']);
});

test('move reorders tasks and returns the new order', async (t) => {
  const { call } = await startApi(t);
  for (let i = 0; i < 3; i++) await call('POST', '/tasks', validTask);
  const up = await call('POST', '/tasks/task-3/move', { before: 'task-1' });
  assert.equal(up.status, 200);
  assert.deepEqual(up.json.map((task: Task) => task.id), ['task-3', 'task-1', 'task-2']);
  const down = await call('POST', '/tasks/task-3/move', {});
  assert.deepEqual(down.json.map((task: Task) => task.id), ['task-1', 'task-2', 'task-3']);
  assert.ok(down.json.every((task: Task) => task.updatedAt === fixedNow && !('tokenHash' in task)));
});

test('move rejects unknown tasks and malformed bodies', async (t) => {
  const { call } = await startApi(t);
  await call('POST', '/tasks', validTask);
  assert.equal((await call('POST', '/tasks/nope/move', {})).json.error.code, 'unknown_task');
  const missingTarget = await call('POST', '/tasks/task-1/move', { before: 'nope' });
  assert.equal(missingTarget.status, 404);
  assert.equal((await call('POST', '/tasks/task-1/move', { before: 3 })).status, 400);
  assert.equal((await call('POST', '/tasks/task-1/move', { after: 'x' })).status, 400);
});

test('show returns the task and 404 for an unknown id', async (t) => {
  const { call } = await startApi(t);
  await call('POST', '/tasks', validTask);
  const found = await call('GET', '/tasks/task-1');
  assert.equal(found.status, 200);
  assert.equal(found.json.title, validTask.title);
  const missing = await call('GET', '/tasks/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'not_found');
});

test('show never exposes a stored tokenHash', async (t) => {
  const { call, repository } = await startApi(t);
  await call('POST', '/tasks', validTask);
  const queued = startTask(repository.get('task-1')!);
  repository.save(markInProgress(queued, { tokenHash: 'secret-hash', executionId: 'c-1' }, '2026-01-01T00:00:00.000Z'));
  const { json } = await call('GET', '/tasks/task-1');
  assert.equal('tokenHash' in json, false);
  assert.equal(JSON.stringify(json).includes('secret-hash'), false);
});

test('the console password stays out of task views and has its own endpoint', async (t) => {
  const { call, repository } = await startApi(t);
  await call('POST', '/tasks', validTask);
  const none = await call('GET', '/tasks/task-1/agent-console');
  assert.equal(none.status, 409);
  assert.equal(none.json.error.code, 'no_execution');

  const agentConsole = { url: 'http://127.0.0.1:43021', password: 'console-secret' };
  repository.save(markInProgress(startTask(repository.get('task-1')!), { tokenHash: 'h', executionId: 'c-1', agentConsole }, '2026-01-01T00:00:00.000Z'));
  const shown = await call('GET', '/tasks/task-1');
  const listed = await call('GET', '/tasks');
  assert.equal(shown.json.execution.consoleUrl, 'http://127.0.0.1:43021');
  assert.equal(JSON.stringify([shown.json, listed.json]).includes('console-secret'), false);
  const { status, json } = await call('GET', '/tasks/task-1/agent-console');
  assert.equal(status, 200);
  assert.deepEqual(json, { url: 'http://127.0.0.1:43021', username: 'opencode', password: 'console-secret' });
});

test('edit updates a draft', async (t) => {
  const { call } = await startApi(t);
  await call('POST', '/tasks', validTask);
  const { status, json } = await call('PATCH', '/tasks/task-1', { title: 'New', labels: ['x'] });
  assert.equal(status, 200);
  assert.equal(json.title, 'New');
  assert.deepEqual(json.labels, ['x']);
  assert.equal(json.specification, validTask.specification);
});

test('edit rejects unknown keys with 400', async (t) => {
  const { call } = await startApi(t);
  await call('POST', '/tasks', validTask);
  const { status, json } = await call('PATCH', '/tasks/task-1', { repoUrl: 'https://github.com/a/b' });
  assert.equal(status, 400);
  assert.equal(json.error.code, 'invalid_request');
});

test('edit rejects the agent and model, which are set on creation only', async (t) => {
  const { call } = await startApi(t);
  await call('POST', '/tasks', validTask);
  for (const edit of [{ agent: 'opencode' }, { model: 'sonnet' }]) {
    const { status, json } = await call('PATCH', '/tasks/task-1', edit);
    assert.equal(status, 400);
    assert.match(json.error.message, /^cannot edit (agent|model)$/);
  }
  assert.equal((await call('GET', '/tasks/task-1')).json.agent, 'claude');
});

test('edit after start returns 409 not_editable', async (t) => {
  const { call } = await startApi(t);
  await call('POST', '/tasks', validTask);
  await call('POST', '/tasks/task-1/start');
  const { status, json } = await call('PATCH', '/tasks/task-1', { title: 'New' });
  assert.equal(status, 409);
  assert.equal(json.error.code, 'not_editable');
});

test('edit of a managed task returns 409 externally_managed, but its dependencies stay editable', async (t) => {
  const api = await startApi(t);
  await api.call('POST', '/tasks', validTask);
  await api.call('POST', '/tasks', validTask);
  const external = { provider: 'github', url: 'https://github.com/acme/app/issues/1', key: 'acme/app#1' };
  api.repository.save({ ...api.repository.get('task-1')!, external });
  const { status, json } = await api.call('PATCH', '/tasks/task-1', { title: 'New' });
  assert.equal(status, 409);
  assert.equal(json.error.code, 'externally_managed');
  const edited = await api.call('PATCH', '/tasks/task-1', { dependsOn: ['task-2'] });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.json.dependsOn, ['task-2']);
  assert.deepEqual(edited.json.external, external);
});

test('create ignores an external link: only the issue sync creates managed tasks', async (t) => {
  const { call } = await startApi(t);
  const external = { provider: 'github', url: 'https://github.com/acme/app/issues/1', key: 'acme/app#1' };
  const { status, json } = await call('POST', '/tasks', { ...validTask, external });
  assert.equal(status, 201);
  assert.equal('external' in json, false);
});

test('start queues a draft and rejects a second start', async (t) => {
  const { call } = await startApi(t);
  await call('POST', '/tasks', validTask);
  const first = await call('POST', '/tasks/task-1/start');
  assert.equal(first.status, 200);
  assert.equal(first.json.status, 'queued');
  const second = await call('POST', '/tasks/task-1/start');
  assert.equal(second.status, 409);
  assert.equal(second.json.error.code, 'invalid_transition');
});

test('start of an unknown task returns 404', async (t) => {
  const { call } = await startApi(t);
  const { status } = await call('POST', '/tasks/nope/start');
  assert.equal(status, 404);
});

async function awaitInput(api: Api, question: NewQuestion): Promise<void> {
  await api.call('POST', '/tasks', supervisedTask);
  const queued = startTask(api.repository.get('task-1')!);
  const running = markInProgress(queued, { tokenHash: 'h', executionId: 'c-1' }, '2026-01-01T00:00:00.000Z');
  api.repository.save(askQuestion(running, question));
}

const radio: NewQuestion = { id: 'q1', createdAt: '2026-01-01T00:00:00Z', problem: 'Which?', type: 'radio', options: ['a', 'b'] };

test('answer resumes the task', async (t) => {
  const api = await startApi(t);
  await awaitInput(api, radio);
  const { status, json } = await api.call('POST', '/tasks/task-1/questions/q1/answer', { answer: ['a'] });
  assert.equal(status, 200);
  assert.equal(json.status, 'in_progress');
  assert.deepEqual(json.questions[0].answer, ['a']);
  assert.equal('tokenHash' in json, false);
});

test('answer rejects an option that was not offered', async (t) => {
  const api = await startApi(t);
  await awaitInput(api, radio);
  const { status, json } = await api.call('POST', '/tasks/task-1/questions/q1/answer', { answer: ['z'] });
  assert.equal(status, 400);
  assert.equal(json.error.code, 'invalid_answer');
});

test('answer to an unknown question returns 404 unknown_question', async (t) => {
  const api = await startApi(t);
  await awaitInput(api, radio);
  const { status, json } = await api.call('POST', '/tasks/task-1/questions/nope/answer', { answer: ['a'] });
  assert.equal(status, 404);
  assert.equal(json.error.code, 'unknown_question');
});

test('answer body must hold an array of strings', async (t) => {
  const api = await startApi(t);
  await awaitInput(api, radio);
  for (const body of [{ answer: 'a' }, { answer: [1] }, {}, ['a']]) {
    const { status, json } = await api.call('POST', '/tasks/task-1/questions/q1/answer', body);
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(json.error.code, 'invalid_request');
  }
});

/** Creates task-1 and stores it running in execution server c-1, then applies `change`. */
async function running(api: Api, change: (task: Task) => Task = (task) => task): Promise<void> {
  await api.call('POST', '/tasks', supervisedTask);
  const queued = startTask(api.repository.get('task-1')!);
  api.repository.save(change(markInProgress(queued, { tokenHash: 'h', executionId: 'c-1' }, '2026-01-01T00:00:00.000Z')));
}

test('follow-up on a running task is stored with id and time and keeps it in progress', async (t) => {
  const api = await startApi(t);
  await running(api);
  const first = await api.call('POST', '/tasks/task-1/follow-ups', { message: ' Also handle logout ' });
  assert.equal(first.status, 200);
  assert.equal(first.json.status, 'in_progress');
  assert.deepEqual(first.json.followUps, [{ id: 'f1', createdAt: fixedNow, message: 'Also handle logout', authorId: 'u1' }]);
  assert.equal('tokenHash' in first.json, false);
  const second = await api.call('POST', '/tasks/task-1/follow-ups', { message: 'And remember me' });
  assert.deepEqual(second.json.followUps.map((f: { id: string }) => f.id), ['f1', 'f2']);
});

test('follow-up moves a ready task back to in progress', async (t) => {
  const api = await startApi(t);
  await running(api, markReady);
  const { status, json } = await api.call('POST', '/tasks/task-1/follow-ups', { message: 'Rename the button' });
  assert.equal(status, 200);
  assert.equal(json.status, 'in_progress');
});

test('follow-up on a task awaiting input keeps it waiting', async (t) => {
  const api = await startApi(t);
  await awaitInput(api, radio);
  const { status, json } = await api.call('POST', '/tasks/task-1/follow-ups', { message: 'Prefer b' });
  assert.equal(status, 200);
  assert.equal(json.status, 'input_required');
});

test('follow-up resumes a failed task that still has its execution server', async (t) => {
  const api = await startApi(t);
  await running(api, (task) => markFailed(task, 'tests fail'));
  const { status, json } = await api.call('POST', '/tasks/task-1/follow-ups', { message: 'Skip the flaky test' });
  assert.equal(status, 200);
  assert.equal(json.status, 'in_progress');
  assert.equal('failureReason' in json, false);
});

test('follow-up on a failed task whose execution server was removed returns 409', async (t) => {
  const api = await startApi(t);
  await running(api, (task) => detachExecution(markFailed(task, 'tests fail')));
  const { status, json } = await api.call('POST', '/tasks/task-1/follow-ups', { message: 'Try again' });
  assert.equal(status, 409);
  assert.equal(json.error.code, 'no_execution');
  assert.equal(api.repository.get('task-1')!.status, 'failed');
  assert.deepEqual(api.repository.get('task-1')!.followUps, []);
});

test('follow-up without an execution server or on a done task returns 409', async (t) => {
  const api = await startApi(t);
  await api.call('POST', '/tasks', validTask);
  const draft = await api.call('POST', '/tasks/task-1/follow-ups', { message: 'm' });
  assert.equal(draft.status, 409);
  assert.equal(draft.json.error.code, 'follow_up_not_allowed');
  const queued = startTask(api.repository.get('task-1')!);
  api.repository.save({ ...queued, status: 'done', execution: { id: 'c-1', tokenHash: 'h', worker: { state: 'idle', since: fixedNow } } });
  const done = await api.call('POST', '/tasks/task-1/follow-ups', { message: 'm' });
  assert.equal(done.status, 409);
  assert.equal(done.json.error.code, 'follow_up_not_allowed');
});

test('follow-up rejects malformed bodies and unknown tasks', async (t) => {
  const api = await startApi(t);
  await running(api);
  for (const body of [{}, { message: '' }, { message: '  ' }, { message: 1 }, { message: 'm', extra: true }, ['m']]) {
    const { status, json } = await api.call('POST', '/tasks/task-1/follow-ups', body);
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(json.error.code, 'invalid_request');
  }
  assert.equal((await api.call('POST', '/tasks/nope/follow-ups', { message: 'm' })).status, 404);
  assert.deepEqual(api.repository.get('task-1')!.followUps, []);
});

test('cancel fails a running task, revokes its token and removes its execution server', async (t) => {
  const api = await startApi(t);
  await running(api);
  const { status, json } = await api.call('POST', '/tasks/task-1/cancel');
  assert.equal(status, 200);
  assert.equal(json.status, 'failed');
  assert.equal(json.failureReason, 'Cancelled by the engineer');
  assert.equal('execution' in json, false);
  assert.deepEqual(api.runtime.removed, ['c-1']);
  assert.equal(api.repository.findByTokenHash('h'), undefined);
});

test('cancel removes no execution server for a queued task and rejects drafts, finished and unknown tasks', async (t) => {
  const api = await startApi(t);
  await api.call('POST', '/tasks', validTask);
  assert.equal((await api.call('POST', '/tasks/task-1/cancel')).json.error.code, 'invalid_transition');
  await api.call('POST', '/tasks/task-1/start');
  assert.equal((await api.call('POST', '/tasks/task-1/cancel')).json.status, 'failed');
  assert.deepEqual(api.runtime.removed, []);
  const again = await api.call('POST', '/tasks/task-1/cancel');
  assert.equal(again.status, 409);
  assert.equal((await api.call('POST', '/tasks/nope/cancel')).status, 404);
});

test('restart queues a running task without its progress and removes the old execution server', async (t) => {
  const api = await startApi(t);
  await running(api, (task) => ({ ...task, plan: [{ title: 'p', status: 'done' }] }));
  const { status, json } = await api.call('POST', '/tasks/task-1/restart');
  assert.equal(status, 200);
  assert.equal(json.status, 'queued');
  assert.deepEqual(json.plan, []);
  assert.equal('execution' in json, false);
  assert.deepEqual(api.runtime.removed, ['c-1']);
  assert.equal(api.repository.findByTokenHash('h'), undefined);
});

test('restart rejects drafts and queued tasks', async (t) => {
  const api = await startApi(t);
  await api.call('POST', '/tasks', validTask);
  const draft = await api.call('POST', '/tasks/task-1/restart');
  assert.equal(draft.status, 409);
  await api.call('POST', '/tasks/task-1/start');
  assert.equal((await api.call('POST', '/tasks/task-1/restart')).json.error.code, 'invalid_transition');
});

test('delete removes a task in any status, stopping its execution server first', async (t) => {
  const api = await startApi(t);
  await running(api);
  await api.call('POST', '/tasks', validTask);
  for (const id of ['task-1', 'task-2']) {
    const { status, json } = await api.call('DELETE', `/tasks/${id}`);
    assert.equal(status, 204);
    assert.equal(json, undefined);
  }
  assert.deepEqual(api.runtime.removed, ['c-1']);
  assert.deepEqual(api.repository.list(), []);
  assert.equal((await api.call('DELETE', '/tasks/task-1')).status, 404);
});

test('delete of a managed task whose issue labels cannot be removed answers 502 and keeps the task', async (t) => {
  const issues: IssueProvider = {
    listIssues: async () => [],
    changeLabels: async () => {
      throw new Error('GitHub is down');
    },
    comment: async () => {},
  };
  const api = await startApi(t, undefined, undefined, issues);
  const external = { provider: 'github' as const, url: 'https://github.com/o/r/issues/7', key: 'o/r#7' };
  api.repository.insert(createTask(validTask, { id: 'm1', now: fixedNow, rank: 1, external }));
  const { status, json } = await api.call('DELETE', '/tasks/m1');
  assert.equal(status, 502);
  assert.equal(json.error.code, 'issue_provider_failed');
  assert.match(json.error.message, /o\/r#7/);
  assert.equal((await api.call('GET', '/tasks/m1')).status, 200);
});

test('dependencies are set on create, replaced until the task starts, and validated', async (t) => {
  const { call } = await startApi(t);
  await call('POST', '/tasks', validTask);
  const created = await call('POST', '/tasks', { ...validTask, dependsOn: ['task-1'] });
  assert.equal(created.status, 201);
  assert.deepEqual(created.json.dependsOn, ['task-1']);
  assert.deepEqual((await call('GET', '/tasks/task-1')).json.dependsOn, []);

  assert.equal((await call('POST', '/tasks', { ...validTask, dependsOn: ['nope'] })).status, 404);
  assert.equal((await call('POST', '/tasks', { ...validTask, dependsOn: 'task-1' })).status, 400);

  await call('POST', '/tasks/task-2/start');
  const cycle = await call('PATCH', '/tasks/task-1', { dependsOn: ['task-2'] });
  assert.equal(cycle.status, 400);
  assert.equal(cycle.json.error.code, 'invalid_dependencies');
  assert.equal((await call('PATCH', '/tasks/task-2', { title: 'x', dependsOn: [] })).status, 409);

  const cleared = await call('PATCH', '/tasks/task-2', { dependsOn: [] });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.status, 'queued');
  assert.deepEqual(cleared.json.dependsOn, []);
});

test('assignees are replaced in any status, deduplicated and logged with the user', async (t) => {
  const { call } = await startApi(t);
  const created = await call('POST', '/tasks', validTask);
  assert.equal('assignees' in created.json, false);
  await call('POST', '/tasks/task-1/start');
  await call('POST', '/tasks/task-1/cancel');

  const assigned = await call('PUT', '/tasks/task-1/assignees', { assignees: ['u2', 'u1', 'u2'] });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.json.status, 'failed');
  assert.deepEqual(assigned.json.assignees, ['u2', 'u1']);
  assert.deepEqual((await call('GET', '/tasks/task-1')).json.assignees, ['u2', 'u1']);
  assert.deepEqual((await call('GET', '/tasks/task-1/changes')).json.at(-1), {
    at: fixedNow,
    actor: 'user',
    userId: 'u1',
    field: 'assignees',
    from: [],
    to: ['u2', 'u1'],
  });

  const cleared = await call('PUT', '/tasks/task-1/assignees', { assignees: [] });
  assert.equal(cleared.status, 200);
  assert.equal('assignees' in cleared.json, false);
});

test('assignees refuse malformed bodies with 400', async (t) => {
  const { call } = await startApi(t);
  await call('POST', '/tasks', validTask);
  for (const body of [{}, { assignees: 'u1' }, { assignees: [''] }, { assignees: [1] }, { assignees: ['u1'], extra: true }, []]) {
    const { status, json } = await call('PUT', '/tasks/task-1/assignees', body);
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(json.error.code, 'invalid_request');
  }
});

test('assignees refuse unknown users with 404 and newly assigned disabled users with 409', async (t) => {
  const api = await startApi(t);
  await api.call('POST', '/tasks', validTask);
  const unknown = await api.call('PUT', '/tasks/task-1/assignees', { assignees: ['u1', 'nobody'] });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'unknown_user');
  assert.equal('assignees' in (await api.call('GET', '/tasks/task-1')).json, false);

  await api.call('PUT', '/tasks/task-1/assignees', { assignees: ['u1', 'u2'] });
  api.users.update(disableUser(api.users.get('u2')!, fixedNow));
  await api.call('POST', '/tasks', validTask);
  const refused = await api.call('PUT', '/tasks/task-2/assignees', { assignees: ['u2'] });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error.code, 'user_disabled');
  const kept = await api.call('PUT', '/tasks/task-1/assignees', { assignees: ['u2'] });
  assert.equal(kept.status, 200);
  assert.deepEqual(kept.json.assignees, ['u2']);
});

test('delete is refused while a task that has not started depends on it', async (t) => {
  const { call } = await startApi(t);
  await call('POST', '/tasks', validTask);
  await call('POST', '/tasks', { ...validTask, dependsOn: ['task-1'] });
  const refused = await call('DELETE', '/tasks/task-1');
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error.code, 'has_waiting_dependents');
  assert.match(refused.json.error.message, /task-2 depend on it/);

  await call('PATCH', '/tasks/task-2', { dependsOn: [] });
  assert.equal((await call('DELETE', '/tasks/task-1')).status, 204);
});

test('unknown route returns 404', async (t) => {
  const { call } = await startApi(t);
  const { status, json } = await call('GET', '/nowhere');
  assert.equal(status, 404);
  assert.equal(json.error.code, 'not_found');
});

test('review rejects malformed bodies, unknown items and change requests without comment', async (t) => {
  const api = await startApi(t);
  await api.call('POST', '/tasks', supervisedTask);
  const queued = startTask(api.repository.get('task-1')!);
  const running = markInProgress(queued, { tokenHash: 'h', executionId: 'c-1' }, '2026-01-01T00:00:00.000Z');
  api.repository.save(
    addDecision(running, { id: 'd1', createdAt: '2026-01-01T00:00:00Z', problem: 'p', options: ['x'], chosen: 0, reasoning: 'r', requestApproval: true }),
  );

  for (const body of [
    {},
    { verdict: 'maybe' },
    { verdict: 'approved', comment: 1 },
    { verdict: 'approved', annotations: 'x' },
    { verdict: 'approved', annotations: [{ quote: 'q' }] },
    { verdict: 'approved', annotations: [{ quote: ' ', comment: 'c' }] },
    { verdict: 'approved', annotations: [{ quote: 'q', comment: 'c', line: 3 }] },
    { verdict: 'approved', notes: [] },
    { verdict: 'approved', chosen: '1' },
    { verdict: 'approved', chosen: -1 },
  ]) {
    const { status, json } = await api.call('POST', '/tasks/task-1/items/d1/review', body);
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(json.error.code, 'invalid_request');
  }
  const unknown = await api.call('POST', '/tasks/task-1/items/d9/review', { verdict: 'approved' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'unknown_item');
  const noComment = await api.call('POST', '/tasks/task-1/items/d1/review', { verdict: 'changes_requested' });
  assert.equal(noComment.status, 400);
  assert.equal(noComment.json.error.code, 'invalid_review');
  const noSuchOption = await api.call('POST', '/tasks/task-1/items/d1/review', { verdict: 'approved', chosen: 1 });
  assert.equal(noSuchOption.status, 400);
  assert.equal(noSuchOption.json.error.code, 'invalid_review');
});

test('rejects requests from other websites in the browser', async (t) => {
  const { base, cookie } = await startApi(t);
  const crossSite = await fetch(`${base}/tasks`, { method: 'POST', headers: { origin: 'https://evil.example', cookie }, body: '{}' });
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).error.code, 'forbidden');
  const sameOrigin = await fetch(`${base}/tasks`, { headers: { origin: base, cookie } });
  assert.equal(sameOrigin.status, 200);
});

test('every engineer route needs a session', async (t) => {
  const { base } = await startApi(t);
  const routes = engineerRoutes({} as never, {} as never, {} as never);
  for (const { method, path } of routes) {
    for (const cookie of [undefined, 'factory_session=unknown']) {
      const response = await fetch(base + path.replaceAll(/:\w+/g, 'x'), { method, ...(cookie && { headers: { cookie } }) });
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal((await response.json()).error.code, 'unauthorized');
    }
  }
  const unknownPath = await fetch(`${base}/nope`, { method: 'POST' });
  assert.equal(unknownPath.status, 401);
});

test('a draft is held for clarification, edited, and queued, and the changelog records each step by the user', async (t) => {
  const { call } = await startApi(t);
  await call('POST', '/tasks', validTask);
  const held = await call('POST', '/tasks/task-1/clarification', { note: 'Which provider?' });
  assert.equal(held.status, 200);
  assert.equal(held.json.status, 'clarification_required');
  assert.equal(held.json.clarification, 'Which provider?');
  const edited = await call('PATCH', '/tasks/task-1', { specification: 'Use GitHub', labels: ['auth'] });
  assert.equal(edited.status, 200);
  const started = await call('POST', '/tasks/task-1/start');
  assert.equal(started.json.status, 'queued');
  assert.equal('clarification' in started.json, false);

  const { status, json } = await call('GET', '/tasks/task-1/changes');
  assert.equal(status, 200);
  assert.deepEqual(json, [
    { at: fixedNow, actor: 'user', userId: 'u1', field: 'created' },
    { at: fixedNow, actor: 'user', userId: 'u1', field: 'status', from: 'draft', to: 'clarification_required' },
    { at: fixedNow, actor: 'user', userId: 'u1', field: 'specification', from: validTask.specification, to: 'Use GitHub' },
    { at: fixedNow, actor: 'user', userId: 'u1', field: 'labels', from: [], to: ['auth'] },
    { at: fixedNow, actor: 'user', userId: 'u1', field: 'status', from: 'clarification_required', to: 'queued' },
  ]);
});

test('a clarification is settled back to draft, and requests are validated', async (t) => {
  const { call } = await startApi(t);
  await call('POST', '/tasks', validTask);
  assert.equal((await call('DELETE', '/tasks/task-1/clarification')).status, 409);
  assert.equal((await call('POST', '/tasks/task-1/clarification', { note: ' ' })).status, 400);
  assert.equal((await call('POST', '/tasks/task-1/clarification', { note: 'n', extra: 1 })).status, 400);
  await call('POST', '/tasks/task-1/clarification', { note: 'n' });
  const settled = await call('DELETE', '/tasks/task-1/clarification');
  assert.equal(settled.json.status, 'draft');
  assert.equal('clarification' in settled.json, false);
  assert.equal((await call('GET', '/tasks/missing/changes')).status, 404);
});

test('task views show the spec, input and pull request reviews running right now', async (t) => {
  const reviews = new ReviewTracker();
  const { call, repository } = await startApi(t, undefined, reviews);
  await call('POST', '/tasks', validTask);
  const url = 'https://github.com/acme/app/pull/1';
  const running = markInProgress(startTask(repository.get('task-1')!), { tokenHash: 'h', executionId: 'c-1' }, fixedNow);
  repository.save(addPullRequest(running, { url, title: 'Login' }));
  const shown = async () => {
    const { json } = await call('GET', '/tasks/task-1');
    const { json: listed } = await call('GET', '/projects/p1/tasks');
    assert.deepEqual(listed[0].isSpecUnderReview, json.isSpecUnderReview, 'lists show the same');
    return { spec: json.isSpecUnderReview, input: json.isInputUnderReview, pr: json.pullRequests[0].isUnderReview };
  };

  assert.deepEqual(await shown(), { spec: false, input: false, pr: false });
  reviews.startSpecReview('task-1');
  reviews.startInputReview('task-1');
  reviews.startPrReview(url);
  assert.deepEqual(await shown(), { spec: true, input: true, pr: true });
  reviews.finishSpecReview('task-1');
  reviews.finishInputReview('task-1');
  reviews.finishPrReview(url);
  assert.deepEqual(await shown(), { spec: false, input: false, pr: false });
});

test('task views show no review running when the routes get no tracker', async (t) => {
  const { call } = await startApi(t);
  const { json } = await call('POST', '/tasks', validTask);
  assert.equal(json.isSpecUnderReview, false);
  assert.equal(json.isInputUnderReview, false);
});

/** ada (u1) and bob (u2) both work on project p1 and task-1, which awaits an answer to q1 and an approval of d1. */
async function workTogether(api: Api): Promise<void> {
  const { call, bobCookie } = api;
  await call('PATCH', '/projects/p1', { title: 'Sign-in', autoMerge: true }, bobCookie);
  await call('PATCH', '/projects/p1', { title: 'Sign-in', description: 'Login and logout' });
  await call('POST', '/tasks', supervisedTask);
  await call('PATCH', '/tasks/task-1', { title: 'Add sign-in' }, bobCookie);
  await call('POST', '/tasks/task-1/start');
  const queued = api.repository.get('task-1')!;
  const running = markInProgress(queued, { tokenHash: 'h', executionId: 'c-1' }, '2026-01-01T00:00:00.000Z');
  const decision = { id: 'd1', createdAt: '2026-01-01T00:00:00Z', problem: 'p', options: ['x'], chosen: 0, reasoning: 'r', requestApproval: true };
  api.repository.save(addDecision(askQuestion(running, radio), decision));
  await call('POST', '/tasks/task-1/questions/q1/answer', { answer: ['a'] }, bobCookie);
  await call('POST', '/tasks/task-1/items/d1/review', { verdict: 'approved' });
  await call('POST', '/tasks/task-1/follow-ups', { message: 'Use OAuth' }, bobCookie);
  await call('POST', '/tasks/task-1/follow-ups', { message: 'Add logout' });
}

test('changes, answers, approvals and follow-ups record the id of the user who made them', async (t) => {
  const api = await startApi(t);
  await workTogether(api);
  const { call } = api;

  const project = await call('GET', '/projects/p1');
  assert.equal(project.json.createdBy, 'u1');
  const projectChanges = await call('GET', '/projects/p1/changes');
  assert.equal(projectChanges.status, 200);
  assert.deepEqual(projectChanges.json, [
    { at: fixedNow, actor: 'user', userId: 'u1', field: 'created' },
    { at: fixedNow, actor: 'user', userId: 'u2', field: 'title', from: 'Login', to: 'Sign-in' },
    { at: fixedNow, actor: 'user', userId: 'u2', field: 'autoMerge', from: false, to: true },
    { at: fixedNow, actor: 'user', userId: 'u1', field: 'description', from: 'Sign-in for the app', to: 'Login and logout' },
  ]);
  assert.equal((await call('GET', '/projects/missing/changes')).status, 404);

  const { json: task } = await call('GET', '/tasks/task-1');
  assert.equal(task.createdBy, 'u1');
  assert.equal(task.questions[0].answeredBy, 'u2');
  assert.equal(task.decisions[0].approval.reviewedBy, 'u1');
  assert.deepEqual(
    task.followUps.map((f: { message: string; authorId: string }) => [f.message, f.authorId]),
    [['Use OAuth', 'u2'], ['Add logout', 'u1']],
  );
  const taskChanges = await call('GET', '/tasks/task-1/changes');
  assert.deepEqual(
    taskChanges.json.map((c: { field: string; userId?: string; to?: unknown }) => [c.field, c.to, c.userId]),
    [
      ['created', undefined, 'u1'],
      ['title', 'Add sign-in', 'u2'],
      ['status', 'queued', 'u1'],
      // The answer leaves d1 open; ada's approval settles the input.
      ['status', 'in_progress', 'u1'],
    ],
  );
});

test('renaming a user changes no task, project or changelog: they hold the id only', async (t) => {
  const api = await startApi(t);
  await workTogether(api);
  const snapshot = async () =>
    Promise.all(['/tasks', '/tasks/task-1/changes', '/projects', '/projects/p1/changes'].map(async (path) => (await api.call('GET', path)).json));
  const before = await snapshot();
  assert.doesNotMatch(JSON.stringify(before), /ada|bob/);

  // What `yarn user rename bob Robert` does.
  api.users.update({ ...renameUser(api.users.get('u2')!, 'Robert'), updatedAt: '2026-11-13T10:00:00.000Z' });
  assert.equal(api.users.get('u2')!.displayName, 'Robert');
  assert.deepEqual(await snapshot(), before);
});

test('an engineer route reached without a principal fails instead of recording no user', () => {
  const projects = new ProjectService({ repository: new SqliteProjectRepository(':memory:') });
  const create = engineerRoutes({} as never, {} as never, projects).find((r) => r.method === 'POST' && r.path === '/projects')!;
  const request = { params: {}, headers: {}, body: { title: 'Billing' }, clientAddress: '127.0.0.1', secure: false };
  assert.throws(() => create.handle(request), /without a principal/);
  assert.deepEqual(projects.list(), []);
});

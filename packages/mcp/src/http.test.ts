import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { ApiError } from './api-client.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHandler } from './http.ts';
import { fakeTaskClient, sampleTask, type FakeTaskClient } from './test-support.ts';

let server: Server;
let baseUrl: string;
let fake: FakeTaskClient;
let forwarded: Array<Record<string, string>> = [];

before(async () => {
  // The server reads `fake` per request, so each test can swap in its own state.
  server = createServer(createMcpHandler((headers) => {
    forwarded.push(headers);
    return {
    createProject: (project) => fake.createProject(project),
    listProjects: () => fake.listProjects(),
    createTask: (task) => fake.createTask(task),
    startTask: (id) => fake.startTask(id),
    editTask: (id, edit) => fake.editTask(id, edit),
    setAssignees: (id, assignees) => fake.setAssignees(id, assignees),
    listUsers: () => fake.listUsers(),
    requestClarification: (id, note) => fake.requestClarification(id, note),
    listTasks: () => fake.listTasks(),
    getTask: (id) => fake.getTask(id),
    cancelTask: (id) => fake.cancelTask(id),
    restartTask: (id) => fake.restartTask(id),
    deleteTask: (id) => fake.deleteTask(id),
    };
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function connect(headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers } }));
  return client;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const client = await connect();
  try {
    const result = await client.callTool({ name, arguments: args });
    const [first] = result.content as Array<{ type: string; text: string }>;
    return { isError: result.isError === true, text: first?.text ?? '' };
  } finally {
    await client.close();
  }
}

test('exposes the project and task tools', async () => {
  fake = fakeTaskClient();
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'cancel_task',
    'create_project',
    'delete_task',
    'get_task',
    'list_projects',
    'list_tasks',
    'list_users',
    'request_clarification',
    'restart_task',
    'set_task',
  ]);
  assert.deepEqual(
    tools.filter((tool) => tool.annotations?.destructiveHint).map((tool) => tool.name).sort(),
    ['cancel_task', 'delete_task', 'restart_task'],
  );
});

test('set_task without id forwards the new task and returns the draft', async () => {
  fake = fakeTaskClient();
  const input = { projectId: 'p1', title: 'Greet', specification: 'Say hi.', repoUrl: 'https://github.com/o/r', model: 'sonnet', agent: 'opencode' };
  const result = await call('set_task', input);
  assert.equal(result.isError, false);
  assert.deepEqual(fake.created, [input]);
  assert.deepEqual(JSON.parse(result.text), fake.tasks[0]);
  assert.equal(fake.tasks[0]!.status, 'draft');
});

test('set_task takes an optional agent, set on creation only', async () => {
  fake = fakeTaskClient();
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();
  const setTask = tools.find((tool) => tool.name === 'set_task')!;
  const agent = (setTask.inputSchema.properties as Record<string, { enum?: string[] }>).agent;
  assert.deepEqual(agent?.enum, ['claude', 'opencode']);
  assert.ok(!setTask.inputSchema.required?.includes('agent'));
  assert.match(setTask.description!, /model and agent are set on creation only/);
});

test('set_task relays the API refusing an agent without a credential', async () => {
  fake = fakeTaskClient();
  fake.createTask = async () => {
    throw new ApiError(400, 'invalid_request', 'agent opencode needs ANTHROPIC_API_KEY, which is not set');
  };
  const result = await call('set_task', { projectId: 'p1', title: 'Greet', specification: 'Say hi.', agent: 'opencode' });
  assert.deepEqual(result, { isError: true, text: 'invalid_request: agent opencode needs ANTHROPIC_API_KEY, which is not set' });
});

test('set_task with id passes an agent on for the API to refuse', async () => {
  fake = fakeTaskClient([sampleTask({ id: 't1' })]);
  fake.editTask = async () => {
    throw new ApiError(400, 'invalid_request', 'cannot edit agent');
  };
  const result = await call('set_task', { id: 't1', agent: 'opencode' });
  assert.deepEqual(result, { isError: true, text: 'invalid_request: cannot edit agent' });
});

test('set_task without id with start queues the task', async () => {
  fake = fakeTaskClient();
  const result = await call('set_task', { projectId: 'p1', title: 'Greet', specification: 'Say hi.', start: true });
  assert.equal(JSON.parse(result.text).status, 'queued');
  assert.deepEqual(fake.created, [{ projectId: 'p1', title: 'Greet', specification: 'Say hi.' }]);
});

test('set_task without id names the draft when starting it fails', async () => {
  fake = fakeTaskClient();
  fake.failStart = new ApiError(409, 'invalid_transition', 'cannot queue');
  const result = await call('set_task', { projectId: 'p1', title: 'Greet', specification: 'Say hi.', start: true });
  assert.deepEqual(result, {
    isError: true,
    text: 'invalid_transition: task t1 was created as a draft but not started: cannot queue',
  });
});

test('request_clarification forwards the note and returns the held task', async () => {
  fake = fakeTaskClient([sampleTask()]);
  const result = await call('request_clarification', { id: 't1', note: 'Which greeting?' });
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.text).status, 'clarification_required');
  assert.equal(fake.tasks[0]!.clarification, 'Which greeting?');
});

test('set_task with id changes the task and creates none', async () => {
  fake = fakeTaskClient([sampleTask({ id: 't1' }), sampleTask({ id: 't2' })]);
  const result = await call('set_task', { id: 't2', title: 'Next', dependsOn: ['t1'] });
  assert.equal(result.isError, false);
  assert.deepEqual(fake.edited, [{ id: 't2', edit: { title: 'Next', dependsOn: ['t1'] } }]);
  assert.deepEqual(fake.created, []);
  assert.deepEqual(JSON.parse(result.text).dependsOn, ['t1']);
});

test('set_task with id and only start queues the task without changing it', async () => {
  fake = fakeTaskClient([sampleTask({ id: 't1' })]);
  const result = await call('set_task', { id: 't1', start: true });
  assert.equal(JSON.parse(result.text).status, 'queued');
  assert.deepEqual(fake.edited, []);
});

test('set_task names the change when starting the changed task fails', async () => {
  fake = fakeTaskClient([sampleTask({ id: 't1' })]);
  fake.failStart = new ApiError(409, 'invalid_transition', 'cannot queue');
  const result = await call('set_task', { id: 't1', title: 'Next', start: true });
  assert.deepEqual(result, { isError: true, text: 'invalid_transition: task t1 was changed but not started: cannot queue' });
});

test('set_task without id needs project id, title and specification', async () => {
  fake = fakeTaskClient();
  const result = await call('set_task', { title: 'Greet', specification: 'Say hi.' });
  assert.equal(result.isError, true);
  assert.match(result.text, /needs projectId, title and specification/);
  assert.deepEqual(fake.created, []);
});

test('set_task without id assigns users to the new task', async () => {
  fake = fakeTaskClient();
  const result = await call('set_task', { projectId: 'p1', title: 'Greet', specification: 'Say hi.', assignees: ['u1'] });
  assert.equal(result.isError, false);
  assert.deepEqual(fake.created, [{ projectId: 'p1', title: 'Greet', specification: 'Say hi.' }]);
  assert.deepEqual(fake.assigned, [{ id: 't1', assignees: ['u1'] }]);
  assert.deepEqual(JSON.parse(result.text).assignees, ['u1']);
});

test('set_task without id assigns users before starting the task', async () => {
  fake = fakeTaskClient();
  const result = await call('set_task', { projectId: 'p1', title: 'Greet', specification: 'Say hi.', assignees: ['u1'], start: true });
  const task = JSON.parse(result.text);
  assert.deepEqual([task.status, task.assignees], ['queued', ['u1']]);
});

test('set_task without id names the draft when assigning fails', async () => {
  fake = fakeTaskClient();
  fake.failAssign = new ApiError(400, 'user_disabled', 'user u1 is disabled');
  const result = await call('set_task', { projectId: 'p1', title: 'Greet', specification: 'Say hi.', assignees: ['u1'], start: true });
  assert.deepEqual(result, {
    isError: true,
    text: 'user_disabled: task t1 was created as a draft but its assignees were not set: user u1 is disabled',
  });
  assert.equal(fake.tasks[0]!.status, 'draft');
});

test('set_task with id and only assignees replaces them without editing', async () => {
  fake = fakeTaskClient([sampleTask({ id: 't1', status: 'in_progress', assignees: ['u1'] })]);
  const result = await call('set_task', { id: 't1', assignees: ['u2'] });
  assert.equal(result.isError, false);
  assert.deepEqual(fake.edited, []);
  assert.deepEqual(fake.assigned, [{ id: 't1', assignees: ['u2'] }]);
  assert.deepEqual(JSON.parse(result.text).assignees, ['u2']);
});

test('set_task with id edits the task and then sets its assignees', async () => {
  fake = fakeTaskClient([sampleTask({ id: 't1' })]);
  const result = await call('set_task', { id: 't1', title: 'Next', assignees: [] });
  assert.deepEqual(fake.edited, [{ id: 't1', edit: { title: 'Next' } }]);
  assert.deepEqual(fake.assigned, [{ id: 't1', assignees: [] }]);
  const task = JSON.parse(result.text);
  assert.deepEqual([task.title, task.assignees], ['Next', []]);
});

test('set_task names the change when assigning after an edit fails', async () => {
  fake = fakeTaskClient([sampleTask({ id: 't1' })]);
  fake.failAssign = new ApiError(400, 'unknown_user', 'user nope does not exist');
  const result = await call('set_task', { id: 't1', title: 'Next', assignees: ['nope'] });
  assert.deepEqual(result, { isError: true, text: 'unknown_user: task t1 was changed but its assignees were not set: user nope does not exist' });
});

test('set_task relays an assignment refused without other changes as is', async () => {
  fake = fakeTaskClient([sampleTask({ id: 't1' })]);
  fake.failAssign = new ApiError(400, 'unknown_user', 'user nope does not exist');
  const result = await call('set_task', { id: 't1', assignees: ['nope'], start: true });
  assert.deepEqual(result, { isError: true, text: 'unknown_user: user nope does not exist' });
  assert.equal(fake.tasks[0]!.status, 'draft');
});

test('set_task names the assignment when starting afterwards fails', async () => {
  fake = fakeTaskClient([sampleTask({ id: 't1' })]);
  fake.failStart = new ApiError(409, 'invalid_transition', 'cannot queue');
  const result = await call('set_task', { id: 't1', assignees: ['u1'], start: true });
  assert.deepEqual(result, { isError: true, text: 'invalid_transition: task t1 was changed but not started: cannot queue' });
});

test('list_users returns the users as the API lists them', async () => {
  fake = fakeTaskClient();
  fake.users = [
    { id: 'u1', username: 'ada', displayName: 'Ada', disabled: false },
    { id: 'u2', username: 'bob', displayName: 'Bob', disabled: true },
  ];
  assert.deepEqual(JSON.parse((await call('list_users')).text), fake.users);
});

test('create_project and list_projects', async () => {
  fake = fakeTaskClient();
  const created = JSON.parse((await call('create_project', { title: 'Login', description: 'Sign-in' })).text);
  assert.deepEqual([created.id, created.title, created.description], ['p1', 'Login', 'Sign-in']);
  assert.deepEqual(JSON.parse((await call('list_projects')).text), [created]);
});

test('list_tasks returns a compact summary and filters by status and project', async () => {
  fake = fakeTaskClient([
    sampleTask({ id: 't1', status: 'done', repoUrl: 'https://github.com/o/r', pullRequests: [{ url: 'https://github.com/o/r/pull/1', title: 'Hi', status: 'merged', isUnderReview: false }], assignees: ['u1'] }),
    sampleTask({ id: 't2', status: 'draft', assignees: [] }),
  ]);
  assert.deepEqual(JSON.parse((await call('list_tasks')).text), [
    {
      id: 't1',
      projectId: 'p1',
      title: 'Add a greeting',
      status: 'done',
      model: 'opus',
      agent: 'claude',
      repoUrl: 'https://github.com/o/r',
      assignees: ['u1'],
      updatedAt: '2026-11-12T00:00:00.000Z',
      pullRequests: ['https://github.com/o/r/pull/1'],
    },
    { id: 't2', projectId: 'p1', title: 'Add a greeting', status: 'draft', model: 'opus', agent: 'claude', updatedAt: '2026-11-12T00:00:00.000Z', pullRequests: [] },
  ]);
  const drafts = JSON.parse((await call('list_tasks', { status: 'draft' })).text) as Array<{ id: string }>;
  assert.deepEqual(drafts.map((task) => task.id), ['t2']);
  fake.tasks.push(sampleTask({ id: 't3', projectId: 'p2' }));
  const other = JSON.parse((await call('list_tasks', { projectId: 'p2' })).text) as Array<{ id: string }>;
  assert.deepEqual(other.map((task) => task.id), ['t3']);
});

test('get_task returns the full task', async () => {
  const task = sampleTask({
    plan: [{ title: 'Write code', status: 'done' }],
    // Who did what goes by user id, never by name.
    createdBy: 'u1',
    assignees: ['u2'],
    followUps: [{ id: 'f1', createdAt: '2026-11-12T00:00:00.000Z', message: 'Say hi', authorId: 'u2' }],
  });
  fake = fakeTaskClient([task]);
  assert.deepEqual(JSON.parse((await call('get_task', { id: 't1' })).text), task);
});

test('cancel_task and restart_task return the updated task', async () => {
  fake = fakeTaskClient([sampleTask({ status: 'in_progress' })]);
  assert.equal(JSON.parse((await call('cancel_task', { id: 't1' })).text).status, 'failed');
  assert.equal(JSON.parse((await call('restart_task', { id: 't1' })).text).status, 'queued');
});

test('delete_task removes the task and names it', async () => {
  fake = fakeTaskClient([sampleTask()]);
  assert.deepEqual(JSON.parse((await call('delete_task', { id: 't1' })).text), { deleted: 't1' });
  assert.deepEqual(fake.tasks, []);
});

test('API errors come back as tool errors', async () => {
  fake = fakeTaskClient();
  assert.deepEqual(await call('get_task', { id: 'nope' }), { isError: true, text: 'not_found: task nope not found' });
});

test('rejects anything but POST', async () => {
  const get = await fetch(`${baseUrl}/mcp`);
  assert.equal(get.status, 405);
  assert.equal(((await get.json()) as { error: { message: string } }).error.message, 'Method not allowed.');
});

test('makes the API client of each request with the caller cookie and bearer token and no other header', async () => {
  fake = fakeTaskClient([sampleTask()]);
  forwarded = [];
  const client = await connect({ cookie: 'factory_session=abc', authorization: 'Bearer xyz', 'x-other': '1' });
  await client.callTool({ name: 'get_task', arguments: { id: 't1' } });
  await client.close();
  assert.ok(forwarded.length > 0);
  for (const headers of forwarded) assert.deepEqual(headers, { cookie: 'factory_session=abc', authorization: 'Bearer xyz' });
});

test('forwards a bearer token alone', async () => {
  fake = fakeTaskClient([sampleTask()]);
  forwarded = [];
  const client = await connect({ authorization: 'Bearer fct_abc' });
  await client.callTool({ name: 'get_task', arguments: { id: 't1' } });
  await client.close();
  assert.ok(forwarded.length > 0);
  for (const headers of forwarded) assert.deepEqual(headers, { authorization: 'Bearer fct_abc' });
});

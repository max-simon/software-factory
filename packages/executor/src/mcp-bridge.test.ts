import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './mcp-bridge.ts';
import { fakeAgentClient, sampleNow, sampleProject, sampleTask, type FakeAgentClient } from './test-support.ts';

async function connect(fake: FakeAgentClient): Promise<Client> {
  const server = new McpServer({ name: 'factory', version: '0.0.0' });
  registerTools(server, fake);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as Array<{ type: string; text: string }>;
  return { isError: result.isError === true, text: first?.text ?? '' };
}

test('exposes exactly the seven reporting tools and the three project reads', async () => {
  const client = await connect(fakeAgentClient());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'ask_question',
    'get_project',
    'get_project_task',
    'list_project_tasks',
    'report_artifact',
    'report_decision',
    'report_failure',
    'report_plan',
    'report_pull_request',
    'report_ready',
  ]);
});

test('report tools forward their input to the agent API', async () => {
  const fake = fakeAgentClient();
  const client = await connect(fake);
  const plan = [{ title: 'Write code', status: 'in_progress', nextStep: 'tests' }];
  const decision = { problem: 'Library?', options: ['a', 'b'], chosen: 0, reasoning: 'smaller' };
  const artifact = { title: 'Analysis', kind: 'markdown', content: '# Findings' };
  const pullRequest = { url: 'https://github.com/o/r/pull/1', title: 'Greeting' };

  assert.deepEqual(await call(client, 'report_plan', { plan }), { isError: false, text: 'plan recorded' });
  await call(client, 'report_decision', decision);
  await call(client, 'report_artifact', artifact);
  await call(client, 'report_pull_request', pullRequest);
  await call(client, 'report_ready');

  assert.deepEqual(fake.task.plan, plan);
  assert.deepEqual(fake.task.decisions, [{ id: 'd1', createdAt: sampleNow, ...decision }]);
  assert.deepEqual(fake.task.artifacts, [{ id: 'a1', createdAt: sampleNow, ...artifact }]);
  assert.deepEqual(fake.task.pullRequests, [{ ...pullRequest, status: 'open' }]);
  assert.equal(fake.task.status, 'ready');
});

test('report_decision and report_artifact return the id and ask to end the turn when approval is requested', async () => {
  const fake = fakeAgentClient();
  const client = await connect(fake);
  const decision = { problem: 'Library?', options: ['a', 'b'], chosen: 0, reasoning: 'smaller' };
  assert.deepEqual(await call(client, 'report_decision', decision), { isError: false, text: 'decision d1 recorded' });
  assert.deepEqual(await call(client, 'report_artifact', { title: 'Design', kind: 'markdown', content: '# x', requestApproval: true }), {
    isError: false,
    text: 'artifact a1 recorded and awaits approval, end your turn now',
  });
  assert.deepEqual(fake.task.artifacts[0]!.approval, { status: 'pending' });
  assert.equal(fake.task.status, 'input_required');
});

test('report_failure records the reason', async () => {
  const fake = fakeAgentClient();
  const client = await connect(fake);
  await call(client, 'report_failure', { reason: 'spec contradicts itself' });
  assert.equal(fake.task.status, 'failed');
  assert.equal(fake.task.failureReason, 'spec contradicts itself');
});

test('ask_question returns the question id and tells the agent to end its turn', async () => {
  const fake = fakeAgentClient();
  const client = await connect(fake);
  const result = await call(client, 'ask_question', { problem: 'Which port?', type: 'radio', options: ['80', '8080'] });
  assert.deepEqual(result, { isError: false, text: 'question q1 recorded, end your turn now' });
  assert.deepEqual(fake.task.questions, [{ id: 'q1', createdAt: sampleNow, problem: 'Which port?', type: 'radio', options: ['80', '8080'] }]);
});

test('API errors come back as tool errors with code and message', async () => {
  const client = await connect(fakeAgentClient(sampleTask({ autonomyMode: 'autonomous' })));
  const result = await call(client, 'ask_question', { problem: 'Name?', type: 'text' });
  assert.equal(result.isError, true);
  assert.equal(result.text, 'questions_not_allowed: decide yourself and report the decision');
});

test('get_project returns the project as JSON', async () => {
  const client = await connect(fakeAgentClient());
  const result = await call(client, 'get_project');
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.text), sampleProject());
});

test('list_project_tasks returns summaries, filtered by status when asked', async () => {
  const fake = fakeAgentClient();
  fake.otherTasks = [
    sampleTask({ id: 't2', title: 'Docs', status: 'ready' }),
    sampleTask({ id: 't3', title: 'Tests', status: 'queued' }),
  ];
  const client = await connect(fake);
  const all = JSON.parse((await call(client, 'list_project_tasks')).text);
  assert.deepEqual(all.map((t: { id: string }) => t.id), ['t2', 't3']);
  assert.equal(all[0].specification, undefined);
  const filtered = JSON.parse((await call(client, 'list_project_tasks', { status: ['queued', 'done'] })).text);
  assert.deepEqual(filtered.map((t: { id: string }) => t.id), ['t3']);
});

test('get_project_task returns the full task, and unknown ids as tool errors', async () => {
  const fake = fakeAgentClient();
  fake.otherTasks = [sampleTask({ id: 't2', specification: 'Write the docs.' })];
  const client = await connect(fake);
  assert.equal(JSON.parse((await call(client, 'get_project_task', { id: 't2' })).text).specification, 'Write the docs.');
  assert.deepEqual(await call(client, 'get_project_task', { id: 'nope' }), { isError: true, text: 'not_found: task nope not found' });
});

test('invalid input is rejected before reaching the agent API', async () => {
  const fake = fakeAgentClient();
  const client = await connect(fake);
  const result = await call(client, 'report_decision', { problem: 'Library?', options: [] });
  assert.equal(result.isError, true);
  assert.deepEqual(fake.calls, []);
});

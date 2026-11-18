import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityOf, activityOfLine } from './claude-status.ts';

const assistant = (...content: object[]) => ({ type: 'assistant', message: { role: 'assistant', content } });
const toolUse = (name: string, input: object = {}) => assistant({ type: 'tool_use', id: 'toolu_1', name, input });

test('session events', () => {
  assert.equal(activityOf({ type: 'system', subtype: 'init', session_id: 'sid', tools: [] }), 'Starting session');
  assert.equal(activityOf({ type: 'system', subtype: 'compact_boundary' }), undefined);
  assert.equal(activityOf({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }), 'Turn finished');
});

test('assistant content blocks', () => {
  assert.equal(activityOf(assistant({ type: 'text', text: 'Done.\n\nAll  tests pass.' })), 'Writing: Done. All tests pass.');
  assert.equal(activityOf(assistant({ type: 'text', text: '  ' })), 'Writing response');
  assert.equal(activityOf(assistant({ type: 'text', text: 'x'.repeat(200) })), `Writing: ${'x'.repeat(110)}…`);
  assert.equal(activityOf(assistant({ type: 'thinking', thinking: 'hmm' })), 'Thinking');
  assert.equal(activityOf(assistant({ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', name: 'Glob', input: {} })), 'Running Glob');
  assert.equal(activityOf(assistant()), undefined);
});

test('tool calls name the tool and a hint from its input', () => {
  assert.equal(activityOf(toolUse('Bash', { command: 'yarn test', description: 'Run the tests' })), 'Running Bash: Run the tests');
  assert.equal(activityOf(toolUse('Bash', { command: 'yarn test\n  && yarn build' })), 'Running Bash: yarn test');
  assert.equal(activityOf(toolUse('Read', { file_path: '/work/src/a.ts' })), 'Running Read: /work/src/a.ts');
  assert.equal(activityOf(toolUse('Edit', { file_path: '/work/b.ts', old_string: 'x' })), 'Running Edit: /work/b.ts');
  assert.equal(activityOf(toolUse('Agent', { description: 'Explore the API', prompt: 'long' })), 'Running Agent: Explore the API');
  assert.equal(activityOf(toolUse('Task', { description: 'Review' })), 'Running Task: Review');
  assert.equal(activityOf(toolUse('TodoWrite', { todos: [] })), 'Running TodoWrite');
  assert.equal(activityOf(toolUse('Bash', { command: 7 })), 'Running Bash');
});

test('factory tools read as what they report', () => {
  assert.equal(activityOf(toolUse('mcp__factory__report_plan', { plan: [] })), 'Reporting plan');
  assert.equal(activityOf(toolUse('mcp__factory__ask_question')), 'Asking a question');
  assert.equal(activityOf(toolUse('mcp__factory__something_new')), 'Running something_new');
  assert.equal(activityOf(toolUse('mcp__other__lookup')), 'Running mcp__other__lookup');
});

test('tool results', () => {
  const result = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } };
  assert.equal(activityOf(result), 'Processing tool result');
  assert.equal(activityOf({ type: 'user', message: { content: 'plain prompt' } }), undefined);
});

test('long activities are truncated', () => {
  const activity = activityOf(toolUse('Bash', { command: 'x'.repeat(500) }))!;
  assert.equal(activity.length, 120);
  assert.ok(activity.startsWith('Running Bash: xxx'));
  assert.ok(activity.endsWith('…'));
});

test('lines that are not events yield nothing', () => {
  assert.equal(activityOfLine('{"type":"result","result":"ok"}'), 'Turn finished');
  for (const line of ['', 'warning: something', '{"type":', '[1,2]', 'null', '{"type":"stream_event"}']) {
    assert.equal(activityOfLine(line), undefined, line);
  }
  assert.equal(activityOf(null), undefined);
  assert.equal(activityOf({ type: 'assistant', message: null }), undefined);
});

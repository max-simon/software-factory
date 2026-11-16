import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityOfEvent } from './opencode-status.ts';

const toolStarted = (name: unknown) => ({ type: 'session.tool.input.started', data: { sessionID: 'ses_1', id: 't1', name } });

test('session events', () => {
  assert.equal(activityOfEvent({ type: 'session.execution.started', data: {} }), 'Starting turn');
  assert.equal(activityOfEvent({ type: 'session.reasoning.started', data: {} }), 'Thinking');
  assert.equal(activityOfEvent({ type: 'session.text.started', data: {} }), 'Writing response');
  assert.equal(activityOfEvent({ type: 'session.idle', data: { sessionID: 'ses_1' } }), 'Turn finished');
});

test('tool calls name the tool; factory tools read as what they report', () => {
  assert.equal(activityOfEvent(toolStarted('shell')), 'Running shell');
  assert.equal(activityOfEvent(toolStarted('factory_report_plan')), 'Reporting plan');
  assert.equal(activityOfEvent(toolStarted('factory_something_new')), 'Running something_new');
  assert.equal(activityOfEvent(toolStarted(7)), undefined);
});

test('anything else changes nothing', () => {
  for (const event of [null, 'text', [], { type: 'session.text.delta', data: {} }, { type: 'server.connected' }, { type: 'session.tool.input.started' }]) {
    assert.equal(activityOfEvent(event), undefined);
  }
});

test('long activities are truncated', () => {
  const activity = activityOfEvent(toolStarted('x'.repeat(300)))!;
  assert.equal(activity.length, 120);
  assert.ok(activity.endsWith('…'));
});

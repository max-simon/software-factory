import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunCommand } from './run-command.ts';
import type { SessionTurn } from './agent-session.ts';
import { claudeArgs, createClaudeSession, mcpConfig, parseTotalCostUsd, sessionError, type ClaudeSessionSettings } from './claude-session.ts';
import { claudeFixture } from './test-support.ts';

const firstTurn = claudeFixture('result-first-turn.jsonl');
const backgroundSubagent = claudeFixture('result-background-subagent.jsonl');

const settings: ClaudeSessionSettings = { mcpConfigPath: '/tmp/mcp.json', systemPrompt: 'rules', model: 'sonnet', cwd: '/work' };
const runTurn = (run: RunCommand, turn: SessionTurn, onActivity?: (activity: string) => void) =>
  createClaudeSession(run, settings).runTurn(turn, onActivity);

const common = [
  '--model',
  'sonnet',
  '--mcp-config',
  '/tmp/mcp.json',
  '--strict-mcp-config',
  '--dangerously-skip-permissions',
  '--output-format',
  'stream-json',
  '--verbose',
  '--append-system-prompt',
  'rules',
];

test('the first turn creates the session under the fixed id', () => {
  assert.deepEqual(claudeArgs(settings, { prompt: 'do it', sessionId: 'sid', isResume: false }), ['-p', 'do it', '--session-id', 'sid', ...common]);
});

test('later turns resume the same session', () => {
  assert.deepEqual(claudeArgs(settings, { prompt: 'answers', sessionId: 'sid', isResume: true }), ['-p', 'answers', '--resume', 'sid', ...common]);
});

test('passes the model alias to the CLI', () => {
  const args = claudeArgs({ ...settings, model: 'opus' }, { prompt: 'x', sessionId: 'sid', isResume: true });
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
});

test('runs claude in the repository, teeing output to the execution server log', async () => {
  const calls: unknown[] = [];
  const run: RunCommand = async (command, args, options) => {
    calls.push([command, args[0], options]);
    return { code: 0, stdout: '', stderr: '' };
  };
  assert.deepEqual(await runTurn(run, { prompt: 'x', sessionId: 'sid', isResume: false }), {});
  assert.deepEqual(calls, [['claude', '-p', { cwd: '/work', teeOutput: true }]]);
});

test('reports the CLI activity from each streamed stdout line', async () => {
  const activities: string[] = [];
  const run: RunCommand = async (_command, _args, options) => {
    for (const line of ['{"type":"system","subtype":"init"}', 'not json', '{"type":"result","result":"ok"}']) {
      options!.onStdoutLine!(line);
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  await runTurn(run, { prompt: 'x', sessionId: 'sid', isResume: false }, (activity) => activities.push(activity));
  assert.deepEqual(activities, ['Starting session', 'Turn finished']);
});

test('a failed turn reports the error from the final result event', async () => {
  const stdout = [
    '{"type":"system","subtype":"init"}',
    '{"type":"result","is_error":true,"result":"Credit balance is too low"}',
  ].join('\n');
  const run: RunCommand = async () => ({ code: 1, stdout, stderr: '' });
  assert.deepEqual(await runTurn(run, { prompt: 'x', sessionId: 'sid', isResume: false }), {
    failure: 'claude session exited with code 1: Credit balance is too low',
  });
});

test('a turn carries the running cost total, also when it failed', async () => {
  const succeeded: RunCommand = async () => ({ code: 0, stdout: `{"type":"system","subtype":"init"}\n${firstTurn}`, stderr: '' });
  assert.deepEqual(await runTurn(succeeded, { prompt: 'x', sessionId: 'sid', isResume: false }), {
    totalCostUsd: 0.0008607700000000001,
  });
  const failed: RunCommand = async () => ({
    code: 1,
    stdout: '{"type":"result","is_error":true,"result":"Prompt is too long","total_cost_usd":0.5}',
    stderr: '',
  });
  assert.deepEqual(await runTurn(failed, { prompt: 'x', sessionId: 'sid', isResume: true }), {
    failure: 'claude session exited with code 1: Prompt is too long',
    totalCostUsd: 0.5,
  });
});

test('the total cost comes from the result event', () => {
  assert.equal(parseTotalCostUsd(firstTurn), 0.0008607700000000001);
});

test('of several result events, the last one holds the total', () => {
  assert.equal(backgroundSubagent.trim().split('\n').length, 2);
  assert.equal(parseTotalCostUsd(backgroundSubagent), 0.0008341450000000001);
});

test('without a usable total there is no cost', () => {
  assert.equal(parseTotalCostUsd(''), undefined);
  assert.equal(parseTotalCostUsd('{"type":"system","subtype":"init"}\n{"type":"assistant","total_cost_usd":1}'), undefined);
  assert.equal(parseTotalCostUsd(`cut-off {"type":\n${firstTurn.slice(0, 300)}`), undefined);
  assert.equal(parseTotalCostUsd('null\n42\n"text"'), undefined);
  assert.equal(parseTotalCostUsd('{"type":"result","total_cost_usd":-0.5}'), undefined);
  assert.equal(parseTotalCostUsd('{"type":"result","total_cost_usd":"0.5"}'), undefined);
  assert.equal(parseTotalCostUsd('{"type":"result","result":"done"}'), undefined);
});

test('a result event without a total hides earlier totals', () => {
  assert.equal(parseTotalCostUsd(`${firstTurn}{"type":"result","result":"done"}`), undefined);
});

test('without a result event the error falls back to the end of stderr', () => {
  assert.equal(sessionError('cut-off {"type":', 'line 1\nunknown option --foo\n'), 'line 1\nunknown option --foo');
  assert.equal(sessionError('', ''), undefined);
});

test('the MCP config runs the bridge with node and the agent API credentials', () => {
  assert.deepEqual(mcpConfig('/app/bridge.ts', { controlPlaneUrl: 'http://cp', taskToken: 'tok' }), {
    mcpServers: {
      factory: {
        command: process.execPath,
        args: ['/app/bridge.ts'],
        env: { FACTORY_CONTROL_PLANE_URL: 'http://cp', FACTORY_TASK_TOKEN: 'tok' },
      },
    },
  });
});

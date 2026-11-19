import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunCommand } from './run-command.ts';
import type { SessionTurn } from './agent-session.ts';
import {
  claudeArgs,
  createClaudeSession,
  mcpConfig,
  parseTotalCostUsd,
  parseTotalTokens,
  rateLimitOfLine,
  sessionError,
  type ClaudeSessionSettings,
} from './claude-session.ts';
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
    calls.push([command, args[0], options?.cwd, options?.teeOutput]);
    return { code: 0, stdout: '', stderr: '' };
  };
  assert.deepEqual(await runTurn(run, { prompt: 'x', sessionId: 'sid', isResume: false }), {});
  assert.deepEqual(calls, [['claude', '-p', '/work', true]]);
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

// Shapes as claude 2.1.311 prints them. The `allowed` line is real output; a
// `rejected` one could not be provoked, so it follows the CLI's event schema.
const allowedEvent =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1795146000,"rateLimitType":"five_hour","overageStatus":"allowed","overageResetsAt":1796083200,"isUsingOverage":false},"uuid":"u1","session_id":"s1"}';
const rejectedEvent =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1795146000,"rateLimitType":"five_hour","isUsingOverage":false},"uuid":"u2","session_id":"s1"}';
const limitResult = '{"type":"result","subtype":"success","is_error":true,"result":"You\'ve hit your limit · resets 3:40am (UTC)"}';
const streaming = (lines: string[], code: number, stdout = ''): RunCommand => async (_command, _args, options) => {
  lines.forEach((line) => options!.onStdoutLine!(line));
  return { code, stdout, stderr: '' };
};

test('rateLimitOfLine reads status and reset time of a rate limit event, and nothing else', () => {
  assert.deepEqual(rateLimitOfLine(allowedEvent), { isRejected: false, resetsAt: '2026-11-20T03:40:00.000Z' });
  assert.deepEqual(rateLimitOfLine(rejectedEvent), { isRejected: true, resetsAt: '2026-11-20T03:40:00.000Z' });
  assert.deepEqual(rateLimitOfLine('{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}'), { isRejected: true });
  for (const resetsAt of ['"soon"', '1.5', '-1', '1e20']) {
    const line = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${resetsAt}}}`;
    assert.deepEqual(rateLimitOfLine(line), { isRejected: true }, resetsAt);
  }
  for (const line of ['{"type":"assistant","message":{"content":[{"type":"text","text":"rate_limit_event"}]}}', '{"type":"rate_limit_event"}', '"rate_limit_event" {']) {
    assert.equal(rateLimitOfLine(line), undefined, line);
  }
});

test('a turn that fails after a rejected rate limit event hit the usage limit', async () => {
  const outcome = await runTurn(streaming([allowedEvent, rejectedEvent, limitResult], 1, limitResult), { prompt: 'x', sessionId: 'sid', isResume: true });
  assert.deepEqual(outcome, {
    failure: "claude session exited with code 1: You've hit your limit · resets 3:40am (UTC)",
    usageLimit: { resetsAt: '2026-11-20T03:40:00.000Z' },
  });
});

test('an error result after a rejected event hits the limit even when the CLI exits with 0', async () => {
  const outcome = await runTurn(streaming([rejectedEvent.replace(',"resetsAt":1795146000', '')], 0, limitResult), { prompt: 'x', sessionId: 'sid', isResume: true });
  assert.deepEqual(outcome.usageLimit, {});
  assert.match(outcome.failure!, /hit your limit/);
});

test('a rejected event is no usage limit when the turn succeeded, nor an allowed one when it failed', async () => {
  assert.deepEqual(await runTurn(streaming([rejectedEvent, allowedEvent], 0), { prompt: 'x', sessionId: 'sid', isResume: true }), {});
  assert.deepEqual(await runTurn(streaming([rejectedEvent], 0), { prompt: 'x', sessionId: 'sid', isResume: true }), {});
  const failed = await runTurn(streaming([rejectedEvent, allowedEvent], 1), { prompt: 'x', sessionId: 'sid', isResume: true });
  assert.equal(failed.usageLimit, undefined);
});

test('a turn carries the running cost and token totals, also when it failed', async () => {
  const succeeded: RunCommand = async () => ({ code: 0, stdout: `{"type":"system","subtype":"init"}\n${firstTurn}`, stderr: '' });
  assert.deepEqual(await runTurn(succeeded, { prompt: 'x', sessionId: 'sid', isResume: false }), {
    totalCostUsd: 0.0008607700000000001,
    totalTokens: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 11507, cacheCreationTokens: 5948 },
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

test('the token totals come from the last result event', () => {
  assert.deepEqual(parseTotalTokens(firstTurn), { inputTokens: 2, outputTokens: 4, cacheReadTokens: 11507, cacheCreationTokens: 5948 });
  assert.deepEqual(parseTotalTokens(backgroundSubagent), { inputTokens: 10, outputTokens: 157, cacheReadTokens: 62752, cacheCreationTokens: 1017 });
});

test('token totals are summed over models', () => {
  const usage = (n: number) => ({ inputTokens: n, outputTokens: 2 * n, cacheReadInputTokens: 3 * n, cacheCreationInputTokens: 4 * n, costUSD: 1 });
  const stdout = JSON.stringify({ type: 'result', modelUsage: { opus: usage(1), haiku: usage(10) } });
  assert.deepEqual(parseTotalTokens(stdout), { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheCreationTokens: 44 });
});

test('a malformed model entry is skipped', () => {
  const good = { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 };
  const malformed = [null, 7, { ...good, outputTokens: -1 }, { ...good, inputTokens: '10' }, { inputTokens: 5 }];
  for (const entry of malformed) {
    const stdout = JSON.stringify({ type: 'result', modelUsage: { good, bad: entry } });
    assert.deepEqual(parseTotalTokens(stdout), { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 }, JSON.stringify(entry));
  }
});

test('without usable model usage there are no token totals', () => {
  assert.equal(parseTotalTokens(''), undefined);
  assert.equal(parseTotalTokens('{"type":"result","total_cost_usd":0.5}'), undefined);
  assert.equal(parseTotalTokens('{"type":"result","modelUsage":[]}'), undefined);
  assert.equal(parseTotalTokens('{"type":"result","modelUsage":{}}'), undefined);
  assert.equal(parseTotalTokens('{"type":"result","modelUsage":{"opus":{"inputTokens":-1}}}'), undefined);
  assert.equal(parseTotalTokens(`${firstTurn}{"type":"result","result":"done"}`), undefined);
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

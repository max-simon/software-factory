import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, NewSession, OpencodeApi } from './opencode-api.ts';
import { createOpencodeSession, type OpencodeSessionSettings } from './opencode-session.ts';

const settings: OpencodeSessionSettings = { agent: 'factory', model: 'sonnet', cwd: '/work' };
const idle = (created: number, outcome: 'succeeded' | 'failed' | 'interrupted' = 'succeeded', error?: { type: string; message: string }): Message => ({
  type: 'idle',
  time: { created },
  outcome,
  ...(error && { error }),
});

interface FakeApi extends OpencodeApi {
  calls: string[];
  created: NewSession[];
}

/** `latest` answers the message checks in order; the prompt is admitted at time 100. */
function fakeApi(latest: Array<Message | undefined>, options: { cost?: number; events?: unknown[]; failing?: string } = {}): FakeApi {
  const fake: FakeApi = {
    calls: [],
    created: [],
    createSession: async (session) => {
      fake.calls.push('create');
      fake.created.push(session);
    },
    prompt: async (_id, text) => {
      fake.calls.push(`prompt ${text}`);
      if (options.failing === 'prompt') throw new Error('POST /api/session/ses_1/prompt returned 503: down');
      return { admittedAt: 100 };
    },
    waitIdle: async () => {
      fake.calls.push('wait');
    },
    latestMessage: async () => latest.shift(),
    cost: async () => options.cost ?? 0,
    events: async function* (signal) {
      for (const event of options.events ?? []) yield event;
      // Stays open like the live stream until the turn ends.
      await new Promise((resolve) => signal.addEventListener('abort', resolve));
    },
  };
  return fake;
}

const deps = (api: OpencodeApi, sleeps: number[] = []) => ({
  api,
  sleep: async (ms: number) => void sleeps.push(ms),
  log: () => {},
});

test('the first turn creates the session with the agent, the exact model and the repository', async () => {
  const api = fakeApi([idle(150)], { cost: 0.25 });
  const outcome = await createOpencodeSession(deps(api), settings).runTurn({ prompt: 'do it', sessionId: 'ses_1', isResume: false });
  assert.deepEqual(outcome, { totalCostUsd: 0.25 });
  assert.deepEqual(api.created, [{ id: 'ses_1', agent: 'factory', model: { providerID: 'anthropic', id: 'claude-sonnet-5-5' }, directory: '/work' }]);
  assert.deepEqual(api.calls, ['create', 'prompt do it', 'wait']);
});

test('later turns only prompt the existing session', async () => {
  const api = fakeApi([idle(150)]);
  await createOpencodeSession(deps(api), { ...settings, model: 'opus' }).runTurn({ prompt: 'answers', sessionId: 'ses_1', isResume: true });
  assert.deepEqual(api.calls, ['prompt answers', 'wait']);
});

test('waits again until an idle message newer than the prompt appears', async () => {
  const user: Message = { type: 'user', time: { created: 100 } };
  const sleeps: number[] = [];
  const api = fakeApi([idle(90), user, idle(150)]);
  assert.deepEqual(await createOpencodeSession(deps(api, sleeps), settings).runTurn({ prompt: 'x', sessionId: 'ses_1', isResume: true }), { totalCostUsd: 0 });
  assert.deepEqual(api.calls, ['prompt x', 'wait', 'wait', 'wait']);
  assert.deepEqual(sleeps, [1000, 1000]);
});

test('a failed or interrupted turn carries the cause and the cost so far', async () => {
  const failed = fakeApi([idle(150, 'failed', { type: 'provider.auth', message: 'invalid x-api-key' })], { cost: 0.5 });
  assert.deepEqual(await createOpencodeSession(deps(failed), settings).runTurn({ prompt: 'x', sessionId: 'ses_1', isResume: true }), {
    failure: 'opencode turn failed: provider.auth: invalid x-api-key',
    totalCostUsd: 0.5,
  });
  const interrupted = fakeApi([idle(150, 'interrupted')]);
  assert.deepEqual(await createOpencodeSession(deps(interrupted), settings).runTurn({ prompt: 'x', sessionId: 'ses_1', isResume: true }), {
    failure: 'opencode turn was interrupted',
    totalCostUsd: 0,
  });
});

test('an unreachable server fails the turn instead of throwing', async () => {
  const api = fakeApi([], { failing: 'prompt' });
  assert.deepEqual(await createOpencodeSession(deps(api), settings).runTurn({ prompt: 'x', sessionId: 'ses_1', isResume: true }), {
    failure: 'opencode session failed: POST /api/session/ses_1/prompt returned 503: down',
  });
});

test('streams the activity while the turn runs', async () => {
  const events = [
    { type: 'session.execution.started', data: {} },
    { type: 'session.text.delta', data: {} },
    { type: 'session.tool.input.started', data: { name: 'factory_report_plan' } },
  ];
  const api = fakeApi([idle(150)], { events });
  // The stream runs alongside the turn: let it deliver before the turn ends.
  const slowWait = api.waitIdle;
  api.waitIdle = async (id) => {
    await new Promise((resolve) => setImmediate(resolve));
    return slowWait(id);
  };
  const activities: string[] = [];
  await createOpencodeSession(deps(api), settings).runTurn({ prompt: 'x', sessionId: 'ses_1', isResume: true }, (a) => activities.push(a));
  assert.deepEqual(activities, ['Starting turn', 'Reporting plan']);
});

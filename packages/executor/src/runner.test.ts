import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentApiError } from './agent-client.ts';
import { createClaudeSession } from './claude-session.ts';
import { createDoorbell, type Doorbell } from './doorbell.ts';
import { createHeartbeat } from './heartbeat.ts';
import type { CommandResult, RunCommand } from './run-command.ts';
import { runWorker, type RunnerDeps } from './runner.ts';
import type { SessionState, SessionStore } from './session-state.ts';
import { answerAll, claudeFixture, fakeAgentClient, reviewAll, sampleTask, sendFollowUp, type FakeAgentClient } from './test-support.ts';

/** One agent turn; `beat` fires the heartbeat interval by hand. Returns claude's exit code. */
type Turn = (fake: FakeAgentClient, beat: () => void) => Promise<number>;

interface Harness {
  fake: FakeAgentClient;
  commands: string[];
  prompts: string[];
  /** The session id of every claude run, in order. */
  sessionIds: string[];
  logs: string[];
  /** What the execution server's disk holds across runner processes. */
  saved: SessionState | undefined;
  retries: number;
  /** A new runner process with the same disk and the same control plane. */
  start: () => Promise<number>;
}

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });

function closedDoorbell(): Doorbell {
  const doorbell = createDoorbell();
  doorbell.close();
  return doorbell;
}

function harness(options: {
  turns: Turn[];
  failing?: string;
  baseBranch?: string;
  /** Streamed line by line while a session runs, before its turn. */
  claudeLines?: string[];
  /** Claude's stdout, one entry per turn; turns without one print nothing. */
  claudeOutputs?: string[];
  /** How long each claude run takes on the fake clock; 1000 ms when unset. */
  turnMs?: number[];
  withoutRepository?: boolean;
  /** Unset: a closed doorbell, so the runner stops at the first lack of work as if it were stopped there. */
  doorbell?: Doorbell;
}): Harness {
  const { repoUrl, ...repoLess } = sampleTask();
  const fake = fakeAgentClient(options.withoutRepository ? repoLess : { ...repoLess, repoUrl });
  let clock = 0;
  let beat = () => {};
  let sessionCounter = 0;
  const run: RunCommand = async (command, args, commandOptions) => {
    if (command === 'claude') {
      h.commands.push(`claude ${args.includes('--resume') ? 'resume' : 'start'}`);
      h.prompts.push(args[1]!);
      h.sessionIds.push(args[args.findIndex((a) => a === '--resume' || a === '--session-id') + 1]!);
      options.claudeLines?.forEach((l) => commandOptions?.onStdoutLine?.(l));
      clock += options.turnMs?.shift() ?? 1000;
      return { ...ok(options.claudeOutputs?.shift()), code: await options.turns.shift()!(fake, beat) };
    }
    const line = [command, ...args].join(' ');
    h.commands.push(line);
    if (options.failing && line.startsWith(options.failing)) return { code: 128, stdout: '', stderr: 'not found' };
    return ok();
  };
  const sessions: SessionStore = {
    load: async () => h.saved,
    save: async (state) => {
      h.saved = { ...state };
    },
  };
  const deps = (): RunnerDeps => ({
    client: fake,
    run,
    log: (message) => h.logs.push(message),
    repository: {
      ...(options.withoutRepository ? {} : { repoUrl: 'https://github.com/o/r' }),
      gitUserName: 'Factory',
      gitUserEmail: 'factory@example.com',
      ...(options.baseBranch ? { baseBranch: options.baseBranch } : {}),
    },
    workDir: '/work',
    session: createClaudeSession(run, { mcpConfigPath: '/tmp/mcp.json', systemPrompt: 'rules', model: 'opus', cwd: '/work' }),
    sessions,
    newSessionId: () => `sid-${++sessionCounter}`,
    now: () => clock,
    retry: {
      attempts: 3,
      delayMs: 15_000,
      sleep: async () => {
        h.retries += 1;
      },
    },
    heartbeat: createHeartbeat({
      send: (heartbeat) => fake.sendHeartbeat(heartbeat),
      intervalMs: 15_000,
      log: () => {},
      schedule: (tick) => {
        beat = tick;
        return () => (beat = () => {});
      },
    }),
    doorbell: options.doorbell ?? closedDoorbell(),
  });
  const h: Harness = { fake, commands: [], prompts: [], sessionIds: [], logs: [], saved: undefined, retries: 0, start: () => runWorker(deps()) };
  return h;
}

const ready: Turn = async (fake) => (await fake.reportReady(), 0);
const ask: Turn = async (fake) => (await fake.askQuestion({ problem: 'Which port?', type: 'text', options: [] }), 0);
const claudeTurns = (h: Harness) => h.commands.filter((c) => c.startsWith('claude'));
const workCalls = (h: Harness) => h.fake.calls.filter((c) => c === 'requestWork' || c === 'acceptWork');

test('asks for work, sets up git and the clone, runs the first session, then waits for the doorbell', async () => {
  const h = harness({ turns: [ready], baseBranch: 'develop' });
  assert.equal(await h.start(), 0);
  assert.deepEqual(h.commands, [
    'rm -rf /work',
    'gh auth setup-git',
    'git config --global user.name Factory',
    'git config --global user.email factory@example.com',
    'git clone https://github.com/o/r /work',
    'git -C /work checkout develop',
    'claude start',
  ]);
  assert.deepEqual(workCalls(h), ['requestWork', 'acceptWork', 'requestWork']);
  assert.match(
    h.prompts[0]!,
    /# Task: Add a greeting[\s\S]*Labels: demo\n\n## Project: Greeter\n\nFriendly command-line tools\.\n\n## Specification\n\nPrint hello\./,
  );
  assert.equal(h.fake.task.status, 'ready');
  assert.deepEqual(h.saved, { sessionId: 'sid-1', costUsd: 0 });
  assert.ok(h.logs.includes('no work, waiting for the doorbell'));
});

test('a project without a description gets only its title in the first prompt', async () => {
  const h = harness({ turns: [ready] });
  h.fake.project = { ...h.fake.project, description: '' };
  assert.equal(await h.start(), 0);
  assert.match(h.prompts[0]!, /## Project: Greeter\n\n## Specification\n/);
});

test('without a repository: an empty work directory and no git set-up', async () => {
  const h = harness({ turns: [ready], withoutRepository: true });
  assert.equal(await h.start(), 0);
  assert.deepEqual(h.commands, ['rm -rf /work', 'mkdir -p /work', 'claude start']);
  assert.match(h.prompts[0]!, /Repository: none\./);
});

test('a failing set-up step reports failure, starts no session and stops', async () => {
  const h = harness({ turns: [], failing: 'git clone' });
  assert.equal(await h.start(), 0);
  assert.equal(h.fake.task.status, 'failed');
  assert.match(h.fake.task.failureReason!, /git clone exited with code 128: not found/);
  assert.deepEqual(claudeTurns(h), []);
  assert.equal(h.saved, undefined);
});

test('input required: stops, and a restarted runner resumes the same session with the answers', async () => {
  const h = harness({ turns: [ask, ready] });
  assert.equal(await h.start(), 0);
  assert.equal(h.fake.task.status, 'input_required');
  assert.deepEqual(workCalls(h), ['requestWork', 'acceptWork', 'requestWork']);

  answerAll(h.fake, ['8080']);
  assert.equal(await h.start(), 0);
  assert.deepEqual(claudeTurns(h), ['claude start', 'claude resume']);
  assert.deepEqual(h.sessionIds, ['sid-1', 'sid-1']);
  assert.match(h.prompts[1]!, /q1: Which port\?\n  Answer: 8080/);
  assert.match(h.prompts[1]!, /Continue the task\./);
  assert.equal(h.fake.task.status, 'ready');
});

test('approval requested: a restarted runner resumes with verdict, comment and annotations', async () => {
  const request: Turn = async (fake) =>
    (await fake.reportArtifact({ title: 'Design', kind: 'markdown', content: '# x', requestApproval: true }), 0);
  const h = harness({ turns: [request, ready] });
  await h.start();
  reviewAll(h.fake, {
    status: 'changes_requested',
    comment: 'Add a diagram',
    annotations: [{ quote: 'the cache', comment: 'which cache?' }],
  });
  assert.equal(await h.start(), 0);
  assert.match(h.prompts[1]!, /a1 \(artifact: Design\): changes requested\n  Comment: Add a diagram\n  On "the cache": which cache\?/);
  assert.match(h.prompts[1]!, /Address every change request/);
});

test('a follow-up to a ready task resumes the session in a restarted runner and is accepted', async () => {
  const h = harness({ turns: [ready, ready] });
  await h.start();
  sendFollowUp(h.fake, 'Also add a logout button');
  assert.equal(await h.start(), 0);
  assert.deepEqual(claudeTurns(h), ['claude start', 'claude resume']);
  assert.match(h.prompts[1]!, /The engineer sent follow-up requests:\n\n- f1: Also add a logout button\n\nAddress them\./);
  assert.ok(h.fake.task.followUps[0]!.deliveredAt);
  assert.equal(h.fake.task.status, 'ready');
});


/** Lets the runner run until `condition` holds; it only waits on promises the test settles. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(condition(), 'condition never held');
}

test('an idle runner waits for the doorbell and works on a follow-up in the same process', async () => {
  const doorbell = createDoorbell();
  const h = harness({ turns: [ready, ready], doorbell });
  const idleCount = () => h.logs.filter((line) => line === 'no work, waiting for the doorbell').length;
  const running = h.start();
  await until(() => idleCount() === 1);
  sendFollowUp(h.fake, 'Also add a logout button');
  doorbell.ring();
  await until(() => idleCount() === 2);
  doorbell.close();

  assert.equal(await running, 0);
  assert.deepEqual(claudeTurns(h), ['claude start', 'claude resume']);
  assert.deepEqual(workCalls(h), ['requestWork', 'acceptWork', 'requestWork', 'requestWork', 'acceptWork', 'requestWork']);
  assert.equal(h.fake.task.status, 'ready');
});

test('answers and a follow-up sent meanwhile go out in one resume prompt', async () => {
  const h = harness({ turns: [ask, ready] });
  await h.start();
  sendFollowUp(h.fake, 'Prefer 8443');
  answerAll(h.fake, ['8080']);
  await h.start();
  assert.match(h.prompts[1]!, /Answer: 8080[\s\S]*- f1: Prefer 8443/);
});

test('a follow-up sent during a turn is worked on in the same run', async () => {
  const readyWithFollowUp: Turn = async (fake) => {
    await fake.reportReady();
    sendFollowUp(fake, 'One more thing');
    return 0;
  };
  const h = harness({ turns: [readyWithFollowUp, ready] });
  assert.equal(await h.start(), 0);
  assert.deepEqual(claudeTurns(h), ['claude start', 'claude resume']);
  assert.deepEqual(workCalls(h), ['requestWork', 'acceptWork', 'requestWork', 'acceptWork', 'requestWork']);
});

test('a session that ends without a report is failed by the control plane when the runner asks again', async () => {
  const h = harness({ turns: [async () => 0] });
  assert.equal(await h.start(), 0);
  assert.equal(h.fake.task.status, 'failed');
  assert.match(h.fake.task.failureReason!, /ended its turn without reporting/);
});

test('a failing session puts the CLI error into the failure reason', async () => {
  const h = harness({ turns: [async () => 1], claudeOutputs: ['{"type":"result","is_error":true,"result":"Credit balance is too low"}'] });
  assert.equal(await h.start(), 0);
  assert.equal(h.fake.task.failureReason, 'claude session exited with code 1: Credit balance is too low');
});

test('a failed first turn keeps no session: a follow-up starts over with the task and a new session', async () => {
  const h = harness({ turns: [async () => 1, ready] });
  await h.start();
  assert.equal(h.saved, undefined);
  sendFollowUp(h.fake, 'Use the v2 API instead');
  assert.equal(await h.start(), 0);
  assert.deepEqual(claudeTurns(h), ['claude start', 'claude start']);
  assert.deepEqual(h.sessionIds, ['sid-1', 'sid-2']);
  assert.equal(h.commands.filter((c) => c === 'rm -rf /work').length, 2, 'the clone starts clean');
  assert.match(h.prompts[1]!, /# Task: Add a greeting[\s\S]*- f1: Use the v2 API instead/);
});

test('a failed later turn keeps the session: a follow-up resumes it', async () => {
  const h = harness({ turns: [ask, async () => 3, ready] });
  await h.start();
  answerAll(h.fake, ['8080']);
  await h.start();
  assert.equal(h.fake.task.failureReason, 'claude session exited with code 3');
  sendFollowUp(h.fake, 'Try again');
  assert.equal(await h.start(), 0);
  assert.deepEqual(claudeTurns(h), ['claude start', 'claude resume', 'claude resume']);
  assert.equal(h.fake.task.status, 'ready');
});

test('an unexpected error after accepting the work is reported as a failure', async () => {
  const h = harness({ turns: [] });
  h.fake.getTask = async () => {
    throw new AgentApiError(503, 'unavailable', 'control plane restarting');
  };
  assert.equal(await h.start(), 0);
  assert.equal(h.fake.task.failureReason, 'control plane restarting');
});

test('a failure that cannot be reported is logged and the runner asks for work again', async () => {
  const h = harness({ turns: [async () => 1] });
  h.fake.reportFailure = async () => {
    throw new Error('connection refused');
  };
  assert.equal(await h.start(), 0);
  assert.ok(h.logs.includes('could not report failure: connection refused'));
  assert.match(h.fake.task.failureReason!, /ended its turn without reporting/, 'the control plane fails it instead');
});

test('asking for work is retried while the control plane cannot be reached', async () => {
  const h = harness({ turns: [ready] });
  const requestWork = h.fake.requestWork;
  let attempts = 0;
  h.fake.requestWork = async () => {
    if (++attempts <= 2) throw new Error('connection refused');
    return requestWork();
  };
  assert.equal(await h.start(), 0);
  assert.equal(h.retries, 2);
  assert.equal(h.fake.task.status, 'ready');
});

test('gives up with exit code 1 after the last attempt', async () => {
  const h = harness({ turns: [] });
  h.fake.requestWork = async () => {
    throw new AgentApiError(401, 'unauthorized', 'missing or invalid agent token');
  };
  assert.equal(await h.start(), 1);
  assert.equal(h.retries, 2);
  assert.ok(h.logs.includes('giving up asking for work: missing or invalid agent token'));
});

test('work that cannot be accepted is asked for again and handed out again', async () => {
  const h = harness({ turns: [ready] });
  const acceptWork = h.fake.acceptWork;
  let attempts = 0;
  h.fake.acceptWork = async (ids) => {
    if (++attempts === 1) throw new Error('connection reset');
    return acceptWork(ids);
  };
  assert.equal(await h.start(), 0);
  assert.deepEqual(claudeTurns(h), ['claude start']);
  assert.ok(h.logs.includes('could not accept work: connection reset'));
});

test('heartbeats run only while working and carry the CLI activity', async () => {
  const askWithBeat: Turn = async (fake, beat) => {
    beat();
    return ask(fake, beat);
  };
  const h = harness({
    turns: [askWithBeat, ready],
    claudeLines: ['{"type":"system","subtype":"init"}', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'yarn test' } }] } })],
  });
  await h.start();
  answerAll(h.fake, ['8080']);
  await h.start();
  assert.deepEqual(h.fake.heartbeats, [
    { phase: 'setting_up' },
    { phase: 'working' },
    { phase: 'working', activity: 'Running Bash: yarn test' },
    { phase: 'working' },
  ]);
});

test('failing heartbeats do not fail the task', async () => {
  const h = harness({ turns: [async (fake, beat) => (beat(), ready(fake, beat))] });
  let attempts = 0;
  h.fake.sendHeartbeat = async () => {
    attempts += 1;
    throw new Error('control plane down');
  };
  assert.equal(await h.start(), 0);
  assert.ok(attempts >= 2);
  assert.equal(h.fake.task.status, 'ready');
});

// Running totals of the session in the fixtures: the resumed turn's includes the first turn's.
const firstTurn = claudeFixture('result-first-turn.jsonl');
const resumedTurn = claudeFixture('result-resumed-turn.jsonl');
const firstTotal = 0.0008607700000000001;
const resumedTotal = 0.001417005;

test('every turn reports its duration and cost increase, across runner processes', async () => {
  const h = harness({ turns: [ask, ready], claudeOutputs: [firstTurn, resumedTurn], turnMs: [90_000, 30_000] });
  await h.start();
  assert.deepEqual(h.saved, { sessionId: 'sid-1', costUsd: firstTotal });
  answerAll(h.fake, ['8080']);
  await h.start();
  assert.deepEqual(h.fake.metrics, [
    { durationMs: 90_000, costUsd: firstTotal },
    { durationMs: 30_000, costUsd: resumedTotal - firstTotal },
  ]);
  assert.deepEqual(h.saved, { sessionId: 'sid-1', costUsd: resumedTotal });
});

test('a failed turn reports its metrics before the failure', async () => {
  const h = harness({
    turns: [async () => 1],
    claudeOutputs: ['{"type":"result","is_error":true,"result":"Credit balance is too low","total_cost_usd":0.02}'],
  });
  await h.start();
  assert.deepEqual(h.fake.metrics, [{ durationMs: 1000, costUsd: 0.02 }]);
  const reports = h.fake.calls.filter((c) => c === 'reportMetrics' || c === 'reportFailure');
  assert.deepEqual(reports, ['reportMetrics', 'reportFailure']);
});

test('a lost metrics report neither fails the task nor is counted again', async () => {
  const h = harness({ turns: [ask, ready], claudeOutputs: [firstTurn, resumedTurn] });
  const report = h.fake.reportMetrics;
  let calls = 0;
  h.fake.reportMetrics = async (delta) => {
    if (++calls === 1) throw new AgentApiError(503, 'unavailable', 'control plane restarting');
    return report(delta);
  };
  await h.start();
  answerAll(h.fake, ['8080']);
  await h.start();
  assert.equal(h.fake.task.status, 'ready');
  assert.ok(h.logs.includes('could not report metrics: control plane restarting'));
  assert.deepEqual(h.fake.metrics, [{ durationMs: 1000, costUsd: resumedTotal - firstTotal }]);
});

test('a turn without a cost total reports none, and the next total catches up', async () => {
  const h = harness({ turns: [ask, ready], claudeOutputs: ['', resumedTurn] });
  await h.start();
  answerAll(h.fake, ['8080']);
  await h.start();
  assert.deepEqual(h.fake.metrics, [
    { durationMs: 1000, costUsd: 0 },
    { durationMs: 1000, costUsd: resumedTotal },
  ]);
});

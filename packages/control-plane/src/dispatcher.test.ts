import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  heartbeatTimeoutMs,
  type ExecutionRuntime,
  type ExecutionSpec,
  type NewTask,
  type PullRequest,
  type StartedExecution,
  type Task,
} from '@factory/core';
import { SqliteTaskRepository } from './adapters/sqlite-task-repository.ts';
import { hashAgentToken } from './agent-token.ts';
import { Dispatcher, orphanSweepIntervalMs, type DispatcherDeps, startupTimeoutMs } from './dispatcher.ts';
import { createServices } from './services.ts';
import type { TaskService } from './task-service.ts';
import { ada, noIssues, sequentialItemIds } from './test-support.ts';

class FakeRuntime implements ExecutionRuntime {
  started: ExecutionSpec[] = [];
  notified: string[] = [];
  restarted: string[] = [];
  removed: string[] = [];
  /** Execution servers `listExecutions` reports as existing. */
  existing: string[] = [];
  listCalls = 0;
  failOn: Partial<Record<'start' | 'notify' | 'restart' | 'remove' | 'listExecutions', string>> = {};

  #maybeThrow(method: keyof FakeRuntime['failOn']): void {
    const message = this.failOn[method];
    if (message) throw new Error(message);
  }

  async start(spec: ExecutionSpec): Promise<StartedExecution> {
    this.#maybeThrow('start');
    this.started.push(spec);
    return { executionId: `c-${spec.taskId}` };
  }

  async notify(executionId: string): Promise<void> {
    this.#maybeThrow('notify');
    this.notified.push(executionId);
  }

  async notifyShell(): Promise<void> {}

  async restart(executionId: string): Promise<void> {
    this.#maybeThrow('restart');
    this.restarted.push(executionId);
  }

  async remove(executionId: string): Promise<void> {
    this.#maybeThrow('remove');
    this.removed.push(executionId);
  }

  async listExecutions(): Promise<string[]> {
    this.listCalls++;
    this.#maybeThrow('listExecutions');
    return this.existing;
  }
}

const secrets = ['sk-secret', 'ghp_secret'];
/** Long enough that any working execution server counts as silent, with or without a heartbeat. */
const silence = startupTimeoutMs + 1;
const followUpWindowMs = 6 * 3_600_000;

/** The service and the dispatcher share one clock that only `advance` moves. */
function setup(maxRunning = 10) {
  const runtime = new FakeRuntime();
  let counter = 0;
  let now = Date.parse('2026-11-12T10:00:00.000Z');
  const { tasks, service, agent, lifecycle } = createServices({
    repository: new SqliteTaskRepository(':memory:'),
    issues: noIssues,
    runtime,
    newId: () => `t${++counter}`,
    newItemId: sequentialItemIds(),
    now: () => new Date(now).toISOString(),
  });
  const logged: string[] = [];
  const deps: DispatcherDeps = {
    tasks,
    lifecycle,
    runtime,
    controlPlaneUrl: 'http://host.containers.internal:8080',
    maxRunning,
    followUpWindowMs,
    secrets,
    log: (message) => logged.push(message),
    now: () => now,
  };
  /** A new dispatcher stands for a restarted control plane. */
  const newDispatcher = () => new Dispatcher(deps);
  const advance = (ms: number) => {
    now += ms;
  };
  const beat = (id: string) => agent.recordHeartbeat(tasks.get(id), { phase: 'working' });
  return { runtime, tasks, service, agent, lifecycle, deps, dispatcher: newDispatcher(), newDispatcher, logged, advance, beat, now: () => now };
}

type Fixture = ReturnType<typeof setup>;
type StartedStatus = 'in_progress' | 'input_required' | 'ready' | 'done' | 'failed';

const newTask = (overrides: Partial<NewTask> = {}): NewTask => ({
  projectId: 'p1',
  title: 'task',
  specification: 'spec',
  repoUrl: 'https://github.com/o/r',
  ...overrides,
});

const queued = ({ service }: Fixture, overrides: Partial<NewTask> = {}): Task =>
  service.start(service.create(newTask(overrides), ada).id, ada);

/** A started task in `status`; its worker stays working unless `isIdle`, which needs a status the agent reported. */
function inStatus({ tasks, service, agent, lifecycle }: Fixture, status: StartedStatus, executionId: string, isIdle = false): Task {
  const { id } = service.create(newTask({ autonomyMode: 'supervised' }), ada);
  service.start(id, ada);
  lifecycle.markInProgress(id, { tokenHash: `hash-${id}`, executionId });
  if (status === 'input_required') agent.askQuestion(id, { problem: 'p?', type: 'text', options: [] });
  if (status === 'ready' || status === 'done') agent.markReady(id);
  if (status === 'done') lifecycle.markDone(id);
  if (status === 'failed') lifecycle.markFailed(id, 'boom');
  if (isIdle) lifecycle.releaseWorker(id, 'unused');
  return tasks.get(id);
}

const pullRequest = (n: number, status: PullRequest['status'] = 'open'): PullRequest => ({
  url: `https://github.com/o/r/pull/${n}`,
  title: `PR ${n}`,
  status,
});

/** A ready task with an idle worker and the given open pull requests. */
function readyWith(f: Fixture, pullRequests: PullRequest[]): Task {
  const { id } = f.service.create(newTask(), ada);
  f.service.start(id, ada);
  f.lifecycle.markInProgress(id, { tokenHash: `hash-${id}`, executionId: `c-${id}` });
  for (const pr of pullRequests) f.agent.addPullRequest(id, { url: pr.url, title: pr.title });
  f.agent.markReady(id);
  return f.lifecycle.releaseWorker(id, 'unused');
}

test('starts an execution server for a queued task, marks it in progress and its worker working', async () => {
  const f = setup();
  const task = queued(f, { baseBranch: 'develop' });
  await f.dispatcher.reconcile();

  assert.equal(f.runtime.started.length, 1);
  const spec = f.runtime.started[0]!;
  assert.equal(spec.taskId, task.id);
  assert.equal(spec.repoUrl, task.repoUrl);
  assert.equal(spec.baseBranch, 'develop');
  assert.equal(spec.model, 'opus');
  assert.equal(spec.shellEnabled, true);
  assert.equal(spec.controlPlaneUrl, 'http://host.containers.internal:8080');
  assert.match(spec.token, /^[0-9a-f]{64}$/);

  const updated = f.tasks.get(task.id);
  assert.equal(updated.status, 'in_progress');
  assert.equal(updated.execution?.id, `c-${task.id}`);
  assert.equal(updated.execution?.tokenHash, hashAgentToken(spec.token));
  assert.deepEqual(updated.execution?.worker, { state: 'working', since: '2026-11-12T10:00:00.000Z' });
  assert.ok(!JSON.stringify(updated).includes(spec.token));
});

test('starts queued tasks in rank order', async () => {
  const f = setup();
  const first = queued(f);
  const second = queued(f);
  f.service.move(second.id, first.id);
  await f.dispatcher.reconcile();
  assert.deepEqual(f.runtime.started.map((spec) => spec.taskId), [second.id, first.id]);
});

test('starts only as many queued tasks as slots are free, counting working workers only', async () => {
  const f = setup(2);
  inStatus(f, 'input_required', 'c1', true);
  inStatus(f, 'ready', 'c2', true);
  const working = inStatus(f, 'in_progress', 'c3');
  const [first, second] = [queued(f), queued(f)];
  await f.dispatcher.reconcile();
  assert.deepEqual(f.runtime.started.map((spec) => spec.taskId), [first.id]);
  assert.equal(f.tasks.get(second.id).status, 'queued');

  f.agent.markReady(working.id);
  f.lifecycle.releaseWorker(working.id, 'unused');
  await f.dispatcher.reconcile();
  assert.deepEqual(f.runtime.started.map((spec) => spec.taskId), [first.id, second.id]);
});

test('starts a queued task only once every task it depends on is done', async () => {
  const f = setup();
  const first = inStatus(f, 'in_progress', 'c1');
  const second = queued(f);
  const dependent = queued(f, { dependsOn: [first.id, second.id] });
  await f.dispatcher.reconcile();
  assert.deepEqual(f.runtime.started.map((spec) => spec.taskId), [second.id]);
  assert.equal(f.tasks.get(dependent.id).status, 'queued');

  f.agent.markReady(first.id);
  f.lifecycle.markDone(first.id);
  await f.dispatcher.reconcile();
  assert.equal(f.tasks.get(dependent.id).status, 'queued');

  f.agent.markReady(second.id);
  f.lifecycle.markDone(second.id);
  await f.dispatcher.reconcile();
  assert.deepEqual(f.runtime.started.map((spec) => spec.taskId), [second.id, dependent.id]);
});

test('a blocked task takes no slot from the queued tasks ranked below it', async () => {
  const f = setup(1);
  const failed = inStatus(f, 'failed', 'c1', true);
  const blocked = queued(f, { dependsOn: [failed.id] });
  const free = queued(f);
  await f.dispatcher.reconcile();
  assert.deepEqual(f.runtime.started.map((spec) => spec.taskId), [free.id]);
  assert.equal(f.tasks.get(blocked.id).status, 'queued');
});

test('passes the task model to the execution server', async () => {
  const f = setup();
  queued(f, { model: 'sonnet' });
  await f.dispatcher.reconcile();
  assert.equal(f.runtime.started[0]!.model, 'sonnet');
});

test('passes whether the task allows a shell to the execution server', async () => {
  const f = setup();
  queued(f, { shellEnabled: false });
  await f.dispatcher.reconcile();
  assert.equal(f.runtime.started[0]!.shellEnabled, false);
});

test('omits baseBranch and repoUrl from the spec when the task has none', async () => {
  const f = setup();
  const { repoUrl: _none, ...repoLess } = newTask();
  f.service.start(f.service.create(repoLess, ada).id, ada);
  await f.dispatcher.reconcile();
  assert.ok(!('baseBranch' in f.runtime.started[0]!));
  assert.ok(!('repoUrl' in f.runtime.started[0]!));
});

test('fails the task with a redacted reason when the execution server cannot start', async () => {
  const f = setup();
  const task = queued(f);
  f.runtime.failOn.start = 'podman exploded using sk-secret';
  await f.dispatcher.reconcile();

  const updated = f.tasks.get(task.id);
  assert.equal(updated.status, 'failed');
  assert.ok(updated.failureReason?.startsWith('cannot start execution server'));
  assert.ok(updated.failureReason?.includes('[redacted]'));
  assert.ok(!updated.failureReason?.includes('sk-secret'));
});

test('restarts a silent worker of a task in progress and fails the task', async () => {
  const f = setup();
  const task = inStatus(f, 'in_progress', 'c1');
  f.beat(task.id);
  f.advance(heartbeatTimeoutMs + 1);
  await f.dispatcher.reconcile();

  const updated = f.tasks.get(task.id);
  assert.deepEqual(f.runtime.restarted, ['c1']);
  assert.equal(updated.status, 'failed');
  assert.equal(updated.failureReason, 'execution server stopped sending heartbeats before the task finished');
  assert.equal(updated.execution?.worker.state, 'idle');
  assert.equal(updated.execution?.id, 'c1', 'kept for a follow-up');
});

test('fails the task for its silence before the restarted runner can ask for work', async () => {
  const f = setup();
  const task = inStatus(f, 'in_progress', 'c1');
  f.agent.acceptWork(task.id, []);
  f.advance(silence);
  f.runtime.restart = async () => {
    f.agent.requestWork(f.tasks.get(task.id));
  };
  await f.dispatcher.reconcile();
  assert.match(f.tasks.get(task.id).failureReason!, /stopped sending heartbeats/);
});

// A ready task whose worker went idle is settled by its pull requests, see below.
for (const status of ['input_required', 'failed'] as const) {
  test(`restarts a silent worker of a ${status} task and keeps the status, since the restart resumes the session`, async () => {
    const f = setup();
    const task = inStatus(f, status, 'c1');
    f.advance(silence);
    await f.dispatcher.reconcile();
    const updated = f.tasks.get(task.id);
    assert.deepEqual(f.runtime.restarted, ['c1']);
    assert.deepEqual([updated.status, updated.execution?.worker.state], [status, 'idle']);
  });
}

for (const [name, interrupt] of [
  ['cancelled', (service: TaskService, id: string) => service.cancel(id, ada)],
  ['deleted', (service: TaskService, id: string) => service.delete(id)],
] as const) {
  test(`removes the new execution server of a task ${name} while it started`, async () => {
    const f = setup();
    const task = queued(f);
    const start = f.runtime.start.bind(f.runtime);
    f.runtime.start = async (spec) => {
      const started = await start(spec);
      await interrupt(f.service, spec.taskId);
      return started;
    };
    await f.dispatcher.reconcile();

    assert.deepEqual(f.runtime.removed, [`c-${task.id}`]);
    assert.equal(f.logged.length, 1);
    if (name === 'cancelled') assert.equal(f.tasks.get(task.id).status, 'failed');
  });
}

test('leaves a task untouched while its worker sends heartbeats', async () => {
  const f = setup();
  const { id } = inStatus(f, 'in_progress', 'c1');
  f.beat(id);
  const task = f.tasks.get(id);
  f.advance(heartbeatTimeoutMs);
  await f.dispatcher.reconcile();
  assert.deepEqual(f.tasks.get(id), task);
  assert.deepEqual(f.runtime.restarted, []);
});

test('waits up to the startup timeout for the first heartbeat', async () => {
  const f = setup();
  const task = inStatus(f, 'in_progress', 'c1');
  f.advance(startupTimeoutMs);
  await f.dispatcher.reconcile();
  assert.equal(f.tasks.get(task.id).status, 'in_progress');
  f.advance(1);
  await f.dispatcher.reconcile();
  assert.equal(f.tasks.get(task.id).status, 'failed');
});

test('counts silence only from the start of the control plane', async () => {
  const f = setup();
  const task = inStatus(f, 'in_progress', 'c1');
  f.beat(task.id);
  f.advance(10 * 60_000);
  const restarted = f.newDispatcher();
  await restarted.reconcile();
  assert.equal(f.tasks.get(task.id).status, 'in_progress');
  f.advance(heartbeatTimeoutMs + 1);
  await restarted.reconcile();
  assert.equal(f.tasks.get(task.id).status, 'failed');
});

test('counts silence only from the end of a pause of the control plane', async () => {
  const f = setup();
  const task = inStatus(f, 'in_progress', 'c1');
  f.beat(task.id);
  let awakeSince = f.now();
  const dispatcher = new Dispatcher({ ...f.deps, awakeSince: () => awakeSince });
  // The host slept for an hour: neither the control plane nor the execution server ran.
  f.advance(3_600_000);
  awakeSince = f.now();
  await dispatcher.reconcile();
  assert.equal(f.tasks.get(task.id).status, 'in_progress');
  f.advance(heartbeatTimeoutMs + 1);
  await dispatcher.reconcile();
  assert.equal(f.tasks.get(task.id).status, 'failed');
});

test('a worker that cannot be restarted is released anyway and the error logged', async () => {
  const f = setup();
  const task = inStatus(f, 'in_progress', 'c1');
  f.advance(silence);
  f.runtime.failOn.restart = 'podman restart failed with sk-secret';
  await f.dispatcher.reconcile();
  assert.deepEqual([f.tasks.get(task.id).status, f.tasks.get(task.id).execution?.worker.state], ['failed', 'idle']);
  assert.match(f.logged[0]!, /podman restart failed with \[redacted\]/);
});

test('notifies an idle worker once a follow-up waits for it, and marks it working', async () => {
  const f = setup(1);
  const task = inStatus(f, 'ready', 'c1', true);
  f.service.addFollowUp(task.id, 'rename the button', ada);
  const next = queued(f);
  await f.dispatcher.reconcile();
  assert.deepEqual(f.runtime.notified, ['c1']);
  assert.deepEqual(f.tasks.get(task.id).execution?.worker, { state: 'working', since: '2026-11-12T10:00:00.000Z' });
  assert.deepEqual(f.runtime.started, [], `the notified worker takes the only slot, so ${next.id} waits`);

  await f.dispatcher.reconcile();
  assert.deepEqual(f.runtime.notified, ['c1'], 'a working worker is not notified again');
});

test('never notifies an idle worker without work', async () => {
  const f = setup();
  inStatus(f, 'input_required', 'c1', true);
  inStatus(f, 'ready', 'c2', true);
  f.advance(followUpWindowMs);
  await f.dispatcher.reconcile();
  assert.deepEqual(f.runtime.notified, []);
});

test('notifies an idle worker once the last question is answered', async () => {
  const f = setup();
  const task = inStatus(f, 'input_required', 'c1', true);
  await f.dispatcher.reconcile();
  assert.deepEqual(f.runtime.notified, []);

  f.service.answer(task.id, 'q1', ['yes'], ada);
  await f.dispatcher.reconcile();
  assert.deepEqual(f.runtime.notified, ['c1']);
});

test('a task paused for a usage limit idles, holds every queued task and is notified once the limit resets', async () => {
  const f = setup();
  const paused = inStatus(f, 'in_progress', 'c1');
  f.agent.acceptWork(paused.id, []);
  f.agent.recordUsageLimit(paused.id, '2026-11-12T12:00:00.000Z');
  assert.equal(f.agent.requestWork(f.tasks.get(paused.id)), undefined);
  assert.deepEqual([f.tasks.get(paused.id).status, f.tasks.get(paused.id).execution?.worker.state], ['in_progress', 'idle']);
  const next = queued(f);

  await f.dispatcher.reconcile();
  assert.deepEqual(f.runtime.notified, []);
  assert.equal(f.runtime.started.length, 0, 'nothing starts meanwhile');

  // Derived from the stored task, so a restarted control plane resumes it too.
  f.advance(2 * 3_600_000 + 60_000);
  await f.newDispatcher().reconcile();
  assert.deepEqual(f.runtime.notified, ['c1']);
  assert.deepEqual(f.runtime.started.map((spec) => spec.taskId), [next.id]);
  assert.ok(f.agent.requestWork(f.tasks.get(paused.id)), 'the cut-off turn is owed');
  assert.equal(f.agent.acceptWork(paused.id, []).execution?.usageLimit, undefined);
});

test('cancelling a task paused for a usage limit removes its execution server and the pause with it', async () => {
  const f = setup();
  const paused = inStatus(f, 'in_progress', 'c1');
  f.agent.recordUsageLimit(paused.id, undefined);
  f.agent.requestWork(f.tasks.get(paused.id));
  await f.service.cancel(paused.id, ada);
  const cancelled = f.tasks.get(paused.id);
  assert.deepEqual([cancelled.status, cancelled.execution], ['failed', undefined]);
  const next = queued(f);
  await f.dispatcher.reconcile();
  assert.deepEqual(f.runtime.started.map((spec) => spec.taskId), [next.id]);
});

test('fails a task whose execution server cannot be notified, with a redacted reason', async () => {
  const f = setup();
  const task = inStatus(f, 'failed', 'c1', true);
  f.service.addFollowUp(task.id, 'again', ada);
  f.runtime.failOn.notify = 'no such container, sk-secret';
  await f.dispatcher.reconcile();
  const updated = f.tasks.get(task.id);
  assert.equal(updated.status, 'failed');
  assert.equal(updated.failureReason, 'cannot notify execution server: no such container, [redacted]');
  assert.equal(updated.execution?.worker.state, 'idle');
});

test('a notified worker that never reports is restarted after the startup timeout', async () => {
  const f = setup();
  const task = inStatus(f, 'ready', 'c1', true);
  f.service.addFollowUp(task.id, 'again', ada);
  await f.dispatcher.reconcile();
  f.advance(startupTimeoutMs);
  await f.dispatcher.reconcile();
  assert.equal(f.tasks.get(task.id).status, 'in_progress');
  f.advance(1);
  await f.dispatcher.reconcile();
  assert.deepEqual(f.runtime.restarted, ['c1']);
  assert.match(f.tasks.get(task.id).failureReason!, /stopped sending heartbeats before the task finished/);
});

test('marks a ready task done and removes its execution server once none of its pull requests is open', async () => {
  const f = setup();
  const task = readyWith(f, [pullRequest(1), pullRequest(2)]);
  f.lifecycle.updatePullRequests(task.id, [pullRequest(1, 'merged')]);
  await f.dispatcher.reconcile();
  assert.equal(f.tasks.get(task.id).status, 'ready');

  f.lifecycle.updatePullRequests(task.id, [pullRequest(2, 'closed')]);
  await f.dispatcher.reconcile();
  assert.equal(f.tasks.get(task.id).status, 'done');
  assert.deepEqual(f.runtime.removed, [`c-${task.id}`]);
});

test('marks a task waiting for the engineer on its pull requests done once none of them is open', async () => {
  const f = setup();
  const task = readyWith(f, [pullRequest(1)]);
  f.lifecycle.recordPrReview(task.id, pullRequest(1).url, { result: 'risky', risk: 'high' });
  f.lifecycle.requireInputForPullRequests(task.id);
  await f.dispatcher.reconcile();
  assert.equal(f.tasks.get(task.id).status, 'input_required');

  f.lifecycle.updatePullRequests(task.id, [pullRequest(1, 'merged')]);
  await f.dispatcher.reconcile();
  assert.equal(f.tasks.get(task.id).status, 'done');
});

test('never marks a task awaiting an answer done, even once none of its pull requests is open', async () => {
  const f = setup();
  const { id } = f.service.create(newTask({ autonomyMode: 'supervised' }), ada);
  f.service.start(id, ada);
  f.lifecycle.markInProgress(id, { tokenHash: `hash-${id}`, executionId: `c-${id}` });
  f.agent.addPullRequest(id, { url: pullRequest(1).url, title: 'PR 1' });
  f.agent.askQuestion(id, { problem: 'p?', type: 'text', options: [] });
  f.lifecycle.releaseWorker(id, 'unused');
  f.lifecycle.updatePullRequests(id, [pullRequest(1, 'merged')]);
  await f.dispatcher.reconcile();
  assert.equal(f.tasks.get(id).status, 'input_required');
});

test('marks a ready task without pull requests done at once', async () => {
  const f = setup();
  const task = readyWith(f, []);
  await f.dispatcher.reconcile();
  assert.equal(f.tasks.get(task.id).status, 'done');
});

test('does not settle a ready task while its worker is working, so its last reports arrive', async () => {
  const f = setup();
  const task = inStatus(f, 'ready', 'c1');
  await f.dispatcher.reconcile();
  assert.equal(f.tasks.get(task.id).status, 'ready');
});

test('removes the execution server of a done task and clears its id', async () => {
  const f = setup();
  const task = inStatus(f, 'done', 'c1');
  await f.dispatcher.reconcile();
  assert.deepEqual(f.runtime.removed, ['c1']);
  assert.equal(f.tasks.get(task.id).execution?.id, undefined);
});

test('keeps the idle execution server of a failed task for the follow-up window', async () => {
  const f = setup();
  const task = inStatus(f, 'failed', 'c1', true);
  f.advance(followUpWindowMs);
  await f.dispatcher.reconcile();
  assert.deepEqual(f.runtime.removed, []);
  assert.equal(f.tasks.get(task.id).execution?.id, 'c1');

  f.advance(1);
  await f.dispatcher.reconcile();
  assert.deepEqual(f.runtime.removed, ['c1']);
  assert.equal(f.tasks.get(task.id).execution?.id, undefined);
});

test('does not remove the execution server of a failed task while its worker is working', async () => {
  const f = setup();
  const task = inStatus(f, 'failed', 'c1');
  f.advance(followUpWindowMs + 1);
  f.beat(task.id);
  await f.dispatcher.reconcile();
  assert.deepEqual(f.runtime.removed, []);
});

test('logs a failing task and continues with the others', async () => {
  const f = setup();
  const first = inStatus(f, 'done', 'c1');
  const second = inStatus(f, 'failed', 'c2', true);
  f.advance(followUpWindowMs + 1);
  f.runtime.failOn.remove = 'rm failed with sk-secret';
  await f.dispatcher.reconcile();

  assert.equal(f.logged.length, 2);
  assert.ok(f.logged[0]!.includes(first.id) && f.logged[1]!.includes(second.id));
  assert.ok(f.logged.every((line) => line.includes('rm failed') && !line.includes('sk-secret')));
  assert.equal(f.tasks.get(first.id).execution?.id, 'c1');
});

test('a task failing to be restarted does not stop other queued tasks', async () => {
  const f = setup();
  const active = inStatus(f, 'in_progress', 'c9');
  f.advance(silence);
  const [first, second] = [queued(f), queued(f)];
  const releaseWorker = f.lifecycle.releaseWorker.bind(f.lifecycle);
  f.lifecycle.releaseWorker = (id, reason) => {
    if (id === active.id) throw new Error('database is locked');
    return releaseWorker(id, reason);
  };
  await f.dispatcher.reconcile();

  assert.equal(f.tasks.get(first.id).status, 'in_progress');
  assert.equal(f.tasks.get(second.id).status, 'in_progress');
  assert.equal(f.tasks.get(active.id).status, 'in_progress');
  assert.ok(f.logged.some((line) => line.includes(active.id)));
});

test('a second pass does not start another execution server', async () => {
  const f = setup();
  queued(f);
  await f.dispatcher.reconcile();
  await f.dispatcher.reconcile();
  assert.equal(f.runtime.started.length, 1);
});

test('removes execution servers no task knows and keeps those of tasks in any status', async () => {
  const f = setup();
  inStatus(f, 'in_progress', 'c-running');
  inStatus(f, 'done', 'c-done');
  f.runtime.existing = ['c-running', 'c-orphan', 'c-done'];
  await f.dispatcher.reconcile();

  assert.deepEqual(f.runtime.removed, ['c-orphan', 'c-done'], 'the done task loses its own later in the pass');
  assert.deepEqual(f.logged, ['dispatcher: removed orphaned execution server c-orphan']);
});

test('sweeps for orphans on the first pass and then once per interval', async () => {
  const f = setup();
  await f.dispatcher.reconcile();
  assert.equal(f.runtime.listCalls, 1);

  f.advance(orphanSweepIntervalMs - 1);
  await f.dispatcher.reconcile();
  assert.equal(f.runtime.listCalls, 1);

  f.advance(1);
  await f.dispatcher.reconcile();
  assert.equal(f.runtime.listCalls, 2);
});

test('a failing listing is logged, does not stop the pass and waits for the next interval', async () => {
  const f = setup();
  const task = queued(f);
  f.runtime.failOn.listExecutions = 'podman ps failed with sk-secret';
  await f.dispatcher.reconcile();

  assert.equal(f.tasks.get(task.id).status, 'in_progress');
  assert.equal(f.logged.length, 1);
  assert.match(f.logged[0]!, /cannot list execution servers: podman ps failed with \[redacted\]/);

  f.advance(orphanSweepIntervalMs - 1);
  await f.dispatcher.reconcile();
  assert.equal(f.runtime.listCalls, 1);
});

test('one orphan failing to be removed does not stop the others', async () => {
  const f = setup();
  f.runtime.existing = ['c-stuck', 'c-orphan'];
  const remove = f.runtime.remove.bind(f.runtime);
  f.runtime.remove = async (executionId) => {
    if (executionId === 'c-stuck') throw new Error('rm failed with sk-secret');
    return remove(executionId);
  };
  await f.dispatcher.reconcile();

  assert.deepEqual(f.runtime.removed, ['c-orphan']);
  assert.deepEqual(f.logged, [
    'dispatcher: execution server c-stuck: rm failed with [redacted]',
    'dispatcher: removed orphaned execution server c-orphan',
  ]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTask, DomainError, type ShellEndpoint, type Task } from '@factory/core';
import { ShellService, type ShellServiceDeps } from './shell-service.ts';
import { NotFoundError } from './task-store.ts';
import { ada } from './test-support.ts';

class FakeEndpoint implements ShellEndpoint {
  closed: { code: number; reason: string } | undefined;
  #listeners: (() => void)[] = [];

  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.#listeners.forEach((listener) => listener());
  }

  onClose(listener: () => void): void {
    this.#listeners.push(listener);
  }
}

const size = { cols: 80, rows: 24 };
const minute = 60_000;

const taskWith = (id: string, overrides: Partial<Task> = {}): Task => ({
  ...createTask({ projectId: 'p1', title: 't', specification: 's' }, { id, now: '2026-11-12T10:00:00.000Z', rank: 0 }),
  status: 'in_progress',
  execution: { id: `c-${id}`, tokenHash: 'h', worker: { state: 'idle', since: '2026-11-12T10:00:00.000Z' } },
  ...overrides,
});

function setup(overrides: Partial<ShellServiceDeps> = {}) {
  const tasks = new Map<string, Task>([
    ['t1', taskWith('t1')],
    ['t2', taskWith('t2')],
  ]);
  const notified: string[] = [];
  const logged: string[] = [];
  let failNotify: string | undefined;
  let now = Date.parse('2026-11-12T10:00:00.000Z');
  let counter = 0;
  const shells = new ShellService({
    tasks: {
      get: (id) => {
        const task = tasks.get(id);
        if (!task) throw new NotFoundError(`task ${id} not found`);
        return task;
      },
    },
    runtime: {
      notifyShell: async (executionId) => {
        if (failNotify) throw new Error(failNotify);
        notified.push(executionId);
      },
    },
    idleTimeoutMs: 30 * minute,
    secrets: ['sk-secret'],
    log: (message) => logged.push(message),
    now: () => now,
    newId: () => `s${++counter}`,
    ...overrides,
  });
  /** Opens a shell into `taskId` as `ada`, authorized until `authorized.value` turns false. */
  const open = async (taskId = 't1', authorized = { value: true }) => {
    const browser = new FakeEndpoint();
    await shells.open(ada, taskId, size, browser, () => authorized.value);
    return browser;
  };
  return {
    shells,
    tasks,
    notified,
    logged,
    open,
    failNotify: (message: string) => (failNotify = message),
    advance: (ms: number) => (now += ms),
  };
}

const isCode = (code: DomainError['code'], message?: RegExp) => (error: unknown) =>
  error instanceof DomainError && error.code === code && (!message || message.test(error.message));

test('open records a pending request and notifies the execution server', async () => {
  const f = setup();
  const browser = await f.open();
  assert.deepEqual(f.notified, ['c-t1']);
  assert.deepEqual(f.shells.pendingFor(f.tasks.get('t1')!), [
    { id: 's1', taskId: 't1', size, requestedBy: ada.userId, createdAt: '2026-11-12T10:00:00.000Z' },
  ]);
  assert.equal(f.shells.hasOpenShell('t1'), true);
  assert.equal(browser.closed, undefined);
});

test('open refuses an unknown task', async () => {
  const f = setup();
  await assert.rejects(f.open('nope'), (error) => error instanceof DomainError && error.code === 'unknown_task');
});

test('open refuses a task without a usable execution server, and says why', async () => {
  const f = setup();
  f.tasks.set('off', taskWith('off', { shellEnabled: false }));
  f.tasks.set('none', taskWith('none', { execution: undefined }));
  f.tasks.set('done', taskWith('done', { status: 'done' }));
  await assert.rejects(f.open('off'), isCode('shell_unavailable', /disabled/));
  await assert.rejects(f.open('none'), isCode('shell_unavailable', /no execution server/));
  await assert.rejects(f.open('done'), isCode('shell_unavailable', /done/));
  assert.deepEqual(f.notified, []);
});

test('open allows three shells per task, and a closed one frees a slot', async () => {
  const f = setup();
  const [first] = [await f.open(), await f.open(), await f.open()];
  await assert.rejects(f.open(), isCode('shell_limit'));
  await f.open('t2');

  first!.close(1000, 'bye');
  await f.open();
  assert.equal(f.shells.pendingFor(f.tasks.get('t1')!).length, 3);
});

test('a failing notification closes the browser and logs the error without secrets', async () => {
  const f = setup();
  f.failNotify('podman failed with sk-secret');
  const browser = await f.open();
  assert.deepEqual(browser.closed, { code: 4000, reason: 'cannot reach the execution server' });
  assert.equal(f.shells.hasOpenShell('t1'), false);
  assert.equal(f.logged.length, 1);
  assert.ok(f.logged[0]!.includes('podman failed') && !f.logged[0]!.includes('sk-secret'));
});

test('closes the browser when no runner attaches in time', async () => {
  const f = setup({ connectTimeoutMs: 5 });
  const browser = await f.open();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(browser.closed, { code: 4000, reason: 'the execution server did not connect' });
  assert.equal(f.shells.hasOpenShell('t1'), false);
});

test('an attached shell is not closed by the connect timeout', async () => {
  const f = setup({ connectTimeoutMs: 5 });
  const browser = await f.open();
  f.shells.attach(f.tasks.get('t1')!, 's1', new FakeEndpoint());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(browser.closed, undefined);
  assert.equal(f.shells.hasOpenShell('t1'), true);
});

test('attach pairs the runner of the right task with the browser, once', async () => {
  const f = setup();
  const browser = await f.open();
  const t1 = f.tasks.get('t1')!;
  const attached = f.shells.attach(t1, 's1', new FakeEndpoint());
  assert.equal(attached.browser, browser);
  assert.equal(attached.shellId, 's1');
  assert.deepEqual(f.shells.pendingFor(t1), []);
  assert.equal(f.shells.hasOpenShell('t1'), true);
  assert.throws(() => f.shells.attach(t1, 's1', new FakeEndpoint()), NotFoundError);
});

test('attach refuses an unknown request and treats another task’s as unknown', async () => {
  const f = setup();
  await f.open();
  assert.throws(() => f.shells.attach(f.tasks.get('t1')!, 'nope', new FakeEndpoint()), NotFoundError);
  assert.throws(() => f.shells.attach(f.tasks.get('t2')!, 's1', new FakeEndpoint()), NotFoundError);
  assert.equal(f.shells.pendingFor(f.tasks.get('t1')!).length, 1);
});

test('attach refuses once the task can no longer have a shell', async () => {
  const f = setup();
  await f.open();
  assert.throws(
    () => f.shells.attach(taskWith('t1', { status: 'done' }), 's1', new FakeEndpoint()),
    isCode('shell_unavailable'),
  );
});

test('pendingFor lists only the task’s requests no runner attached to', async () => {
  const f = setup();
  await f.open();
  await f.open();
  await f.open('t2');
  f.shells.attach(f.tasks.get('t1')!, 's1', new FakeEndpoint());
  assert.deepEqual(
    f.shells.pendingFor(f.tasks.get('t1')!).map((request) => request.id),
    ['s2'],
  );
  assert.deepEqual(
    f.shells.pendingFor(f.tasks.get('t2')!).map((request) => request.id),
    ['s3'],
  );
});

test('closing either endpoint forgets the shell', async () => {
  const f = setup();
  const browser = await f.open();
  f.shells.attach(f.tasks.get('t1')!, 's1', new FakeEndpoint());
  browser.close(1000, 'bye');
  assert.equal(f.shells.hasOpenShell('t1'), false);

  await f.open();
  const runner = new FakeEndpoint();
  f.shells.attach(f.tasks.get('t1')!, 's2', runner);
  runner.close(1000, 'exit');
  assert.equal(f.shells.hasOpenShell('t1'), false);
});

test('sweep closes the shells, pending or open, of an engineer who lost authorization', async () => {
  const f = setup();
  const authorized = { value: true };
  const open = await f.open('t1', authorized);
  const pending = await f.open('t1', authorized);
  const other = await f.open('t2');
  f.shells.attach(f.tasks.get('t1')!, 's1', new FakeEndpoint());
  f.shells.sweep();
  assert.equal(open.closed, undefined);

  authorized.value = false;
  f.shells.sweep();
  assert.deepEqual(open.closed, { code: 4000, reason: 'signed out' });
  assert.deepEqual(pending.closed, { code: 4000, reason: 'signed out' });
  assert.equal(other.closed, undefined);
  assert.equal(f.shells.hasOpenShell('t1'), false);
});

test('sweep closes open shells without input for the idle timeout; input resets the clock', async () => {
  const f = setup();
  const browser = await f.open();
  const pending = await f.open();
  f.shells.attach(f.tasks.get('t1')!, 's1', new FakeEndpoint());
  f.advance(20 * minute);
  f.shells.recordInput('s1');
  f.advance(20 * minute);
  f.shells.sweep();
  assert.equal(browser.closed, undefined);

  f.advance(10 * minute);
  f.shells.sweep();
  assert.deepEqual(browser.closed, { code: 4000, reason: 'closed after 30 minutes without input' });
  assert.equal(pending.closed, undefined, 'the idle clock starts at attach');
  assert.equal(f.shells.hasOpenShell('t1'), true);
});

test('recordInput ignores an unknown shell', () => {
  setup().shells.recordInput('nope');
});

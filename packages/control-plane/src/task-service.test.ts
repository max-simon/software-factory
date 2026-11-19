import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTask,
  createUser,
  DomainError,
  markInProgress,
  startTask,
  type ExecutionRuntime,
  type IssueProvider,
  type Task,
  type TaskChange,
} from '@factory/core';
import { SqliteTaskRepository } from './adapters/sqlite-task-repository.ts';
import { SqliteUserRepository } from './adapters/sqlite-user-repository.ts';
import { createServices } from './services.ts';
import { ada } from './test-support.ts';

const now = '2026-11-12T10:00:00.000Z';

/** Records every save, so a test sees what went into one repository write. */
class RecordingRepository extends SqliteTaskRepository {
  readonly saves: Array<{ task: Task; changes: readonly TaskChange[] }> = [];

  override save(task: Task, changes: readonly TaskChange[] = []): void {
    this.saves.push({ task, changes });
    super.save(task, changes);
  }
}

function setUp() {
  const repository = new RecordingRepository(':memory:');
  const users = new SqliteUserRepository(':memory:');
  users.insert(createUser({ username: 'ada' }, { id: ada.userId, now }));
  const { service } = createServices({ repository, users, runtime: {} as ExecutionRuntime, newId: () => 't1', now: () => now });
  service.create({ projectId: 'p1', title: 't', specification: 's' }, ada);
  return { repository, service };
}

test('setAssignees saves the task and its changelog entry in one repository write', () => {
  const { repository, service } = setUp();
  service.setAssignees('t1', [ada.userId], ada);
  assert.equal(repository.saves.length, 1);
  const { task, changes } = repository.saves[0]!;
  assert.deepEqual(task.assignees, [ada.userId]);
  assert.deepEqual(changes, [{ at: now, actor: 'user', userId: ada.userId, field: 'assignees', from: [], to: [ada.userId] }]);
  assert.deepEqual(repository.listChanges('t1').at(-1), changes[0]);
});

test('setAssignees refuses an unknown user and saves nothing', () => {
  const { repository, service } = setUp();
  assert.throws(
    () => service.setAssignees('t1', [ada.userId, 'nobody'], ada),
    (error: unknown) => error instanceof DomainError && error.code === 'unknown_user',
  );
  assert.equal(repository.saves.length, 0);
  assert.equal('assignees' in repository.get('t1')!, false);
});

const issueUrl = 'https://github.com/o/r/issues/7';

/** Records the provider, runtime and repository calls of a delete in one ordered list. */
class FakeIssues implements IssueProvider {
  readonly #calls: string[];
  readonly failing: { labels?: string; comment?: string };

  constructor(calls: string[], failing: FakeIssues['failing'] = {}) {
    this.#calls = calls;
    this.failing = failing;
  }

  readonly labelChanges: Array<{ url: string; add: readonly string[]; remove: readonly string[] }> = [];
  readonly comments: Array<{ url: string; key: string; body: string }> = [];

  async listIssues(): Promise<never[]> {
    return [];
  }

  async changeLabels(url: string, change: { add: readonly string[]; remove: readonly string[] }): Promise<void> {
    this.#calls.push('changeLabels');
    if (this.failing.labels !== undefined) throw new Error(this.failing.labels);
    this.labelChanges.push({ url, ...change });
  }

  async comment(url: string, key: string, body: string): Promise<void> {
    this.#calls.push('comment');
    if (this.failing.comment !== undefined) throw new Error(this.failing.comment);
    this.comments.push({ url, key, body });
  }
}

class OrderedRepository extends SqliteTaskRepository {
  readonly #calls: string[];

  constructor(calls: string[]) {
    super(':memory:');
    this.#calls = calls;
  }

  override delete(id: string): void {
    this.#calls.push('delete');
    super.delete(id);
  }
}

/** A running managed task `m1` (execution `c-1`), with the issue provider `issues` unless it is turned off. */
function setUpManaged(options: { issues?: 'off'; failing?: FakeIssues['failing'] } = {}) {
  const calls: string[] = [];
  const logged: string[] = [];
  const repository = new OrderedRepository(calls);
  const users = new SqliteUserRepository(':memory:');
  const runtime = {
    remove: async () => {
      calls.push('runtime.remove');
    },
  } as unknown as ExecutionRuntime;
  const issues = new FakeIssues(calls, options.failing);
  const { tasks, service } = createServices({
    repository,
    users,
    runtime,
    now: () => now,
    secrets: ['ghp_secret'],
    log: (message) => logged.push(message),
    ...(options.issues !== 'off' && { issues }),
  });
  const external = { provider: 'github' as const, url: issueUrl, key: 'o/r#7' };
  const managed = createTask({ projectId: 'p1', title: 'Issue', specification: 'Body' }, { id: 'm1', now, rank: 1, external });
  tasks.insert(managed, 'system');
  repository.save(markInProgress(startTask(managed), { tokenHash: 'h', executionId: 'c-1' }, now));
  return { calls, logged, repository, service, tasks, issues };
}

test('delete removes the factory labels from a managed task\'s issue, comments once, then deletes the task', async () => {
  const f = setUpManaged();
  await f.service.delete('m1');
  assert.deepEqual(f.calls, ['changeLabels', 'comment', 'runtime.remove', 'delete']);
  assert.equal(f.repository.get('m1'), undefined);
  const [change] = f.issues.labelChanges;
  assert.equal(change!.url, issueUrl);
  assert.deepEqual(change!.add, []);
  for (const label of ['factory', 'factory:start', 'factory:status:in-progress', 'factory:status:draft', 'factory:status:done']) {
    assert.ok(change!.remove.includes(label), label);
  }
  assert.equal(change!.remove.some((label) => label.startsWith('factory:project:') || label.includes('model') || label.endsWith('autonomous')), false);
  assert.equal(f.issues.comments.length, 1);
  assert.equal(f.issues.comments[0]!.key, 'task-deleted');
  assert.equal(f.issues.comments[0]!.url, issueUrl);
});

test('delete keeps a managed task and touches nothing else when removing the labels fails', async () => {
  const f = setUpManaged({ failing: { labels: 'GitHub said 500 for ghp_secret' } });
  await assert.rejects(
    f.service.delete('m1'),
    (error: unknown) =>
      error instanceof DomainError &&
      error.code === 'issue_provider_failed' &&
      /o\/r#7/.test(error.message) &&
      /not deleted/.test(error.message) &&
      !error.message.includes('GitHub said'),
  );
  assert.deepEqual(f.calls, ['changeLabels']);
  assert.notEqual(f.repository.get('m1'), undefined);
  assert.equal(f.logged.length, 1);
  assert.match(f.logged[0]!, /m1/);
  assert.match(f.logged[0]!, /o\/r#7/);
  assert.match(f.logged[0]!, /\[redacted\]/);
  assert.equal(f.logged[0]!.includes('ghp_secret'), false);
});

test('delete still deletes a managed task when the comment fails, and logs it redacted', async () => {
  const f = setUpManaged({ failing: { comment: 'rate limited ghp_secret' } });
  await f.service.delete('m1');
  assert.deepEqual(f.calls, ['changeLabels', 'comment', 'runtime.remove', 'delete']);
  assert.equal(f.repository.get('m1'), undefined);
  assert.equal(f.logged.length, 1);
  assert.match(f.logged[0]!, /m1.*o\/r#7.*\[redacted\]/);
});

test('delete of a managed task without an issue provider deletes it and logs that the labels stay', async () => {
  const f = setUpManaged({ issues: 'off' });
  await f.service.delete('m1');
  assert.deepEqual(f.calls, ['runtime.remove', 'delete']);
  assert.equal(f.repository.get('m1'), undefined);
  assert.equal(f.logged.length, 1);
  assert.match(f.logged[0]!, /m1.*o\/r#7.*untouched/);
});

test('delete of an unmanaged task never calls the issue provider', async () => {
  const f = setUpManaged();
  f.service.create({ projectId: 'p1', title: 't', specification: 's' }, ada);
  const [unmanaged] = f.tasks.list().filter((task) => task.external === undefined);
  await f.service.delete(unmanaged!.id);
  assert.deepEqual(f.calls, ['delete']);
  assert.deepEqual(f.logged, []);
});

test('a refused delete of a managed task leaves its issue alone', async () => {
  const f = setUpManaged();
  f.service.create({ projectId: 'p1', title: 't', specification: 's', dependsOn: ['m1'] }, ada);
  await assert.rejects(
    f.service.delete('m1'),
    (error: unknown) => error instanceof DomainError && error.code === 'has_waiting_dependents',
  );
  assert.deepEqual(f.calls, []);
  assert.notEqual(f.repository.get('m1'), undefined);
});

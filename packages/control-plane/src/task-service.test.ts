import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTask,
  DomainError,
  markInProgress,
  startTask,
  type ExecutionRuntime,
  type IssueProvider,
} from '@factory/core';
import { SqliteTaskRepository } from './adapters/sqlite-task-repository.ts';
import { createServices } from './services.ts';
import { ada, noIssues } from './test-support.ts';

const now = '2026-11-12T10:00:00.000Z';

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

  covers(): boolean {
    return true;
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

/** A running managed task `m1` (execution `c-1`), with the issue provider `issues`. */
function setUpManaged(options: { failing?: FakeIssues['failing'] } = {}) {
  const calls: string[] = [];
  const logged: string[] = [];
  const repository = new OrderedRepository(calls);
  const runtime = {
    remove: async () => {
      calls.push('runtime.remove');
    },
  } as unknown as ExecutionRuntime;
  const issues = new FakeIssues(calls, options.failing);
  const { tasks, service } = createServices({
    repository,
    runtime,
    now: () => now,
    secrets: ['ghp_secret'],
    log: (message) => logged.push(message),
    issues,
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
  assert.equal(f.issues.comments[0]!.key, 'm1:task-deleted');
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

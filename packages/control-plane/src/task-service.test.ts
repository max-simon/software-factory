import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUser, DomainError, type ExecutionRuntime, type Task, type TaskChange } from '@factory/core';
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

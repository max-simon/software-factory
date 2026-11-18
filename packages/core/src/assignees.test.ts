import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkAssignees, setAssignees } from './assignees.ts';
import { changeMeta, taskChanges } from './changelog.ts';
import { DomainError, type DomainErrorCode } from './errors.ts';
import { createTask } from './operations.ts';
import type { Task, TaskStatus } from './task.ts';
import { createUser, disableUser, type User } from './user.ts';

const now = '2026-01-01T00:00:00Z';

const taskIn = (status: TaskStatus, assignees?: string[]): Task => ({
  ...createTask({ projectId: 'p1', title: 't', specification: 's' }, { id: 'task-1', now, rank: 0 }),
  status,
  ...(assignees && { assignees }),
});

const ada = createUser({ username: 'ada' }, { id: 'u1', now });
const bob = createUser({ username: 'bob' }, { id: 'u2', now });
const eve = disableUser(createUser({ username: 'eve' }, { id: 'u3', now }), now);

const usersOf = (...users: User[]): Map<string, User> => new Map(users.map((user) => [user.id, user]));

const rejectsWith = (code: DomainErrorCode) => (error: unknown) =>
  error instanceof DomainError && error.code === code;

describe('setAssignees', () => {
  it('starts new tasks without assignees', () => {
    assert.equal('assignees' in taskIn('draft'), false);
  });

  it('keeps each id once, in first-seen order', () => {
    assert.deepEqual(setAssignees(taskIn('draft'), ['u2', 'u1', 'u2', 'u1']).assignees, ['u2', 'u1']);
  });

  it('removes the field for an empty list', () => {
    assert.equal('assignees' in setAssignees(taskIn('draft', ['u1']), []), false);
  });

  it('changes no other field, in done and failed tasks too', () => {
    for (const status of ['done', 'failed'] as const) {
      const task = taskIn(status);
      assert.deepEqual(setAssignees(task, ['u1']), { ...task, assignees: ['u1'] });
    }
  });

  it('records the change in the changelog with the user who made it', () => {
    const before = taskIn('in_progress', ['u1']);
    const meta = changeMeta(now, { userId: 'u2', via: 'session' });
    assert.deepEqual(taskChanges(before, setAssignees(before, ['u2']), meta), [
      { at: now, actor: 'user', userId: 'u2', field: 'assignees', from: ['u1'], to: ['u2'] },
    ]);
  });

  it('treats a task without assignees as assigned to no one in the changelog', () => {
    const meta = changeMeta(now, 'system');
    assert.deepEqual(taskChanges(taskIn('draft'), setAssignees(taskIn('draft'), []), meta), []);
    assert.deepEqual(taskChanges(taskIn('draft'), setAssignees(taskIn('draft'), ['u1']), meta), [
      { ...meta, field: 'assignees', from: [], to: ['u1'] },
    ]);
  });
});

describe('checkAssignees', () => {
  it('accepts active users', () => {
    assert.deepEqual(checkAssignees([], ['u1', 'u2'], usersOf(ada, bob)), ['u1', 'u2']);
  });

  it('refuses an id no user has', () => {
    assert.throws(() => checkAssignees([], ['u1', 'nobody'], usersOf(ada)), rejectsWith('unknown_user'));
  });

  it('refuses to newly assign a disabled user', () => {
    assert.throws(() => checkAssignees(['u1'], ['u1', 'u3'], usersOf(ada, eve)), rejectsWith('user_disabled'));
  });

  it('keeps a disabled user who is already assigned while someone else is removed', () => {
    assert.deepEqual(checkAssignees(['u1', 'u3'], ['u3'], usersOf(eve)), ['u3']);
  });
});

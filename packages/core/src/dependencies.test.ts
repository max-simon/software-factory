import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertDeletable, isBlocked, setDependencies, unmetDependencies, waitingDependents } from './dependencies.ts';
import { DomainError, type DomainErrorCode } from './errors.ts';
import { createTask } from './operations.ts';
import type { Task, TaskStatus } from './task.ts';

const task = (id: string, status: TaskStatus = 'draft', dependsOn: string[] = [], projectId = 'p1'): Task => ({
  ...createTask({ projectId, title: id, specification: 's', dependsOn }, { id, now: '2026-01-01T00:00:00Z', rank: 0 }),
  status,
});

const rejectsWith = (code: DomainErrorCode, message?: RegExp) => (error: unknown) =>
  error instanceof DomainError && error.code === code && (message === undefined || message.test(error.message));

describe('unmetDependencies', () => {
  it('lists the dependencies that are not done', () => {
    const tasks = [task('a', 'done'), task('b', 'in_progress'), task('c', 'failed')];
    assert.deepEqual(
      unmetDependencies(task('x', 'queued', ['a', 'b', 'c']), tasks).map((t) => t.id),
      ['b', 'c'],
    );
  });

  it('counts a deleted dependency as met', () => {
    assert.equal(isBlocked(task('x', 'queued', ['gone']), [task('a', 'done')]), false);
  });

  it('a task without dependencies is never blocked', () => {
    assert.equal(isBlocked(task('x', 'queued'), [task('a')]), false);
  });
});

describe('setDependencies', () => {
  it('replaces the dependencies of a queued task', () => {
    const tasks = [task('a'), task('b'), task('x', 'queued', ['a'])];
    assert.deepEqual(setDependencies(tasks[2]!, ['b'], tasks).dependsOn, ['b']);
  });

  it('refuses a task that has started', () => {
    const tasks = [task('a'), task('x', 'in_progress')];
    assert.throws(() => setDependencies(tasks[1]!, ['a'], tasks), rejectsWith('not_editable'));
  });

  it('refuses unknown tasks, other projects, the task itself and repeats', () => {
    const x = task('x');
    const tasks = [task('a'), task('other', 'draft', [], 'p2'), x];
    assert.throws(() => setDependencies(x, ['nope'], tasks), rejectsWith('unknown_task'));
    assert.throws(() => setDependencies(x, ['other'], tasks), rejectsWith('invalid_dependencies', /another project/));
    assert.throws(() => setDependencies(x, ['x'], tasks), rejectsWith('invalid_dependencies', /itself/));
    assert.throws(() => setDependencies(x, ['a', 'a'], tasks), rejectsWith('invalid_dependencies', /repeat/));
  });

  it('refuses a cycle and names it', () => {
    const tasks = [task('a', 'queued', ['b']), task('b', 'queued', ['c']), task('c')];
    assert.throws(() => setDependencies(tasks[2]!, ['a'], tasks), rejectsWith('invalid_dependencies', /c → a → b → c/));
  });

  it('accepts a diamond, which is no cycle', () => {
    const tasks = [task('a'), task('b', 'draft', ['a']), task('c', 'draft', ['a']), task('d')];
    assert.deepEqual(setDependencies(tasks[3]!, ['b', 'c'], tasks).dependsOn, ['b', 'c']);
  });
});

describe('waitingDependents', () => {
  it('lists only dependents that have not started', () => {
    const tasks = [task('a'), task('q', 'queued', ['a']), task('r', 'in_progress', ['a']), task('s', 'draft')];
    assert.deepEqual(
      waitingDependents('a', tasks).map((t) => t.id),
      ['q'],
    );
  });
});

describe('assertDeletable', () => {
  it('refuses while a task that has not started depends on it, and names it', () => {
    const tasks = [task('a'), task('q', 'queued', ['a'])];
    assert.throws(() => assertDeletable('a', tasks), rejectsWith('has_waiting_dependents', /q depend on it/));
  });

  it('allows a task whose dependents all started', () => {
    assert.doesNotThrow(() => assertDeletable('a', [task('a'), task('r', 'in_progress', ['a'])]));
  });
});

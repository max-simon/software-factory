import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changeMeta, projectChanges, taskChanges } from './changelog.ts';
import { createTask } from './operations.ts';
import { createProject } from './project.ts';
import type { Task } from './task.ts';

const before: Task = createTask(
  { projectId: 'p1', title: 'Login', specification: 'spec', labels: ['ui', 'auth'] },
  { id: 't1', now: '2026-11-13T09:00:00.000Z', rank: 0 },
);
const meta = { at: '2026-11-13T10:00:00.000Z', actor: 'user' } as const;

describe('taskChanges', () => {
  it('lists every changed tracked field with old and new value', () => {
    const after: Task = { ...before, title: 'Sign-in', specification: 'clear spec', labels: ['ui'], dependsOn: ['t0'], status: 'queued' };
    assert.deepEqual(taskChanges(before, after, meta), [
      { ...meta, field: 'title', from: 'Login', to: 'Sign-in' },
      { ...meta, field: 'specification', from: 'spec', to: 'clear spec' },
      { ...meta, field: 'labels', from: ['ui', 'auth'], to: ['ui'] },
      { ...meta, field: 'dependsOn', from: [], to: ['t0'] },
      { ...meta, field: 'status', from: 'draft', to: 'queued' },
    ]);
  });

  it('ignores untracked fields and labels that are equal but not the same array', () => {
    const after: Task = { ...before, labels: ['ui', 'auth'], plan: [{ title: 'p', status: 'done' }], rank: 4 };
    assert.deepEqual(taskChanges(before, after, meta), []);
  });

  it('records reordered labels', () => {
    const after: Task = { ...before, labels: ['auth', 'ui'] };
    assert.equal(taskChanges(before, after, meta)[0]?.field, 'labels');
  });
});

describe('changeMeta', () => {
  it('records the id of a user, and no user for the other actors', () => {
    assert.deepEqual(changeMeta(meta.at, { userId: 'u1', via: 'session' }), { at: meta.at, actor: 'user', userId: 'u1' });
    assert.deepEqual(changeMeta(meta.at, 'reviewer'), { at: meta.at, actor: 'reviewer' });
  });
});

describe('projectChanges', () => {
  const project = createProject({ title: 'Billing' }, { id: 'p1', now: '2026-11-13T09:00:00.000Z', createdBy: 'u1' });
  const by = { ...meta, userId: 'u2' };

  it('lists every changed tracked field with old and new value', () => {
    const after = { ...project, title: 'Invoices', description: 'All of them', autoMerge: true, updatedAt: by.at };
    assert.deepEqual(projectChanges(project, after, by), [
      { ...by, field: 'title', from: 'Billing', to: 'Invoices' },
      { ...by, field: 'description', from: '', to: 'All of them' },
      { ...by, field: 'autoMerge', from: false, to: true },
    ]);
  });

  it('records nothing when no tracked field changed', () => {
    assert.deepEqual(projectChanges(project, { ...project, updatedAt: by.at }, by), []);
  });
});

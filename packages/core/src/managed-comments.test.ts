import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { managedComments, neutralizeMentions } from './managed-comments.ts';
import { createTask } from './operations.ts';
import type { Task, TaskStatus } from './task.ts';

const digest = (text: string): string => `#${text.length}`;

const taskIn = (status: TaskStatus, fields: Partial<Task> = {}): Task => ({
  ...createTask({ projectId: 'p1', title: 't', specification: 's' }, { id: 't1', now: '2026-01-01T00:00:00Z', rank: 0 }),
  status,
  ...fields,
});

const keys = (task: Task): string[] => managedComments(task, digest).map((comment) => comment.key);

const bodyOf = (task: Task, key: string): string => {
  const comment = managedComments(task, digest).find((candidate) => candidate.key === key);
  assert.ok(comment, key);
  return comment.body;
};

const pendingApproval = { status: 'pending' as const };

const everything = (status: TaskStatus): Task =>
  taskIn(status, {
    clarification: 'What @owner means?',
    failureReason: 'container said SECRET-REASON',
    failedAt: '2026-01-02T00:00:00Z',
    questions: [{ id: 'q1', createdAt: 'x', problem: 'Which?', type: 'radio', options: ['a', 'b'] }],
    decisions: [{ id: 'd1', createdAt: 'x', problem: 'P', options: ['x', 'y'], chosen: 1, reasoning: 'R', approval: pendingApproval }],
    artifacts: [{ id: 'a1', createdAt: 'x', title: 'Plan', kind: 'markdown', content: 'SECRET-CONTENT', approval: pendingApproval }],
    pullRequests: [{ url: 'https://github.com/o/r/pull/1', title: 'Fix', status: 'open' }],
  });

describe('neutralizeMentions', () => {
  it('puts a zero-width space after every @', () => {
    assert.equal(neutralizeMentions('@a and @@b, a@b.c'), '@​a and @​@​b, a@​b.c');
  });

  it('leaves text without @ unchanged', () => {
    assert.equal(neutralizeMentions('plain'), 'plain');
  });
});

describe('managedComments', () => {
  it('has nothing for a fresh draft', () => {
    assert.deepEqual(managedComments(taskIn('draft'), digest), []);
  });

  it('notes a clarification request with a key per note, only while it is required', () => {
    const task = taskIn('clarification_required', { clarification: 'What?' });
    assert.deepEqual(keys(task), ['t1:clarification:#5']);
    assert.match(bodyOf(task, 't1:clarification:#5'), /^\*\*Clarification needed:\*\*\n\nWhat\?\n\nEdit the issue/);
    assert.deepEqual(keys({ ...task, clarification: 'Why not?' }), ['t1:clarification:#8']);
    assert.deepEqual(keys(taskIn('draft', { clarification: 'What?' })), []);
  });

  it('notes each question with its options, answered or not, and where to answer', () => {
    const task = taskIn('input_required', {
      questions: [
        { id: 'q1', createdAt: 'x', problem: 'Which?', type: 'radio', options: ['a', 'b'] },
        { id: 'q2', createdAt: 'x', problem: 'Why?', type: 'text', options: [], answer: ['because'] },
      ],
    });
    assert.deepEqual(keys(task), ['t1:q1', 't1:q2']);
    assert.equal(bodyOf(task, 't1:q1'), '**Question:** Which?\n\n- a\n- b\n\nReply in the factory; comments on this issue are not read.');
    assert.equal(bodyOf(task, 't1:q2'), '**Question:** Why?\n\nReply in the factory; comments on this issue are not read.');
  });

  it('notes a decision with its options, the chosen one marked, and its reasoning', () => {
    const task = taskIn('in_progress', {
      decisions: [
        { id: 'd1', createdAt: 'x', problem: 'P', options: ['x', 'y'], chosen: 1, reasoning: 'R' },
        { id: 'd2', createdAt: 'x', problem: 'Q', options: [], reasoning: 'Just this' },
      ],
    });
    assert.deepEqual(keys(task), ['t1:d1', 't1:d2']);
    assert.equal(bodyOf(task, 't1:d1'), '**Decision:** P\n\n- x\n- y (chosen)\n\nR');
    assert.equal(bodyOf(task, 't1:d2'), '**Decision:** Q\n\nJust this');
  });

  it('notes an artifact by title and kind only', () => {
    const task = taskIn('in_progress', { artifacts: [{ id: 'a1', createdAt: 'x', title: 'Plan', kind: 'markdown', content: 'body' }] });
    assert.deepEqual(managedComments(task, digest), [{ key: 't1:a1', body: '**Artifact:** Plan (markdown)' }]);
  });

  it('notes a pending approval request of a decision or artifact, and none once reviewed', () => {
    const task = everything('input_required');
    assert.deepEqual(keys(task), ['t1:q1', 't1:d1', 't1:d1:approval', 't1:a1', 't1:a1:approval']);
    assert.match(bodyOf(task, 't1:d1:approval'), /^\*\*Approval requested:\*\* decision "P"\n\nReply in the factory/);
    assert.match(bodyOf(task, 't1:a1:approval'), /^\*\*Approval requested:\*\* artifact Plan \(markdown\)/);
    const reviewed = {
      ...task,
      decisions: task.decisions.map((d) => ({ ...d, approval: { status: 'approved' as const } })),
      artifacts: task.artifacts.map((a) => ({ ...a, approval: { status: 'changes_requested' as const } })),
    };
    assert.deepEqual(keys(reviewed), ['t1:q1', 't1:d1', 't1:a1']);
  });

  it('notes each open pull request once the task is ready', () => {
    const pullRequests = [
      { url: 'https://github.com/o/r/pull/1', title: 'Fix', status: 'open' as const },
      { url: 'https://github.com/o/r/pull/2', title: 'Old', status: 'closed' as const },
    ];
    const ready = taskIn('ready', { pullRequests });
    assert.deepEqual(managedComments(ready, digest), [
      { key: 't1:https://github.com/o/r/pull/1', body: '**Pull request to review:** Fix\n\nhttps://github.com/o/r/pull/1' },
    ]);
    assert.deepEqual(keys(taskIn('in_progress', { pullRequests })), []);
  });

  it('notes the pull requests the PR review left open once it has the task wait for the engineer', () => {
    const prReview = { result: 'risky' as const, risk: 'high' as const, reviewedAt: 'x' };
    const pullRequests = [
      { url: 'https://github.com/o/r/pull/1', title: 'Fix', status: 'open' as const, prReview },
      { url: 'https://github.com/o/r/pull/2', title: 'New', status: 'open' as const },
    ];
    assert.deepEqual(keys(taskIn('input_required', { pullRequests })), ['t1:https://github.com/o/r/pull/1']);
  });

  it('notes a failure keyed by its time, falling back to the last update', () => {
    const failed = taskIn('failed', { failureReason: 'boom', failedAt: '2026-01-02T00:00:00Z' });
    assert.deepEqual(managedComments(failed, digest), [{ key: 't1:failed:2026-01-02T00:00:00Z', body: '**Failed:** the task failed. The factory shows the details.' }]);
    assert.deepEqual(keys(taskIn('failed', { failureReason: 'boom' })), ['t1:failed:2026-01-01T00:00:00Z']);
  });

  it('never includes artifact content or the failure reason', () => {
    for (const status of ['clarification_required', 'input_required', 'ready', 'failed'] as const) {
      for (const { body } of managedComments(everything(status), digest)) {
        assert.equal(body.includes('SECRET'), false, body);
      }
    }
  });

  it('neutralises mentions in every text an agent wrote', () => {
    const at = '@x';
    const task = taskIn('ready', {
      questions: [{ id: 'q1', createdAt: 'x', problem: at, type: 'radio', options: [at] }],
      decisions: [{ id: 'd1', createdAt: 'x', problem: at, options: [at], chosen: 0, reasoning: at, approval: pendingApproval }],
      artifacts: [{ id: 'a1', createdAt: 'x', title: at, kind: at, content: 'c', approval: pendingApproval }],
      pullRequests: [{ url: 'https://github.com/o/r/pull/1', title: at, status: 'open' }],
    });
    const comments = [...managedComments(task, digest), ...managedComments(taskIn('clarification_required', { clarification: at }), digest)];
    assert.equal(comments.length, 7);
    for (const { body } of comments) {
      assert.ok(body.includes('@​x'), body);
      assert.equal(/@(?!​)/.test(body), false, body);
    }
  });

  it('scopes every key by the task id', () => {
    for (const status of ['clarification_required', 'input_required', 'ready', 'failed'] as const) {
      for (const key of keys(everything(status))) assert.ok(key.startsWith('t1:'), key);
    }
  });
});

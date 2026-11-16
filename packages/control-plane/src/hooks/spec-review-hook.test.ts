import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionRuntime, Reviewer, SpecReview, SpecReviewRequest, TaskEvent } from '@factory/core';
import { SqliteProjectRepository } from '../adapters/sqlite-project-repository.ts';
import { SqliteTaskRepository } from '../adapters/sqlite-task-repository.ts';
import { ProjectService } from '../project-service.ts';
import { ReviewTracker } from '../review-tracker.ts';
import { createServices } from '../services.ts';
import { Hooks } from './hooks.ts';
import { SpecReviewHook, triggersSpecReview } from './spec-review-hook.ts';

/** Each review waits until the test settles it. */
class FakeReviewer implements Pick<Reviewer, 'reviewSpec'> {
  requests: SpecReviewRequest[] = [];
  #pending: Array<{ resolve: (review: SpecReview) => void; reject: (error: Error) => void }> = [];

  reviewSpec(request: SpecReviewRequest): Promise<SpecReview> {
    this.requests.push(request);
    return new Promise((resolve, reject) => this.#pending.push({ resolve, reject }));
  }

  /** Settles the oldest open review. */
  async answer(review: SpecReview | Error): Promise<void> {
    const next = this.#pending.shift();
    assert.ok(next, 'no review is open');
    if (review instanceof Error) next.reject(review);
    else next.resolve(review);
    // Lets the hook apply the answer and start a follow-up review.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Lets deferred hooks start their review. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

const unclear: SpecReview = { verdict: 'needs_clarification', comment: '- Which repository?' };
const fine: SpecReview = { verdict: 'ready', comment: 'Clear and small.' };

function setup() {
  let counter = 0;
  let clock = Date.parse('2026-11-14T10:00:00.000Z');
  // Every call moves the clock, so each save gets a new `updatedAt`.
  const now = () => new Date(clock++).toISOString();
  const hooks = new Hooks();
  const pending: Promise<void>[] = [];
  const { tasks, service } = createServices({
    repository: new SqliteTaskRepository(':memory:'),
    runtime: {} as ExecutionRuntime,
    onEvent: (event) => void pending.push(hooks.emit(event)),
    newId: () => `t${++counter}`,
    now,
  });
  const projects = new ProjectService({ repository: new SqliteProjectRepository(':memory:'), newId: () => 'p1', now });
  const project = projects.create({ title: 'Billing', description: 'Invoices for customers.' });
  const reviewer = new FakeReviewer();
  const logged: string[] = [];
  const reviews = new ReviewTracker();
  hooks.register(new SpecReviewHook({ tasks, service, projects, reviewer, reviews, log: (message) => logged.push(message) }));
  const createTask = (title = 'Add VAT') => service.create({ projectId: project.id, title, specification: 'Add VAT to invoices.' });
  /** Waits until every hook run so far has finished. */
  const settled = async () => {
    while (pending.length > 0) await pending.shift();
  };
  return { tasks, service, reviewer, logged, createTask, settled, reviews };
}

test('a created draft is reviewed with its project and the other tasks of the project', async () => {
  const { reviewer, createTask, settled, tasks, service } = setup();
  createTask('Existing');
  await tick();
  await reviewer.answer(fine);
  const task = createTask();
  await tick();

  assert.deepEqual(reviewer.requests[1], {
    project: { title: 'Billing', description: 'Invoices for customers.' },
    task: { title: 'Add VAT', specification: 'Add VAT to invoices.', labels: [], autonomyMode: 'autonomous' },
    otherTasks: [{ title: 'Existing', status: 'draft', labels: [], isDependency: false }],
  });
  await reviewer.answer(fine);
  await settled();
  assert.equal(tasks.get(task.id).status, 'draft');
});

test('the request marks the dependencies among the other tasks, and editing them reviews the draft again', async () => {
  const { reviewer, createTask, settled, service } = setup();
  const backend = createTask('Add tax rates API');
  createTask('Send invoices by mail');
  const web = createTask('Show tax rates');
  await tick();
  for (let i = 0; i < 3; i++) await reviewer.answer(fine);
  service.edit(web.id, { dependsOn: [backend.id] });
  await tick();

  assert.equal(reviewer.requests.length, 4);
  assert.deepEqual(reviewer.requests[3]?.otherTasks, [
    { title: 'Add tax rates API', status: 'draft', labels: [], isDependency: true },
    { title: 'Send invoices by mail', status: 'draft', labels: [], isDependency: false },
  ]);
  await reviewer.answer(fine);
  await settled();
});

test('an unclear draft is held for clarification with the comment, logged as a reviewer change', async () => {
  const { reviewer, createTask, settled, tasks, service } = setup();
  const task = createTask();
  await tick();
  await reviewer.answer(unclear);
  await settled();

  const held = tasks.get(task.id);
  assert.equal(held.status, 'clarification_required');
  assert.equal(held.clarification, '- Which repository?');
  assert.deepEqual(
    tasks.changes(task.id).filter((change) => change.field === 'status').map(({ actor }) => actor),
    ['reviewer'],
  );
  assert.equal(reviewer.requests.length, 1, 'the reviewer change triggers no new review');
});

test('a verdict on an outdated version is discarded, and one more review covers all edits made meanwhile', async () => {
  const { reviewer, createTask, settled, tasks, service } = setup();
  const task = createTask();
  await tick();
  service.edit(task.id, { specification: 'Add VAT to invoices in repo billing-api.' });
  service.edit(task.id, { title: 'Add VAT to invoices' });
  await tick();
  assert.equal(reviewer.requests.length, 1, 'edits during a review start none in parallel');

  await reviewer.answer(unclear);
  assert.equal(tasks.get(task.id).status, 'draft', 'the outdated verdict is discarded');
  assert.equal(reviewer.requests.length, 2);
  assert.equal(reviewer.requests[1]!.task.title, 'Add VAT to invoices');

  await reviewer.answer(unclear);
  await settled();
  assert.equal(tasks.get(task.id).status, 'clarification_required');
});

test('a task started or deleted during its review is left alone', async () => {
  const { reviewer, createTask, settled, tasks, service, logged } = setup();
  const started = createTask('started');
  const deleted = createTask('deleted');
  await tick();
  service.start(started.id);
  await service.delete(deleted.id);

  await reviewer.answer(unclear);
  await reviewer.answer(unclear);
  await settled();
  assert.equal(tasks.get(started.id).status, 'queued');
  assert.deepEqual(logged, []);
});

test('a failed review is logged and leaves the task a draft', async () => {
  const { reviewer, createTask, settled, tasks, service, logged } = setup();
  const task = createTask();
  await tick();
  await reviewer.answer(new Error('the reviewer container exited with code 1'));
  await settled();

  assert.equal(tasks.get(task.id).status, 'draft');
  assert.deepEqual(logged, [`spec review: cannot review task ${task.id}: the reviewer container exited with code 1`]);
});

test('returning to draft after a clarification reviews the task again', async () => {
  const { reviewer, createTask, settled, tasks, service } = setup();
  const task = createTask();
  await tick();
  await reviewer.answer(unclear);
  service.edit(task.id, { specification: 'Add VAT to invoices in repo billing-api.' });
  service.returnToDraft(task.id);
  await tick();

  assert.equal(reviewer.requests.length, 2, 'edits while held trigger nothing; the return to draft does');
  await reviewer.answer(fine);
  await settled();
  assert.equal(tasks.get(task.id).status, 'draft');
});

const draft = { id: 't1', status: 'draft' } as TaskEvent['task'];
const meta = { at: '2026-11-14T10:00:00.000Z' };

test('triggersSpecReview: created drafts and engineer edits of title, specification, dependencies or status of drafts', () => {
  assert.equal(triggersSpecReview({ type: 'task.created', task: draft }), true);
  const updated = (actor: 'user' | 'agent', field: 'title' | 'specification' | 'labels'): TaskEvent => ({
    type: 'task.updated',
    task: draft,
    actor,
    changes: field === 'labels' ? [{ ...meta, actor, field, from: [], to: ['x'] }] : [{ ...meta, actor, field, from: 'a', to: 'b' }],
  });
  assert.equal(triggersSpecReview(updated('user', 'title')), true);
  assert.equal(triggersSpecReview(updated('user', 'specification')), true);
  assert.equal(triggersSpecReview(updated('user', 'labels')), false);
  assert.equal(triggersSpecReview(updated('agent', 'specification')), false);
  assert.equal(triggersSpecReview({ type: 'task.created', task: { ...draft, status: 'queued' } }), false);
  const dependsOn: TaskEvent = {
    type: 'task.updated',
    task: draft,
    actor: 'user',
    changes: [{ ...meta, actor: 'user', field: 'dependsOn', from: [], to: ['t0'] }],
  };
  assert.equal(triggersSpecReview(dependsOn), true);
  assert.equal(triggersSpecReview({ ...dependsOn, task: { ...draft, status: 'queued' } }), false);
  assert.equal(
    triggersSpecReview({
      type: 'task.updated',
      task: draft,
      actor: 'user',
      changes: [{ ...meta, actor: 'user', field: 'status', from: 'clarification_required', to: 'draft' }],
    }),
    true,
  );
});

test('a task shows under spec review through all its runs, reruns included, and no longer once they are over', async () => {
  const { reviewer, createTask, settled, service, reviews } = setup();
  const task = createTask();
  assert.equal(reviews.isSpecUnderReview(task.id), false, 'not before the hook runs');
  await tick();
  assert.equal(reviews.isSpecUnderReview(task.id), true);
  service.edit(task.id, { title: 'Add VAT to invoices' });
  await reviewer.answer(fine);
  assert.equal(reviews.isSpecUnderReview(task.id), true, 'still shown while the rerun goes on');
  await reviewer.answer(fine);
  await settled();
  assert.equal(reviews.isSpecUnderReview(task.id), false);
});

test('a failed spec review no longer shows the task under review', async () => {
  const { reviewer, createTask, settled, reviews } = setup();
  const task = createTask();
  await tick();
  assert.equal(reviews.isSpecUnderReview(task.id), true);
  await reviewer.answer(new Error('the reviewer container exited with code 1'));
  await settled();
  assert.equal(reviews.isSpecUnderReview(task.id), false);
});

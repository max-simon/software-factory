import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionRuntime, InputResponse, InputReview, InputReviewRequest, Reviewer } from '@factory/core';
import { SqliteProjectRepository } from '../adapters/sqlite-project-repository.ts';
import { SqliteTaskRepository } from '../adapters/sqlite-task-repository.ts';
import { ProjectService } from '../project-service.ts';
import { ReviewTracker } from '../review-tracker.ts';
import { createServices } from '../services.ts';
import { Hooks } from './hooks.ts';
import { InputReviewHook, openInputIds } from './input-review-hook.ts';
import { ada, sequentialItemIds } from '../test-support.ts';

/** Each review waits until the test settles it. */
class FakeReviewer implements Pick<Reviewer, 'reviewInput'> {
  requests: InputReviewRequest[] = [];
  #pending: Array<{ resolve: (review: InputReview) => void; reject: (error: Error) => void }> = [];

  reviewInput(request: InputReviewRequest): Promise<InputReview> {
    this.requests.push(request);
    return new Promise((resolve, reject) => this.#pending.push({ resolve, reject }));
  }

  /** Settles the oldest open review. */
  async answer(responses: InputResponse[] | Error): Promise<void> {
    const next = this.#pending.shift();
    assert.ok(next, 'no review is open');
    if (responses instanceof Error) next.reject(responses);
    else next.resolve({ responses });
    await tick();
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** `randomItemIds` uses the store's own item ids instead of readable sequential ones. */
function setup({ randomItemIds = false } = {}) {
  let counter = 0;
  const hooks = new Hooks();
  const pending: Promise<void>[] = [];
  const { tasks, service, agent, lifecycle } = createServices({
    repository: new SqliteTaskRepository(':memory:'),
    runtime: { remove: async () => {} } as unknown as ExecutionRuntime,
    onEvent: (event) => void pending.push(hooks.emit(event)),
    newId: () => `t${++counter}`,
    ...(!randomItemIds && { newItemId: sequentialItemIds() }),
  });
  const projects = new ProjectService({ repository: new SqliteProjectRepository(':memory:'), newId: () => 'p1' });
  const project = projects.create({ title: 'Billing', description: 'Invoices for customers.' }, ada);
  const reviewer = new FakeReviewer();
  const logged: string[] = [];
  const reviews = new ReviewTracker();
  hooks.register(new InputReviewHook({ tasks, service, projects, reviewer, reviews, log: (message) => logged.push(message) }));
  /** A supervised task whose agent works. */
  const workingTask = (): string => {
    const { id } = service.create({ projectId: project.id, title: 'Add VAT', specification: 'Add VAT to invoices.', autonomyMode: 'supervised' }, ada);
    service.start(id, ada);
    lifecycle.markInProgress(id, { tokenHash: `hash-${id}`, executionId: `c-${id}` });
    return id;
  };
  const ask = (id: string, problem = 'Which rate?') => agent.askQuestion(id, { problem, type: 'radio', options: ['19%', '7%'] });
  const settled = async () => {
    while (pending.length > 0) await pending.shift();
  };
  return { tasks, service, agent, lifecycle, reviewer, logged, reviews, workingTask, ask, settled };
}

test('a question the reviewer answers is answered on its behalf, with its rationale, and the task resumes', async () => {
  const { tasks, reviewer, workingTask, ask, settled } = setup();
  const id = workingTask();
  ask(id);
  await tick();

  assert.equal(reviewer.requests.length, 1);
  assert.deepEqual(reviewer.requests[0]!.openIds, ['q1']);
  assert.deepEqual(reviewer.requests[0]!.project, { title: 'Billing', description: 'Invoices for customers.' });
  assert.equal(reviewer.requests[0]!.task.questions[0]!.problem, 'Which rate?');
  await reviewer.answer([{ id: 'q1', action: 'answer', answer: ['19%'], rationale: ' The standard rate. ' }]);
  await settled();

  const task = tasks.get(id);
  assert.deepEqual(task.questions[0]!.answer, ['19%']);
  assert.deepEqual(task.questions[0]!.byReviewer, { rationale: 'The standard rate.' });
  assert.equal('answeredBy' in task.questions[0]!, false, 'the reviewer is no user');
  assert.equal(task.status, 'in_progress');
  assert.deepEqual(
    tasks.changes(id).filter((change) => change.field === 'status').map(({ to, actor, userId }) => `${to} by ${userId ?? actor}`),
    ['queued by u1', 'in_progress by system', 'input_required by agent', 'in_progress by reviewer'],
  );
  assert.equal(reviewer.requests.length, 1, 'its own answer triggers no review');
});

test('the reviewer approves, requests changes or leaves each item; what it leaves stays with the engineer', async () => {
  const { tasks, service, agent, reviewer, logged, workingTask, ask, settled } = setup();
  const id = workingTask();
  agent.addDecision(id, { problem: 'Store rates?', options: ['table', 'config'], chosen: 0, reasoning: 'r', requestApproval: true });
  agent.addArtifact(id, { title: 'Design', kind: 'markdown', content: 'c', requestApproval: true });
  await tick();
  assert.deepEqual(reviewer.requests[0]!.openIds, ['d1', 'a1']);
  // Asked while the reviewer decides: one more review covers only the new item.
  ask(id);
  await reviewer.answer([
    { id: 'd1', action: 'approve', rationale: 'Fits the project.' },
    { id: 'a1', action: 'request_changes', comment: 'Cover refunds.', rationale: 'The spec names refunds.' },
  ]);
  assert.deepEqual(reviewer.requests[1]!.openIds, ['q1']);
  await reviewer.answer([{ id: 'q1', action: 'leave_to_human', rationale: 'A business call.' }]);
  await settled();

  const task = tasks.get(id);
  assert.deepEqual(task.decisions[0]!.approval, { status: 'approved', byReviewer: { rationale: 'Fits the project.' } });
  assert.deepEqual(task.artifacts[0]!.approval, {
    status: 'changes_requested',
    comment: 'Cover refunds.',
    byReviewer: { rationale: 'The spec names refunds.' },
  });
  assert.equal(task.status, 'input_required');
  assert.deepEqual(openInputIds(task), ['q1']);

  service.answer(id, 'q1', ['7%'], ada);
  await settled();
  assert.equal(tasks.get(id).status, 'in_progress');
  assert.equal(tasks.get(id).questions[0]!.byReviewer, undefined);
  assert.equal(tasks.get(id).questions[0]!.answeredBy, ada.userId);
  assert.equal(reviewer.requests.length, 2);
  assert.deepEqual(logged, []);
});

test('each item is reviewed once; a new question after the task resumed is reviewed again', async () => {
  const { agent, reviewer, workingTask, ask, settled } = setup();
  const id = workingTask();
  ask(id);
  await tick();
  await reviewer.answer([{ id: 'q1', action: 'leave_to_human', rationale: 'A business call.' }]);
  agent.replacePlan(id, [{ title: 'Wait', status: 'in_progress' }]);
  await settled();
  assert.equal(reviewer.requests.length, 1, 'an agent change with nothing new to decide asks for no review');

  const next = workingTask();
  ask(next);
  await tick();
  await reviewer.answer([{ id: 'q2', action: 'answer', answer: ['19%'], rationale: 'The standard rate.' }]);
  ask(next, 'Which rounding?');
  await tick();
  assert.deepEqual(reviewer.requests[2]!.openIds, ['q3']);
  await reviewer.answer([]);
  await settled();
});

test('a response about an item of an earlier run never reaches the restarted task', async () => {
  const { tasks, service, lifecycle, reviewer, logged, workingTask, ask, settled } = setup({ randomItemIds: true });
  const id = workingTask();
  const earlier = ask(id).question.id;
  await tick();
  await service.restart(id, ada);
  lifecycle.markInProgress(id, { tokenHash: `hash-again-${id}`, executionId: `c-again-${id}` });
  const current = ask(id).question.id;
  assert.notEqual(current, earlier);
  await reviewer.answer([{ id: earlier, action: 'answer', answer: ['19%'], rationale: 'The standard rate.' }]);
  await reviewer.answer([]);
  await settled();

  assert.equal(tasks.get(id).questions[0]!.answer, undefined);
  assert.match(logged.join('\n'), new RegExp(`cannot apply the response to ${earlier}`));
});

test('a response the engineer beat or that does not fit is logged and leaves the item as it is', async () => {
  const { tasks, service, reviewer, logged, workingTask, ask, settled } = setup();
  const id = workingTask();
  ask(id, 'Which rate?');
  ask(id, 'Which rounding?');
  await tick();
  service.answer(id, 'q1', ['7%'], ada);
  await reviewer.answer([
    { id: 'q1', action: 'answer', answer: ['19%'], rationale: 'The standard rate.' },
    { id: 'q2', action: 'answer', answer: ['half up'], rationale: 'Usual.' },
    { id: 'q9', action: 'answer', answer: ['19%'], rationale: 'Made up.' },
  ]);
  await settled();

  assert.deepEqual(tasks.get(id).questions[0]!.answer, ['7%']);
  assert.equal(tasks.get(id).questions[0]!.byReviewer, undefined);
  assert.equal(tasks.get(id).questions[1]!.answer, undefined);
  assert.equal(logged.length, 3);
  assert.match(logged[0]!, /cannot apply the response to q1 of task t1: question q1 is already answered/);
  assert.match(logged[1]!, /cannot apply the response to q2 of task t1: invalid answer to q2/);
  assert.match(logged[2]!, /task t1 has no open item q9/);
});

test('a failed review is logged, not retried, and leaves its items to the engineer', async () => {
  const { tasks, agent, reviewer, logged, workingTask, ask, settled } = setup();
  const id = workingTask();
  ask(id);
  await tick();
  await reviewer.answer(new Error('the reviewer container exited with code 1'));
  agent.replacePlan(id, []);
  await settled();

  assert.deepEqual(openInputIds(tasks.get(id)), ['q1']);
  assert.equal(reviewer.requests.length, 1);
  assert.deepEqual(logged, [`input review: cannot review task ${id}: the reviewer container exited with code 1`]);
});

test('a task shows under input review while the reviewer decides, and no longer once it is done', async () => {
  const { reviewer, reviews, workingTask, ask, settled } = setup();
  const id = workingTask();
  ask(id);
  assert.equal(reviews.isInputUnderReview(id), false, 'not before the hook runs');
  await tick();
  assert.equal(reviews.isInputUnderReview(id), true);
  await reviewer.answer([{ id: 'q1', action: 'leave_to_human', rationale: 'A business call.' }]);
  await settled();
  assert.equal(reviews.isInputUnderReview(id), false);
});

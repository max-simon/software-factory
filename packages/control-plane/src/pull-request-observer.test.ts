import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NewTask, PullRequest, PullRequestReader, PullRequestReview, TaskEvent } from '@factory/core';
import { SqliteTaskRepository } from './adapters/sqlite-task-repository.ts';
import { PullRequestObserver } from './pull-request-observer.ts';
import { createServices } from './services.ts';
import { ada, sequentialItemIds } from './test-support.ts';

class FakePullRequests implements PullRequestReader {
  /** What GitHub answers per URL; a string is thrown as an error. */
  answers = new Map<string, PullRequest | string>();
  reads: string[] = [];

  async read(url: string): Promise<PullRequest> {
    this.reads.push(url);
    const answer = this.answers.get(url);
    if (answer === undefined) throw new Error(`unexpected read of ${url}`);
    if (typeof answer === 'string') throw new Error(answer);
    return answer;
  }
}

function setup() {
  const pullRequests = new FakePullRequests();
  const events: TaskEvent[] = [];
  let counter = 0;
  const services = createServices({
    repository: new SqliteTaskRepository(':memory:'),
    runtime: { start: async () => ({ executionId: 'x' }), notify: async () => ({}), restart: async () => ({}), remove: async () => {}, listExecutions: async () => [] },
    newId: () => `t${++counter}`,
    newItemId: sequentialItemIds(),
    onEvent: (event) => events.push(event),
  });
  const logged: string[] = [];
  const observer = new PullRequestObserver({
    tasks: services.tasks,
    lifecycle: services.lifecycle,
    pullRequests,
    secrets: ['ghp_secret'],
    log: (message) => logged.push(message),
  });
  return { ...services, pullRequests, observer, events, logged };
}

type Fixture = ReturnType<typeof setup>;

const newTask: NewTask = { projectId: 'p1', title: 'task', specification: 'spec', repoUrl: 'https://github.com/o/r' };

const pullRequest = (n: number, fields: Partial<PullRequest> = {}): PullRequest => ({
  url: `https://github.com/o/r/pull/${n}`,
  title: `PR ${n}`,
  status: 'open',
  ...fields,
});

const review: PullRequestReview = {
  id: 9,
  state: 'changes_requested',
  author: 'alice',
  body: 'Why?',
  url: `${pullRequest(1).url}#pullrequestreview-9`,
  submittedAt: '2026-11-17T10:00:00Z',
};

/** A task in progress with the given pull requests reported; `ready` once the agent reported it ready. */
function withPullRequests(f: Fixture, pullRequests: PullRequest[], isReady = false): string {
  const { id } = f.service.create(newTask, ada);
  f.service.start(id, ada);
  f.lifecycle.markInProgress(id, { tokenHash: `hash-${id}`, executionId: `c-${id}` });
  for (const pr of pullRequests) f.agent.addPullRequest(id, { url: pr.url, title: pr.title });
  if (isReady) f.agent.markReady(id);
  return id;
}

const pullRequestEvents = (f: Fixture) => f.events.filter((event) => event.type.startsWith('pull_request.'));

test('records title, status, head and reviews of open pull requests, and saves nothing when nothing changed', async () => {
  const f = setup();
  const id = withPullRequests(f, [pullRequest(1), pullRequest(2)]);
  f.pullRequests.answers.set(pullRequest(1).url, pullRequest(1, { title: 'Renamed', headSha: 'a1', reviews: [review] }));
  f.pullRequests.answers.set(pullRequest(2).url, pullRequest(2, { status: 'merged', headSha: 'b1', reviews: [] }));
  await f.observer.observe();
  assert.deepEqual(f.tasks.get(id).pullRequests, [
    pullRequest(1, { title: 'Renamed', headSha: 'a1', reviews: [review] }),
    pullRequest(2, { status: 'merged', headSha: 'b1', reviews: [] }),
  ]);

  const updatedAt = f.tasks.get(id).updatedAt;
  await f.observer.observe();
  assert.deepEqual(f.pullRequests.reads.slice(2), [pullRequest(1).url], 'merged ones are final');
  assert.equal(f.tasks.get(id).updatedAt, updatedAt);
});

test('emits an event per new review, push, merge and close once the change is recorded', async () => {
  const f = setup();
  const id = withPullRequests(f, [pullRequest(1), pullRequest(2)], true);
  f.pullRequests.answers.set(pullRequest(1).url, pullRequest(1, { headSha: 'a1', reviews: [] }));
  f.pullRequests.answers.set(pullRequest(2).url, pullRequest(2, { headSha: 'b1', reviews: [] }));
  await f.observer.observe();
  assert.deepEqual(pullRequestEvents(f), [], 'the first read raises nothing');

  f.pullRequests.answers.set(pullRequest(1).url, pullRequest(1, { headSha: 'a2', reviews: [review] }));
  f.pullRequests.answers.set(pullRequest(2).url, pullRequest(2, { status: 'closed', headSha: 'b1', reviews: [] }));
  await f.observer.observe();
  const task = f.tasks.get(id);
  assert.deepEqual(pullRequestEvents(f), [
    { type: 'pull_request.pushed', task, pullRequest: task.pullRequests[0]! },
    { type: 'pull_request.reviewed', task, pullRequest: task.pullRequests[0]!, review },
    { type: 'pull_request.closed', task, pullRequest: task.pullRequests[1]! },
  ]);

  f.pullRequests.answers.set(pullRequest(1).url, pullRequest(1, { status: 'merged', headSha: 'a2', reviews: [review] }));
  await f.observer.observe();
  assert.deepEqual(pullRequestEvents(f).slice(3).map((event) => event.type), ['pull_request.merged']);
});

test('emits a conflict when a pull request newly conflicts, and keeps it while GitHub recomputes mergeability', async () => {
  const f = setup();
  const id = withPullRequests(f, [pullRequest(1)], true);
  f.pullRequests.answers.set(pullRequest(1).url, pullRequest(1, { headSha: 'a1', reviews: [], hasConflicts: false }));
  await f.observer.observe();
  f.pullRequests.answers.set(pullRequest(1).url, pullRequest(1, { headSha: 'a1', reviews: [], hasConflicts: true }));
  await f.observer.observe();
  const task = f.tasks.get(id);
  assert.deepEqual(pullRequestEvents(f), [{ type: 'pull_request.conflicted', task, pullRequest: task.pullRequests[0]! }]);

  f.pullRequests.answers.set(pullRequest(1).url, pullRequest(1, { headSha: 'a1', reviews: [] }));
  await f.observer.observe();
  assert.equal(f.tasks.get(id).updatedAt, task.updatedAt, 'unknown mergeability is no change');
  f.pullRequests.answers.set(pullRequest(1).url, pullRequest(1, { headSha: 'a2', reviews: [] }));
  await f.observer.observe();
  assert.equal(f.tasks.get(id).pullRequests[0]!.hasConflicts, true, 'a push keeps the recorded conflict');
  assert.deepEqual(pullRequestEvents(f).slice(1).map((event) => event.type), ['pull_request.pushed']);
});

test('reads the open pull requests of a failed task only while it keeps its execution server', async () => {
  const f = setup();
  const id = withPullRequests(f, [pullRequest(1)]);
  f.lifecycle.markFailed(id, 'boom');
  f.pullRequests.answers.set(pullRequest(1).url, pullRequest(1));
  await f.observer.observe();
  assert.equal(f.pullRequests.reads.length, 1);

  f.lifecycle.detachExecution(id);
  await f.observer.observe();
  assert.equal(f.pullRequests.reads.length, 1);
});

test('a failing GitHub read is logged redacted and does not stop the other tasks', async () => {
  const f = setup();
  const failing = withPullRequests(f, [pullRequest(1)]);
  const other = withPullRequests(f, [pullRequest(2)]);
  f.pullRequests.answers.set(pullRequest(1).url, 'GitHub answered 502 with ghp_secret');
  f.pullRequests.answers.set(pullRequest(2).url, pullRequest(2, { status: 'merged' }));
  await f.observer.observe();
  assert.deepEqual(f.logged, [`pull request observer: task ${failing}: GitHub answered 502 with [redacted]`]);
  assert.equal(f.tasks.get(other).pullRequests[0]!.status, 'merged');
});

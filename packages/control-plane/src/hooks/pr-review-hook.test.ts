import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionRuntime, PrReviewRequest, PullRequestWriter, Reviewer, RiskLevel } from '@factory/core';
import { SqliteProjectRepository } from '../adapters/sqlite-project-repository.ts';
import { SqliteTaskRepository } from '../adapters/sqlite-task-repository.ts';
import { SqliteUserRepository } from '../adapters/sqlite-user-repository.ts';
import { ProjectService } from '../project-service.ts';
import { ReviewTracker } from '../review-tracker.ts';
import { createServices } from '../services.ts';
import { Hooks } from './hooks.ts';
import { PrReviewHook } from './pr-review-hook.ts';
import { ada } from '../test-support.ts';

const prUrl = (n: number) => `https://github.com/o/r/pull/${n}`;

interface Fakes {
  /** Risk per pull request number; a missing one fails the review. */
  risks?: Record<number, RiskLevel>;
  refusedMerges?: ReadonlySet<string>;
  isCommentRefused?: boolean;
  /** Each review waits until the test releases it. */
  isHeld?: boolean;
  /** Runs while a comment is posted, e.g. to change the task meanwhile. */
  onComment?: () => void;
}

function setup({ risks = { 1: 'low', 2: 'low' }, refusedMerges = new Set(), isCommentRefused = false, isHeld = false, onComment }: Fakes = {}) {
  let counter = 0;
  let projectCounter = 0;
  const merged: Array<{ url: string; headSha: string }> = [];
  const comments: Array<{ url: string; body: string }> = [];
  const reviewed: PrReviewRequest[] = [];
  const logged: string[] = [];
  const pending: Promise<void>[] = [];
  const reviews = new ReviewTracker();
  /** Which of pull requests 1 and 2 showed as under review at each call the hook made. */
  const shown: Array<{ call: string; numbers: number[] }> = [];
  const held: Array<() => void> = [];
  /** Lets the oldest held review answer. */
  const release = async () => {
    held.shift()!();
    await tick();
  };
  const show = (call: string) => shown.push({ call, numbers: [1, 2].filter((n) => reviews.isPrUnderReview(prUrl(n))) });
  const pullRequests: PullRequestWriter = {
    readHead: async (url) => {
      show(`readHead ${url.split('/').pop()}`);
      return `sha-${url.split('/').pop()}`;
    },
    comment: async (url, body) => {
      show(`comment ${url.split('/').pop()}`);
      if (isCommentRefused) throw new Error('GitHub answered 403');
      onComment?.();
      comments.push({ url, body });
    },
    merge: async (url, headSha) => {
      show(`merge ${url.split('/').pop()}`);
      if (refusedMerges.has(url)) throw new Error('GitHub answered 405');
      merged.push({ url, headSha });
    },
  };
  const reviewer: Pick<Reviewer, 'reviewPr'> = {
    reviewPr: async (request) => {
      show(`reviewPr ${request.pullRequest.url.split('/').pop()}`);
      reviewed.push(request);
      if (isHeld) await new Promise<void>((resolve) => held.push(resolve));
      const risk = risks[Number(request.pullRequest.url.split('/').pop())];
      if (!risk) throw new Error('the reviewer container exited with code 1');
      return { risk, comment: `why ${risk}` };
    },
  };
  const hooks = new Hooks((message) => logged.push(message));
  const { tasks, service, agent, lifecycle } = createServices({
    repository: new SqliteTaskRepository(':memory:'),
    users: new SqliteUserRepository(':memory:'),
    runtime: {} as ExecutionRuntime,
    onEvent: (event) => void pending.push(hooks.emit(event)),
    newId: () => `t${++counter}`,
  });
  const projects = new ProjectService({ repository: new SqliteProjectRepository(':memory:'), newId: () => `p${++projectCounter}` });
  const autoMerged = projects.create({ title: 'Auto', autoMerge: true }, ada);
  const manual = projects.create({ title: 'Manual' }, ada);
  hooks.register(new PrReviewHook({ tasks, pullRequests, reviewer, projects, reviews, log: (message) => logged.push(message) }));
  /** A task in progress in `projectId` that reported one pull request per number. */
  const workingTask = (projectId: string, numbers: number[]): string => {
    const { id } = service.create({ projectId, title: 't', specification: 's', repoUrl: 'https://github.com/o/r' }, ada);
    service.start(id, ada);
    lifecycle.markInProgress(id, { tokenHash: `hash-${id}`, executionId: `c-${id}` });
    for (const n of numbers) agent.addPullRequest(id, { url: prUrl(n), title: `PR ${n}` });
    return id;
  };
  const settled = async () => {
    while (pending.length > 0) await pending.shift();
  };
  return { tasks, service, agent, lifecycle, autoMerged, manual, merged, comments, reviewed, logged, workingTask, settled, release, reviews, shown };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('reviews every open pull request once its task turns ready, comments and merges the low-risk ones at their head', async () => {
  const { agent, autoMerged, merged, comments, reviewed, workingTask, settled } = setup({ risks: { 1: 'low', 2: 'high' } });
  const id = workingTask(autoMerged.id, [1, 2]);
  await settled();
  assert.deepEqual(reviewed, [], 'nothing is reviewed while the agent works');
  agent.markReady(id);
  await settled();
  assert.deepEqual(reviewed[0], {
    task: { title: 't', specification: 's' },
    pullRequest: { url: prUrl(1), headSha: 'sha-1' },
  });
  assert.deepEqual(merged, [{ url: prUrl(1), headSha: 'sha-1' }]);
  assert.deepEqual(comments, [
    { url: prUrl(1), body: '**PR review: low risk.** Merging without a human review.\n\nwhy low' },
    { url: prUrl(2), body: '**PR review: high risk.** Left open for a human review.\n\nwhy high' },
  ]);
});

test('reviews the pull requests of a project without auto-merge but merges none', async () => {
  const { agent, manual, merged, comments, workingTask, settled } = setup();
  agent.markReady(workingTask(manual.id, [1]));
  await settled();
  assert.deepEqual(merged, []);
  assert.deepEqual(comments, [
    { url: prUrl(1), body: '**PR review: low risk.** Auto-merge is off for this project, so it is left open for a human.\n\nwhy low' },
  ]);
});

test('skips pull requests no longer open', async () => {
  const { agent, lifecycle, autoMerged, merged, workingTask, settled } = setup();
  const id = workingTask(autoMerged.id, [1, 2]);
  lifecycle.updatePullRequests(id, [{ url: prUrl(1), title: 'PR 1', status: 'closed', reviews: [] }]);
  agent.markReady(id);
  await settled();
  assert.deepEqual(merged, [{ url: prUrl(2), headSha: 'sha-2' }]);
});

test('comments a failed review without its cause and goes on with the next pull request', async () => {
  const { agent, autoMerged, merged, comments, logged, workingTask, settled } = setup({ risks: { 2: 'low' } });
  const id = workingTask(autoMerged.id, [1, 2]);
  agent.markReady(id);
  await settled();
  assert.deepEqual(merged, [{ url: prUrl(2), headSha: 'sha-2' }]);
  assert.match(comments[0]!.body, /PR review failed.*factory's log has the cause/);
  assert.doesNotMatch(comments[0]!.body, /exited/);
  assert.deepEqual(logged, [`pr review: cannot review ${prUrl(1)} of task ${id}: the reviewer container exited with code 1`]);
});

test('comments and logs a refused merge', async () => {
  const { agent, autoMerged, merged, comments, logged, workingTask, settled } = setup({ refusedMerges: new Set([prUrl(1)]) });
  const id = workingTask(autoMerged.id, [1, 2]);
  agent.markReady(id);
  await settled();
  assert.deepEqual(merged, [{ url: prUrl(2), headSha: 'sha-2' }]);
  assert.deepEqual(
    comments.filter((comment) => comment.url === prUrl(1)).map((comment) => comment.body.split('\n')[0]),
    ['**PR review: low risk.** Merging without a human review.', '**PR review could not merge this pull request.** It is left open for a human review.'],
  );
  assert.deepEqual(logged, [`pr review: cannot merge ${prUrl(1)} of task ${id}: GitHub answered 405`]);
});

test('merges nothing whose decision it cannot comment', async () => {
  const { agent, autoMerged, merged, logged, workingTask, settled } = setup({ isCommentRefused: true });
  const id = workingTask(autoMerged.id, [1]);
  agent.markReady(id);
  await settled();
  assert.deepEqual(merged, []);
  assert.deepEqual(logged, [`pr review: cannot review ${prUrl(1)} of task ${id}: GitHub answered 403`]);
});

test('leaves the task as it is: the review resumes no agent', async () => {
  const { tasks, agent, autoMerged, workingTask, settled } = setup({ risks: { 1: 'high' } });
  const id = workingTask(autoMerged.id, [1]);
  agent.markReady(id);
  const before = tasks.get(id);
  await settled();
  assert.deepEqual(tasks.get(id), before);
  assert.deepEqual(tasks.get(id).followUps, []);
});

test('shows each pull request under review from reading its head until its decision and merge are over, one at a time', async () => {
  const { agent, autoMerged, workingTask, settled, reviews, shown } = setup({ risks: { 1: 'low', 2: 'high' } });
  const id = workingTask(autoMerged.id, [1, 2]);
  await settled();
  agent.markReady(id);
  await settled();
  assert.deepEqual(shown, [
    { call: 'readHead 1', numbers: [1] },
    { call: 'reviewPr 1', numbers: [1] },
    { call: 'comment 1', numbers: [1] },
    { call: 'merge 1', numbers: [1] },
    { call: 'readHead 2', numbers: [2] },
    { call: 'reviewPr 2', numbers: [2] },
    { call: 'comment 2', numbers: [2] },
  ]);
  assert.equal(reviews.isPrUnderReview(prUrl(1)), false);
  assert.equal(reviews.isPrUnderReview(prUrl(2)), false);
});

test('clears a pull request under review when the reviewer, the comment or the merge fails', async () => {
  const failedReview = setup({ risks: {} });
  failedReview.agent.markReady(failedReview.workingTask(failedReview.autoMerged.id, [1]));
  await failedReview.settled();
  assert.deepEqual(failedReview.shown.find((s) => s.call === 'reviewPr 1'), { call: 'reviewPr 1', numbers: [1] });
  assert.equal(failedReview.reviews.isPrUnderReview(prUrl(1)), false);

  const refusedComment = setup({ isCommentRefused: true });
  refusedComment.agent.markReady(refusedComment.workingTask(refusedComment.autoMerged.id, [1]));
  await refusedComment.settled();
  assert.ok(refusedComment.logged.length > 0, 'the refused comment threw');
  assert.equal(refusedComment.reviews.isPrUnderReview(prUrl(1)), false);

  const refusedMerge = setup({ refusedMerges: new Set([prUrl(1)]) });
  refusedMerge.agent.markReady(refusedMerge.workingTask(refusedMerge.autoMerged.id, [1]));
  await refusedMerge.settled();
  assert.deepEqual(refusedMerge.merged, []);
  assert.equal(refusedMerge.reviews.isPrUnderReview(prUrl(1)), false);
});

test('drops the decision when a follow-up moved the task back to work during the review', async () => {
  const { service, agent, autoMerged, merged, comments, logged, workingTask, settled, release } = setup({ isHeld: true });
  const id = workingTask(autoMerged.id, [1]);
  agent.markReady(id);
  await tick();
  service.addFollowUp(id, 'Rename the flag', ada);
  await release();
  await settled();
  assert.deepEqual(merged, []);
  assert.deepEqual(comments, []);
  assert.match(logged.join('\n'), /changed while .*pull\/1 was reviewed/);
});

test('a task that turns ready again outdates the running review; the newer run decides alone', async () => {
  const { service, agent, autoMerged, merged, comments, reviewed, workingTask, settled, release } = setup({ isHeld: true });
  const id = workingTask(autoMerged.id, [1]);
  agent.markReady(id);
  await tick();
  service.addFollowUp(id, 'Rename the flag', ada);
  agent.markReady(id);
  await tick();
  assert.equal(reviewed.length, 1, 'the newer run waits for the running one');
  await release();
  assert.equal(reviewed.length, 2);
  await release();
  await settled();
  assert.deepEqual(merged, [{ url: prUrl(1), headSha: 'sha-1' }]);
  assert.equal(comments.length, 1);
});

test('does not merge when the task changed while the decision was posted, and says so', async () => {
  let isChanged = false;
  const fakes = setup({
    onComment: () => {
      if (isChanged) return;
      isChanged = true;
      fakes.service.addFollowUp(id, 'Wait, one more thing', ada);
    },
  });
  const id = fakes.workingTask(fakes.autoMerged.id, [1]);
  fakes.agent.markReady(id);
  await fakes.settled();
  assert.deepEqual(fakes.merged, []);
  assert.deepEqual(
    fakes.comments.map(({ body }) => body.split('\n')[0]),
    [
      '**PR review: low risk.** Merging without a human review.',
      '**PR review did not merge this pull request.** Its task changed while the decision was posted; it is left open for a human review.',
    ],
  );
});

test('merges nothing of a task cancelled during the review', async () => {
  const { lifecycle, agent, autoMerged, merged, comments, workingTask, settled, release } = setup({ isHeld: true });
  const id = workingTask(autoMerged.id, [1]);
  agent.markReady(id);
  await tick();
  lifecycle.markFailed(id, 'Cancelled');
  await release();
  await settled();
  assert.deepEqual(merged, []);
  assert.deepEqual(comments, []);
});

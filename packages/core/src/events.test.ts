import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pullRequestEvents } from './events.ts';
import { createTask } from './operations.ts';
import type { PullRequest, PullRequestReview, Task } from './task.ts';

const url = 'https://github.com/o/r/pull/1';
const pr = (fields: Partial<PullRequest> = {}): PullRequest => ({ url, title: 'PR', status: 'open', headSha: 'a1', reviews: [], ...fields });
const review = (id: number): PullRequestReview => ({
  id,
  state: 'commented',
  author: 'alice',
  body: 'why?',
  url: `${url}#pullrequestreview-${id}`,
  submittedAt: '2026-11-17T10:00:00Z',
});
const task = (...pullRequests: PullRequest[]): Task => ({
  ...createTask({ projectId: 'p1', title: 't', specification: 's' }, { id: 't1', now: '2026-11-17T09:00:00.000Z', rank: 0 }),
  pullRequests,
});

describe('pullRequestEvents', () => {
  it('raises nothing when nothing changed', () => {
    assert.deepEqual(pullRequestEvents(task(pr()), task(pr())), []);
  });

  it('raises one event per new review, in order', () => {
    const after = task(pr({ reviews: [review(1), review(2), review(3)] }));
    const events = pullRequestEvents(task(pr({ reviews: [review(1)] })), after);
    assert.deepEqual(events, [
      { type: 'pull_request.reviewed', task: after, pullRequest: after.pullRequests[0]!, review: review(2) },
      { type: 'pull_request.reviewed', task: after, pullRequest: after.pullRequests[0]!, review: review(3) },
    ]);
  });

  it('counts reviews as new when the reviews were never read', () => {
    const after = task(pr({ reviews: [review(1)] }));
    assert.deepEqual(
      pullRequestEvents(task(pr({ reviews: undefined })), after).map((event) => event.type),
      ['pull_request.reviewed'],
    );
  });

  it('raises a push when the head moves, but not when it is first read', () => {
    const after = task(pr({ headSha: 'b2' }));
    assert.deepEqual(pullRequestEvents(task(pr()), after), [{ type: 'pull_request.pushed', task: after, pullRequest: after.pullRequests[0]! }]);
    assert.deepEqual(pullRequestEvents(task(pr({ headSha: undefined })), after), []);
  });

  it('raises a conflict when the pull request newly conflicts with its base', () => {
    const after = task(pr({ hasConflicts: true }));
    const conflicted = [{ type: 'pull_request.conflicted', task: after, pullRequest: after.pullRequests[0]! }];
    assert.deepEqual(pullRequestEvents(task(pr({ hasConflicts: false })), after), conflicted);
    assert.deepEqual(pullRequestEvents(task(pr()), after), conflicted);
  });

  it('raises no conflict while it stays known or when it is cleared', () => {
    const conflicted = task(pr({ hasConflicts: true }));
    assert.deepEqual(pullRequestEvents(conflicted, conflicted), []);
    assert.deepEqual(pullRequestEvents(conflicted, task(pr({ hasConflicts: false }))), []);
    assert.deepEqual(pullRequestEvents(conflicted, task(pr())), []);
  });

  it('raises a conflict again when one returns after it was resolved', () => {
    const versions = [true, false, true].map((hasConflicts) => task(pr({ hasConflicts })));
    const types = versions.slice(1).flatMap((after, i) => pullRequestEvents(versions[i]!, after).map((event) => event.type));
    assert.deepEqual(types, ['pull_request.conflicted']);
    assert.deepEqual(pullRequestEvents(task(pr({ hasConflicts: false })), versions[0]!).map((event) => event.type), ['pull_request.conflicted']);
  });

  it('raises no conflict for a pull request that is no longer open', () => {
    assert.deepEqual(pullRequestEvents(task(pr({ status: 'merged' })), task(pr({ status: 'merged', hasConflicts: true }))), []);
  });

  it('raises merged and closed once, when the pull request leaves open', () => {
    const merged = task(pr({ status: 'merged' }));
    assert.deepEqual(pullRequestEvents(task(pr()), merged), [{ type: 'pull_request.merged', task: merged, pullRequest: merged.pullRequests[0]! }]);
    assert.deepEqual(pullRequestEvents(task(pr()), task(pr({ status: 'closed' }))).map((event) => event.type), ['pull_request.closed']);
    assert.deepEqual(pullRequestEvents(merged, merged), []);
  });

  it('ignores pull requests the task did not have before', () => {
    assert.deepEqual(pullRequestEvents(task(), task(pr({ reviews: [review(1)], status: 'merged' }))), []);
  });
});

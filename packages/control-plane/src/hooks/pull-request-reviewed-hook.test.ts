import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PullRequest, PullRequestReview, Task, TaskEvent } from '@factory/core';
import { SqliteTaskRepository } from '../adapters/sqlite-task-repository.ts';
import { createServices } from '../services.ts';
import { ada, noIssues, sequentialItemIds } from '../test-support.ts';
import { addressReviewSkill, PullRequestReviewedHook, reviewFollowUp } from './pull-request-reviewed-hook.ts';

const url = 'https://github.com/o/r/pull/1';
const review = (fields: Partial<PullRequestReview> = {}): PullRequestReview => ({
  id: 9,
  state: 'changes_requested',
  author: 'alice',
  body: 'Please rename.',
  url: `${url}#pullrequestreview-9`,
  submittedAt: '2026-11-17T10:00:00Z',
  ...fields,
});

/** A ready task with an idle worker and one open pull request. */
function setup() {
  const services = createServices({
    repository: new SqliteTaskRepository(':memory:'),
    issues: noIssues,
    runtime: { start: async () => ({ executionId: 'x' }), notify: async () => {}, notifyShell: async () => {}, restart: async () => {}, remove: async () => {}, listExecutions: async () => [] },
    newId: () => 't1',
    newItemId: sequentialItemIds(),
  });
  const { service, agent, lifecycle } = services;
  service.create({ projectId: 'p1', title: 'task', specification: 'spec', repoUrl: 'https://github.com/o/r' }, ada);
  service.start('t1', ada);
  lifecycle.markInProgress('t1', { tokenHash: 'hash', executionId: 'c1' });
  agent.addPullRequest('t1', { url, title: 'PR' });
  agent.markReady('t1');
  lifecycle.releaseWorker('t1', 'unused');
  return { ...services, hook: new PullRequestReviewedHook({ lifecycle }) };
}

const reviewed = (task: Task, r: PullRequestReview): TaskEvent => ({
  type: 'pull_request.reviewed',
  task,
  pullRequest: task.pullRequests[0] as PullRequest,
  review: r,
});

test('a review becomes a follow-up from the system that names the skill and resumes the task', async () => {
  const f = setup();
  await f.hook.handle(reviewed(f.tasks.get('t1'), review()));
  const task = f.tasks.get('t1');
  assert.equal(task.status, 'in_progress');
  assert.deepEqual(task.followUps.map((followUp) => followUp.message), [reviewFollowUp(url, review())]);
  assert.match(task.followUps[0]!.message, /`address-pr-review` skill to address review 9/);
  assert.equal(f.tasks.changes('t1').at(-1)!.actor, 'system');
});

test('an approval without a body asks for nothing; one with a body is handed on', async () => {
  const f = setup();
  await f.hook.handle(reviewed(f.tasks.get('t1'), review({ state: 'approved', body: ' ' })));
  assert.deepEqual(f.tasks.get('t1').followUps, []);
  await f.hook.handle(reviewed(f.tasks.get('t1'), review({ state: 'approved', body: 'LGTM, one nit.' })));
  assert.equal(f.tasks.get('t1').followUps.length, 1);
});

test('ignores the other pull request events', async () => {
  const f = setup();
  const task = f.tasks.get('t1');
  for (const type of ['pull_request.pushed', 'pull_request.merged', 'pull_request.closed'] as const) {
    await f.hook.handle({ type, task, pullRequest: task.pullRequests[0]! });
  }
  assert.deepEqual(f.tasks.get('t1').followUps, []);
});

test('fails for a task without an execution server, which can take no follow-up', async () => {
  const f = setup();
  f.lifecycle.markFailed('t1', 'boom');
  f.lifecycle.detachExecution('t1');
  await assert.rejects(f.hook.handle(reviewed(f.tasks.get('t1'), review())), /no execution server/);
});

test('names a skill the executor image ships', async () => {
  const skill = await readFile(new URL(`../../../executor/skills/${addressReviewSkill}/SKILL.md`, import.meta.url), 'utf8');
  assert.match(skill, new RegExp(`^---\\nname: ${addressReviewSkill}\\n`));
});

import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PullRequest, Task, TaskEvent } from '@factory/core';
import { SqliteTaskRepository } from '../adapters/sqlite-task-repository.ts';
import { SqliteUserRepository } from '../adapters/sqlite-user-repository.ts';
import { createServices } from '../services.ts';
import { ada, sequentialItemIds } from '../test-support.ts';
import { conflictFollowUp, PullRequestConflictedHook, resolveConflictSkill } from './pull-request-conflicted-hook.ts';

const url = 'https://github.com/o/r/pull/1';

/** A ready task with an idle worker and one open pull request. */
function setup() {
  const services = createServices({
    repository: new SqliteTaskRepository(':memory:'),
    users: new SqliteUserRepository(':memory:'),
    runtime: { start: async () => ({ executionId: 'x' }), notify: async () => ({}), restart: async () => ({}), remove: async () => {}, listExecutions: async () => [] },
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
  return { ...services, hook: new PullRequestConflictedHook({ lifecycle }) };
}

const conflicted = (task: Task, fields: Partial<PullRequest> = {}): TaskEvent => ({
  type: 'pull_request.conflicted',
  task,
  pullRequest: { ...(task.pullRequests[0] as PullRequest), hasConflicts: true, ...fields },
});

test('a conflict becomes a follow-up from the system that names the base branch and the skill and resumes the task', async () => {
  const f = setup();
  await f.hook.handle(conflicted(f.tasks.get('t1'), { baseBranch: 'main' }));
  const task = f.tasks.get('t1');
  assert.equal(task.status, 'in_progress');
  assert.deepEqual(task.followUps.map((followUp) => followUp.message), [conflictFollowUp(url, 'main')]);
  assert.equal(
    task.followUps[0]!.message,
    `${url} has merge conflicts with its base branch \`main\`.\nUse the \`resolve-merge-conflict\` skill to resolve them.`,
  );
  assert.equal(f.tasks.changes('t1').at(-1)!.actor, 'system');
  assert.equal(task.followUps[0]!.bySystem, true);
  assert.equal(task.followUps[0]!.authorId, undefined);
});

test('the follow-up does without the base branch when it is unknown', () => {
  assert.match(conflictFollowUp(url), /^https:\/\/github\.com\/o\/r\/pull\/1 has merge conflicts with its base branch\.\n/);
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
  await assert.rejects(f.hook.handle(conflicted(f.tasks.get('t1'))), /no execution server/);
});

test('names a skill the executor image ships', async () => {
  const skill = await readFile(new URL(`../../../executor/skills/${resolveConflictSkill}/SKILL.md`, import.meta.url), 'utf8');
  assert.match(skill, new RegExp(`^---\\nname: ${resolveConflictSkill}\\n`));
});

import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createTask, requestClarification, restartTask, startTask, statusLabel, statusLabelPrefix, transitions, type ExternalIssue, type IssueProvider, type Task, type TaskEvent, type TaskStatus } from '@factory/core';
import { SqliteProjectRepository } from './adapters/sqlite-project-repository.ts';
import { SqliteTaskRepository } from './adapters/sqlite-task-repository.ts';
import { IssueSync } from './issue-sync-service.ts';
import { TaskStore } from './task-store.ts';

class FakeIssues implements IssueProvider {
  issues: ExternalIssue[] = [];
  /** Posted comments, at most one per `(url, key)` like the real provider. */
  comments: { url: string; key: string; body: string }[] = [];
  /** Commenting on these URLs fails with the error message. */
  failures = new Map<string, string>();
  labelled: string[] = [];
  /** Listing fails with this message while set. */
  listFailure: string | undefined;
  /** Repository URLs `listIssues` looks in. */
  repoUrls = ['https://github.com/o/r'];
  labelChanges: { url: string; add: string[]; remove: string[] }[] = [];
  /** Changing labels fails with this message while set. */
  labelFailure: string | undefined;
  /** Changing labels on these URLs fails with the error message. */
  labelFailures = new Map<string, string>();

  async listIssues(label: string): Promise<ExternalIssue[]> {
    this.labelled.push(label);
    if (this.listFailure !== undefined) throw new Error(this.listFailure);
    return this.issues.map((issue) => ({ ...issue, labels: [...issue.labels] }));
  }

  covers(url: string): boolean {
    return this.repoUrls.some((repoUrl) => url.startsWith(`${repoUrl}/`));
  }

  async changeLabels(url: string, change: { add: string[]; remove: string[] }): Promise<void> {
    const failure = this.labelFailure ?? this.labelFailures.get(url);
    if (failure !== undefined) throw new Error(failure);
    this.labelChanges.push({ url, ...change });
    const issue = this.issues.find((candidate) => candidate.url === url);
    if (issue) issue.labels = [...issue.labels.filter((label) => !change.remove.includes(label)), ...change.add];
  }

  async comment(url: string, key: string, body: string): Promise<void> {
    const failure = this.failures.get(url);
    if (failure !== undefined) throw new Error(failure);
    if (this.comments.some((c) => c.url === url && c.key === key)) return;
    this.comments.push({ url, key, body });
  }

  /** Label changes other than status reports, which any pass may make. */
  commandChanges(): { url: string; add: string[]; remove: string[] }[] {
    const isStatus = (label: string) => label.toLowerCase().startsWith(statusLabelPrefix);
    return this.labelChanges.filter((change) => ![...change.add, ...change.remove].every(isStatus));
  }

  statusLabels(url: string): string[] {
    const issue = this.issues.find((candidate) => candidate.url === url);
    return (issue?.labels ?? []).filter((label) => label.toLowerCase().startsWith(statusLabelPrefix));
  }

  keys(url: string): string[] {
    return this.comments.filter((c) => c.url === url).map((c) => c.key);
  }
}

const sha16 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

const issue = (n: number, fields: Partial<ExternalIssue> = {}): ExternalIssue => ({
  provider: 'github',
  url: `https://github.com/o/r/issues/${n}`,
  key: `o/r#${n}`,
  repoUrl: 'https://github.com/o/r',
  title: `Issue ${n}`,
  body: `Body ${n}`,
  labels: ['factory', 'factory:project:p1'],
  isOpen: true,
  ...fields,
});

function setup() {
  const provider = new FakeIssues();
  const events: TaskEvent[] = [];
  let clock = 0;
  const tasks = new TaskStore({
    repository: new SqliteTaskRepository(':memory:'),
    onEvent: (event) => events.push(event),
    now: () => new Date(Date.UTC(2026, 10, 19, 10, 0, clock++)).toISOString(),
  });
  const projects = new SqliteProjectRepository(':memory:');
  projects.insert(createProject({ title: 'P' }, { id: 'p1', now: '2026-11-19T09:00:00.000Z' }));
  const logged: string[] = [];
  let ids = 0;
  const sync = new IssueSync({
    tasks,
    projects,
    provider,
    secrets: ['ghp_secret'],
    log: (message) => logged.push(message),
    newId: () => `t${++ids}`,
  });
  return { provider, tasks, events, logged, sync };
}

type Fixture = ReturnType<typeof setup>;

/** Imports `issue` and returns its task id. */
async function imported(f: Fixture, synced: ExternalIssue): Promise<string> {
  f.provider.issues = [synced];
  await f.sync.sync();
  return f.tasks.findByExternalUrl(synced.url)!.id;
}

test('imports an open issue as a draft managed task, created by system, with a task-id comment', async () => {
  const f = setup();
  f.provider.issues = [
    issue(1, { labels: ['bug', 'factory', 'Factory:Project:p1', 'factory:supervised', 'factory:model:sonnet', 'ui', 'bug'] }),
  ];
  await f.sync.sync();
  assert.deepEqual(f.provider.labelled, ['factory']);
  const task = f.tasks.get('t1');
  assert.equal(task.status, 'draft');
  assert.equal(task.projectId, 'p1');
  assert.equal(task.repoUrl, 'https://github.com/o/r');
  assert.equal(task.title, 'Issue 1');
  assert.equal(task.specification, 'Body 1');
  assert.deepEqual(task.labels, ['bug', 'ui']);
  assert.equal(task.autonomyMode, 'supervised');
  assert.equal(task.model, 'sonnet');
  assert.equal(task.agent, 'claude');
  assert.deepEqual(task.external, { provider: 'github', url: issue(1).url, key: 'o/r#1' });
  assert.equal('createdBy' in task, false);
  assert.deepEqual(f.tasks.changes('t1'), [{ at: task.createdAt, actor: 'system', field: 'created' }]);
  assert.deepEqual(f.provider.comments, [{ url: issue(1).url, key: 't1:task-id', body: 'The factory tracks this issue as task `t1`.' }]);
  assert.deepEqual(f.logged, []);
});

test('defaults apply without config labels, and a second pass neither duplicates the task nor the comment', async () => {
  const f = setup();
  f.provider.issues = [issue(1), issue(2)];
  await f.sync.sync();
  await f.sync.sync();
  assert.deepEqual(f.tasks.list().map((t) => [t.id, t.autonomyMode, t.model, t.rank]), [['t1', 'autonomous', 'opus', 0], ['t2', 'autonomous', 'opus', 1]]);
  assert.deepEqual(f.provider.keys(issue(1).url), ['t1:task-id']);
  assert.equal(f.events.filter((event) => event.type === 'task.updated').length, 0);
});

test('skips issues without a project label or with an unknown project silently, logging one line per pass', async () => {
  const f = setup();
  f.provider.issues = [issue(1, { labels: ['factory'] }), issue(2, { labels: ['factory', 'factory:project:nope'] })];
  await f.sync.sync();
  assert.deepEqual(f.tasks.list(), []);
  assert.deepEqual(f.provider.comments, []);
  assert.deepEqual(f.logged, [`issue sync: skipped 2 issues without a known project label: ${issue(1).url}, ${issue(2).url}`]);
});

test('does not import closed issues', async () => {
  const f = setup();
  f.provider.issues = [issue(1, { isOpen: false })];
  await f.sync.sync();
  assert.deepEqual(f.tasks.list(), []);
  assert.deepEqual(f.provider.comments, []);
  assert.deepEqual(f.logged, []);
});

test('an issue with an empty body is not imported and gets one comment', async () => {
  const f = setup();
  f.provider.issues = [issue(1, { body: ' \n ' })];
  await f.sync.sync();
  await f.sync.sync();
  assert.deepEqual(f.tasks.list(), []);
  assert.deepEqual(f.provider.keys(issue(1).url), ['empty-body']);
  assert.match(f.provider.comments[0]!.body, /description/);
});

test('contradicting labels get one comment per set of conflicts, and the defaults apply', async () => {
  const f = setup();
  const conflicted = issue(1, { labels: ['factory', 'factory:project:p1', 'factory:supervised', 'factory:autonomous'] });
  f.provider.issues = [conflicted];
  await f.sync.sync();
  await f.sync.sync();
  assert.equal(f.tasks.get('t1').autonomyMode, 'autonomous');
  // Noted once the task exists, scoped by its id.
  assert.equal(f.provider.keys(conflicted.url)[0], 't1:task-id');
  const conflictComments = f.provider.comments.filter((c) => c.key.startsWith('t1:config-conflict:'));
  assert.equal(conflictComments.length, 1);
  assert.match(conflictComments[0]!.body, /defaults apply/);
  assert.match(conflictComments[0]!.body, /factory:autonomous and factory:supervised are both set/);
  f.provider.issues = [{ ...conflicted, labels: [...conflicted.labels, 'factory:model:opus', 'factory:model:sonnet'] }];
  await f.sync.sync();
  assert.equal(f.provider.comments.filter((c) => c.key.startsWith('t1:config-conflict:')).length, 2);
});

test('an issue with conflicting project labels never becomes a task, so it is skipped without a comment', async () => {
  const f = setup();
  f.provider.issues = [issue(1, { labels: ['factory', 'factory:project:p1', 'factory:project:p2'] })];
  await f.sync.sync();
  assert.deepEqual(f.tasks.list(), []);
  assert.deepEqual(f.provider.comments, []);
  assert.equal(f.logged.length, 1);
});

test('syncs title, body, labels and config into a draft as system, saving nothing when nothing changed', async () => {
  const f = setup();
  const id = await imported(f, issue(1));
  const { updatedAt } = f.tasks.get(id);
  await f.sync.sync();
  assert.equal(f.tasks.get(id).updatedAt, updatedAt);
  assert.equal(f.events.filter((event) => event.type === 'task.updated').length, 0);

  f.provider.issues = [issue(1, { title: 'New', body: 'New body', labels: ['factory', 'factory:project:p1', 'factory:model:sonnet', 'ui'] })];
  await f.sync.sync();
  const task = f.tasks.get(id);
  assert.deepEqual([task.title, task.specification, task.labels, task.model, task.status], ['New', 'New body', ['ui'], 'sonnet', 'draft']);
  const updates = f.tasks.changes(id).filter((change) => change.field !== 'created');
  assert.deepEqual(updates.map((change) => [change.field, change.actor, 'userId' in change]), [
    ['title', 'system', false],
    ['specification', 'system', false],
    ['labels', 'system', false],
  ]);
});

test('a label order change is a change; a changed project label is ignored', async () => {
  const f = setup();
  const id = await imported(f, issue(1, { labels: ['factory', 'factory:project:p1', 'a', 'b'] }));
  f.provider.issues = [issue(1, { labels: ['factory', 'factory:project:other', 'b', 'a'] })];
  await f.sync.sync();
  const task = f.tasks.get(id);
  assert.deepEqual(task.labels, ['b', 'a']);
  assert.equal(task.projectId, 'p1');
  assert.deepEqual(f.logged, []);
});

test('a changed title or body takes a task waiting for clarification back to draft in the same change', async () => {
  const f = setup();
  const id = await imported(f, issue(1));
  f.tasks.update(id, 'reviewer', (task) => requestClarification(task, 'What?'));
  f.provider.issues = [issue(1, { body: 'Clearer body' })];
  await f.sync.sync();
  const task = f.tasks.get(id);
  assert.equal(task.status, 'draft');
  assert.equal(task.clarification, undefined);
  const last = f.events.at(-1);
  assert.ok(last?.type === 'task.updated');
  assert.equal(last.actor, 'system');
  assert.deepEqual(last.changes.map((change) => change.field), ['specification', 'status']);
});

test('a label-only change leaves a task waiting for clarification', async () => {
  const f = setup();
  const id = await imported(f, issue(1));
  f.tasks.update(id, 'reviewer', (task) => requestClarification(task, 'What?'));
  f.provider.issues = [issue(1, { labels: ['factory', 'factory:project:p1', 'ui'] })];
  await f.sync.sync();
  const task = f.tasks.get(id);
  assert.equal(task.status, 'clarification_required');
  assert.deepEqual(task.labels, ['ui']);
});

test('an emptied body is not synced and gets one comment', async () => {
  const f = setup();
  const id = await imported(f, issue(1));
  f.provider.issues = [issue(1, { title: 'New', body: '' })];
  await f.sync.sync();
  await f.sync.sync();
  const task = f.tasks.get(id);
  assert.deepEqual([task.title, task.specification], ['Issue 1', 'Body 1']);
  assert.deepEqual(f.provider.keys(issue(1).url), ['t1:task-id', 'empty-body']);
});

test('a started task is not touched, and a closed issue of a task is still linked', async () => {
  const f = setup();
  const id = await imported(f, issue(1));
  f.tasks.update(id, 'system', startTask);
  const before = f.tasks.get(id);
  f.provider.issues = [issue(1, { title: 'New', body: 'New body', isOpen: false })];
  await f.sync.sync();
  assert.deepEqual(f.tasks.get(id), before);
  assert.equal(f.tasks.list().length, 1);
});

test('the task-id comment is retried on a later pass when the first attempt failed', async () => {
  const f = setup();
  f.provider.issues = [issue(1)];
  f.provider.failures.set(issue(1).url, 'boom');
  await f.sync.sync();
  assert.equal(f.tasks.list().length, 1);
  f.provider.failures.clear();
  await f.sync.sync();
  assert.deepEqual(f.provider.keys(issue(1).url), ['t1:task-id']);
});

test('one failing issue does not stop the others, and its error is logged redacted', async () => {
  const f = setup();
  f.provider.issues = [issue(1), issue(2)];
  f.provider.failures.set(issue(1).url, 'bad credentials ghp_secret');
  await f.sync.sync();
  assert.deepEqual(f.tasks.list().map((t) => t.external?.url), [issue(1).url, issue(2).url]);
  assert.deepEqual(f.provider.keys(issue(2).url), ['t2:task-id']);
  assert.deepEqual(f.logged, [`issue sync: ${issue(1).url}: bad credentials [redacted]`]);
});

const startable = (n: number, fields: Partial<ExternalIssue> = {}) =>
  issue(n, { labels: ['factory', 'factory:project:p1', 'Factory:Start'], ...fields });

test('factory:start applies the pending content update first, starts the task as system and removes the label', async () => {
  const f = setup();
  const id = await imported(f, issue(1));
  f.provider.issues = [startable(1, { body: 'Final body' })];
  await f.sync.sync();
  const task = f.tasks.get(id);
  assert.deepEqual([task.status, task.specification], ['queued', 'Final body']);
  const updates = f.events.filter((event) => event.type === 'task.updated');
  assert.deepEqual(
    updates.map((event) => [event.actor, event.changes.map((change) => change.field)]),
    [['system', ['specification']], ['system', ['status']]],
  );
  assert.deepEqual(f.provider.commandChanges(), [{ url: issue(1).url, add: [], remove: ['Factory:Start'] }]);
  assert.deepEqual(f.logged, []);
});

test('factory:start settles a clarification request as an engineer start does', async () => {
  const f = setup();
  const id = await imported(f, issue(1));
  f.tasks.update(id, 'reviewer', (task) => requestClarification(task, 'What?'));
  f.provider.issues = [startable(1)];
  await f.sync.sync();
  const task = f.tasks.get(id);
  assert.equal(task.status, 'queued');
  assert.equal(task.clarification, undefined);
});

test('a failed label removal is retried on the next pass, which only removes the label', async () => {
  const f = setup();
  const id = await imported(f, issue(1));
  f.provider.issues = [startable(1)];
  f.provider.labelFailure = 'bad gateway ghp_secret';
  await f.sync.sync();
  assert.equal(f.tasks.get(id).status, 'queued');
  // The start label's removal and the status report fail alike.
  const failure = `issue sync: ${issue(1).url}: bad gateway [redacted]`;
  assert.deepEqual(f.logged, [failure, failure]);
  const before = f.tasks.get(id);
  f.provider.labelFailure = undefined;
  await f.sync.sync();
  assert.deepEqual(f.tasks.get(id), before);
  assert.deepEqual(f.provider.commandChanges(), [{ url: issue(1).url, add: [], remove: ['Factory:Start'] }]);
  assert.equal(f.logged.length, 2);
});

test('factory:start on a started task only removes the label', async () => {
  const f = setup();
  const id = await imported(f, issue(1));
  f.tasks.update(id, 'system', startTask);
  f.tasks.update(id, 'system', (task) => ({ ...task, status: 'in_progress' }));
  const before = f.tasks.get(id);
  f.provider.issues = [startable(1, { body: 'Late body' })];
  await f.sync.sync();
  assert.deepEqual(f.tasks.get(id), before);
  assert.deepEqual(f.provider.commandChanges(), [{ url: issue(1).url, add: [], remove: ['Factory:Start'] }]);
});

test('factory:start waits while the issue has no description', async () => {
  const f = setup();
  const id = await imported(f, issue(1));
  f.provider.issues = [startable(1, { body: '' })];
  await f.sync.sync();
  assert.equal(f.tasks.get(id).status, 'draft');
  assert.deepEqual(f.provider.commandChanges(), []);
});

test('an unstarted task is deleted once its issue loses the factory label', async () => {
  const f = setup();
  await imported(f, issue(1));
  const id = await imported(f, issue(2));
  f.tasks.update(id, 'reviewer', (task) => requestClarification(task, 'What?'));
  f.provider.issues = [];
  await f.sync.sync();
  assert.deepEqual(f.tasks.list(), []);
  assert.deepEqual(f.logged, []);
});

test('an unstarted task is deleted once its issue is closed, even with factory:start', async () => {
  const f = setup();
  const id = await imported(f, issue(1));
  f.provider.issues = [startable(1, { isOpen: false })];
  await f.sync.sync();
  assert.equal(f.tasks.findByExternalUrl(issue(1).url), undefined);
  assert.throws(() => f.tasks.get(id));
  assert.deepEqual(f.provider.commandChanges(), []);
});

test('nothing is deleted when the list call failed or does not cover the repository of the issue', async () => {
  const f = setup();
  const id = await imported(f, issue(1));
  f.provider.issues = [];
  f.provider.listFailure = 'timeout';
  await assert.rejects(f.sync.sync(), /timeout/);
  assert.equal(f.tasks.get(id).status, 'draft');
  f.provider.listFailure = undefined;
  f.provider.repoUrls = ['https://github.com/o/other'];
  await f.sync.sync();
  assert.equal(f.tasks.get(id).status, 'draft');
});

test('a task an unstarted task depends on is kept, logged and deleted on a later pass', async () => {
  const f = setup();
  const id = await imported(f, issue(1));
  f.tasks.insert(
    createTask({ projectId: 'p1', title: 'Other', specification: 'S', dependsOn: [id] }, { id: 'x1', now: f.tasks.now(), rank: 5 }),
    'system',
  );
  f.provider.issues = [issue(1, { isOpen: false })];
  await f.sync.sync();
  assert.equal(f.tasks.get(id).status, 'draft');
  assert.equal(f.logged.length, 1);
  assert.match(f.logged[0]!, /cannot be deleted: x1 depend on it/);
  f.provider.issues = [];
  await f.sync.sync();
  assert.equal(f.tasks.get(id).status, 'draft');
  assert.equal(f.logged.length, 2);
  f.tasks.update('x1', 'system', startTask);
  f.tasks.update('x1', 'system', (task) => ({ ...task, status: 'in_progress' }));
  await f.sync.sync();
  assert.equal(f.tasks.findByExternalUrl(issue(1).url), undefined);
});

test('after start, a closed issue or a removed factory label has no effect', async () => {
  const f = setup();
  const id = await imported(f, issue(1));
  f.provider.issues = [startable(1)];
  await f.sync.sync();
  const before = f.tasks.get(id);
  assert.equal(before.status, 'queued');
  f.provider.issues = [issue(1, { isOpen: false })];
  await f.sync.sync();
  f.provider.issues = [];
  await f.sync.sync();
  assert.deepEqual(f.tasks.get(id), before);
});

test('the status label is written only when it differs from the issue', async () => {
  const f = setup();
  await imported(f, issue(1));
  assert.deepEqual(f.provider.labelChanges, [{ url: issue(1).url, add: ['factory:status:draft'], remove: [] }]);
  await f.sync.sync();
  await f.sync.sync();
  assert.equal(f.provider.labelChanges.length, 1);
  assert.deepEqual(f.provider.statusLabels(issue(1).url), ['factory:status:draft']);
});

test('a task started by label reports its new status in the same pass', async () => {
  const f = setup();
  await imported(f, issue(1));
  f.provider.issues = [startable(1, { labels: ['factory', 'factory:project:p1', 'factory:start', 'factory:status:draft'] })];
  await f.sync.sync();
  assert.deepEqual(f.provider.labelChanges.slice(1), [
    { url: issue(1).url, add: [], remove: ['factory:start'] },
    { url: issue(1).url, add: ['factory:status:queued'], remove: ['factory:status:draft'] },
  ]);
});

test('a status label a human set or removed is corrected on the next pass', async () => {
  const f = setup();
  await imported(f, issue(1));
  const [listed] = f.provider.issues;
  listed!.labels = ['factory', 'factory:project:p1', 'Factory:Status:Done', 'factory:status:bogus'];
  await f.sync.sync();
  assert.deepEqual(f.provider.labelChanges.at(-1), {
    url: issue(1).url,
    add: ['factory:status:draft'],
    remove: ['Factory:Status:Done', 'factory:status:bogus'],
  });
  listed!.labels = ['factory', 'factory:project:p1'];
  await f.sync.sync();
  assert.deepEqual(f.provider.statusLabels(issue(1).url), ['factory:status:draft']);
});

for (const status of Object.keys(transitions) as TaskStatus[]) {
  test(`a ${status} task is reported as ${statusLabel(status)}`, async () => {
    const f = setup();
    const id = await imported(f, issue(1));
    f.tasks.update(id, 'system', (task) => ({ ...task, status }));
    await f.sync.sync();
    assert.deepEqual(f.provider.statusLabels(issue(1).url), [statusLabel(status)]);
    assert.deepEqual(f.logged, []);
  });
}

test('a started task whose issue left the list is no longer reported', async () => {
  const f = setup();
  const id = await imported(f, issue(1));
  f.tasks.update(id, 'system', startTask);
  f.provider.issues = [issue(1, { isOpen: false })];
  await f.sync.sync();
  assert.deepEqual(f.provider.statusLabels(issue(1).url), ['factory:status:queued']);
  const changes = f.provider.labelChanges.length;
  f.provider.issues = [];
  f.tasks.update(id, 'system', (task) => ({ ...task, status: 'in_progress' }));
  await f.sync.sync();
  assert.equal(f.provider.labelChanges.length, changes);
  assert.deepEqual(f.logged, []);
});

const lateEdits = (f: Fixture, url: string) => f.provider.comments.filter((c) => c.url === url && c.key.endsWith(':late-edit'));

test('edits after start get one late-edit comment across passes and edits, and change nothing', async () => {
  const f = setup();
  const id = await imported(f, issue(1));
  f.tasks.update(id, 'system', startTask);
  const before = f.tasks.get(id);
  const edits: Partial<ExternalIssue>[] = [
    { title: 'New title' },
    { body: 'New body' },
    { labels: ['factory', 'factory:project:p1', 'ui'] },
    { labels: ['factory', 'factory:project:p1', 'factory:supervised'] },
    { labels: ['factory', 'factory:project:p1', 'factory:model:sonnet'] },
  ];
  for (const edit of edits) {
    f.provider.issues = [issue(1, edit)];
    await f.sync.sync();
    await f.sync.sync();
  }
  const comments = lateEdits(f, issue(1).url);
  assert.equal(comments.length, 1);
  assert.equal(comments[0]!.key, `${id}:late-edit`);
  assert.match(comments[0]!.body, /already started/);
  assert.match(comments[0]!.body, /not incorporated/);
  assert.match(comments[0]!.body, /new issue/);
  assert.deepEqual(f.tasks.get(id), before);
});

test('each edited config option is a late edit on its own', async () => {
  for (const labels of [['factory', 'factory:project:p1', 'ui'], ['factory', 'factory:project:p1', 'factory:supervised'], ['factory', 'factory:project:p1', 'factory:model:sonnet']]) {
    const f = setup();
    const id = await imported(f, issue(1));
    f.tasks.update(id, 'system', startTask);
    f.provider.issues = [issue(1, { labels })];
    await f.sync.sync();
    assert.equal(lateEdits(f, issue(1).url).length, 1, labels.join(','));
  }
});

test('an unchanged issue gets no late-edit comment, whatever factory labels it carries', async () => {
  const f = setup();
  const id = await imported(f, issue(1, { labels: ['factory', 'factory:project:p1', 'ui', 'factory:model:sonnet'] }));
  f.provider.issues = [startable(1, { labels: ['factory', 'factory:project:p1', 'factory:start', 'ui', 'factory:model:sonnet'] })];
  await f.sync.sync();
  assert.equal(f.tasks.get(id).status, 'queued');
  // Same content, with factory labels in another case and order, a closed issue and a project label changed.
  f.provider.issues = [
    issue(1, { isOpen: false, labels: ['Factory:Model:Sonnet', 'FACTORY', 'factory:project:other', 'ui', 'ui', 'factory:status:done', 'factory:start'] }),
  ];
  for (let pass = 0; pass < 3; pass++) await f.sync.sync();
  assert.deepEqual(lateEdits(f, issue(1).url), []);
});

test('edits before start get no late-edit comment', async () => {
  const f = setup();
  const id = await imported(f, issue(1));
  f.provider.issues = [issue(1, { title: 'Edited in draft' })];
  await f.sync.sync();
  f.tasks.update(id, 'reviewer', (task) => requestClarification(task, 'What?'));
  f.provider.issues = [issue(1, { title: 'Edited in draft', labels: ['factory', 'factory:project:p1', 'ui'] })];
  await f.sync.sync();
  assert.deepEqual(lateEdits(f, issue(1).url), []);
  assert.deepEqual(f.tasks.get(id).labels, ['ui']);
});

test('a provider error on one issue changes neither its task nor the other issues, and is retried', async () => {
  const f = setup();
  f.provider.issues = [issue(1), issue(2)];
  await f.sync.sync();
  for (const task of f.tasks.list()) f.tasks.update(task.id, 'system', startTask);
  const before = f.tasks.get('t1');
  f.provider.issues = [issue(1, { body: 'Late 1' }), issue(2, { body: 'Late 2' })];
  f.provider.failures.set(issue(1).url, 'comment failed ghp_secret');
  f.provider.labelFailures.set(issue(1).url, 'labels failed ghp_secret');
  await f.sync.sync();
  assert.deepEqual(f.tasks.get('t1'), before);
  assert.deepEqual(f.provider.statusLabels(issue(1).url), []);
  assert.deepEqual(f.provider.statusLabels(issue(2).url), ['factory:status:queued']);
  assert.equal(lateEdits(f, issue(2).url).length, 1);
  assert.deepEqual(f.logged, [
    `issue sync: ${issue(1).url}: comment failed [redacted]`,
    `issue sync: ${issue(1).url}: labels failed [redacted]`,
  ]);
  f.provider.failures.clear();
  f.provider.labelFailures.clear();
  await f.sync.sync();
  assert.deepEqual(f.provider.statusLabels(issue(1).url), ['factory:status:queued']);
  assert.equal(lateEdits(f, issue(1).url).length, 1);
  assert.deepEqual(f.tasks.get('t1'), before);
});

/** Puts the task of a listed issue in a state, as the agent API or the dispatcher would. */
const put = (f: Fixture, id: string, fields: Partial<Task>) => f.tasks.update(id, 'system', (task) => ({ ...task, ...fields }));

/** Comment keys on issue 1 beyond the task-id comment. */
const reports = (f: Fixture) => f.provider.keys(issue(1).url).filter((key) => !key.endsWith(':task-id'));

const twice = async (f: Fixture) => {
  await f.sync.sync();
  await f.sync.sync();
};

const reported = {
  questions: [{ id: 'q1', createdAt: 'x', problem: 'Which?', type: 'radio' as const, options: ['a', 'b'] }],
  decisions: [{ id: 'd1', createdAt: 'x', problem: 'P', options: [], reasoning: 'R', approval: { status: 'pending' as const } }],
  artifacts: [{ id: 'a1', createdAt: 'x', title: 'Plan', kind: 'markdown', content: 'secret content' }],
};

test('every kind of report is posted once across passes, as the task moves on', async () => {
  const f = setup();
  const id = await imported(f, issue(1));
  f.tasks.update(id, 'reviewer', (task) => requestClarification(task, 'What?'));
  await twice(f);
  assert.deepEqual(reports(f), [`${id}:clarification:${sha16('What?')}`]);
  f.tasks.update(id, 'system', startTask);
  put(f, id, { status: 'input_required', ...reported });
  await twice(f);
  put(f, id, { status: 'ready', pullRequests: [{ url: 'https://github.com/o/r/pull/7', title: 'Fix', status: 'open' }] });
  await twice(f);
  put(f, id, { status: 'failed', failureReason: 'boom', failedAt: '2026-11-19T12:00:00.000Z' });
  await twice(f);
  assert.deepEqual(reports(f), [
    `${id}:clarification:${sha16('What?')}`,
    `${id}:q1`,
    `${id}:d1`,
    `${id}:d1:approval`,
    `${id}:a1`,
    `${id}:https://github.com/o/r/pull/7`,
    `${id}:failed:2026-11-19T12:00:00.000Z`,
  ]);
  assert.equal(f.provider.comments.some((c) => c.body.includes('secret content') || c.body.includes('boom')), false);
  assert.deepEqual(f.logged, []);
});

test('a new clarification note is posted again', async () => {
  const f = setup();
  const id = await imported(f, issue(1));
  f.tasks.update(id, 'reviewer', (task) => requestClarification(task, 'What?'));
  await f.sync.sync();
  put(f, id, { clarification: 'Which?' });
  await twice(f);
  assert.deepEqual(reports(f), [`${id}:clarification:${sha16('What?')}`, `${id}:clarification:${sha16('Which?')}`]);
});

test("a restart's new items and new failure are posted", async () => {
  const f = setup();
  const id = await imported(f, issue(1));
  f.tasks.update(id, 'system', startTask);
  put(f, id, { status: 'failed', ...reported, failureReason: 'boom', failedAt: '2026-11-19T12:00:00.000Z' });
  await f.sync.sync();
  f.tasks.update(id, 'system', restartTask);
  put(f, id, {
    status: 'failed',
    questions: [{ ...reported.questions[0]!, id: 'q2' }],
    decisions: [{ ...reported.decisions[0]!, id: 'd2' }],
    artifacts: [{ ...reported.artifacts[0]!, id: 'a2' }],
    failureReason: 'boom',
    failedAt: '2026-11-19T13:00:00.000Z',
  });
  await twice(f);
  const second = [`${id}:q2`, `${id}:d2`, `${id}:d2:approval`, `${id}:a2`, `${id}:failed:2026-11-19T13:00:00.000Z`];
  assert.deepEqual(reports(f).slice(-second.length), second);
  assert.equal(reports(f).length, 10);
});

test('a failed comment changes nothing on the task, is logged redacted and posted on the next pass', async () => {
  const f = setup();
  const id = await imported(f, issue(1));
  f.tasks.update(id, 'system', startTask);
  const before = put(f, id, { status: 'input_required', ...reported });
  f.provider.failures.set(issue(1).url, 'comment failed ghp_secret');
  await f.sync.sync();
  assert.deepEqual(f.tasks.get(id), before);
  assert.deepEqual(reports(f), []);
  assert.deepEqual(f.provider.statusLabels(issue(1).url), ['factory:status:input-required']);
  // The task-id comment, ensured by the issue's own sync, fails alike.
  const failure = `issue sync: ${issue(1).url}: comment failed [redacted]`;
  assert.deepEqual(f.logged, [failure, failure]);
  f.provider.failures.clear();
  await f.sync.sync();
  assert.deepEqual(reports(f), [`${id}:q1`, `${id}:d1`, `${id}:d1:approval`, `${id}:a1`]);
  assert.deepEqual(f.tasks.get(id), before);
});

test('an issue imported again after its task was deleted gets comments of its own task', async () => {
  const f = setup();
  await imported(f, issue(1));
  f.provider.issues = [];
  await f.sync.sync();
  assert.deepEqual(f.tasks.list(), []);
  const id = await imported(f, issue(1));
  assert.equal(id, 't2');
  assert.deepEqual(f.provider.keys(issue(1).url), ['t1:task-id', 't2:task-id']);
  assert.match(f.provider.comments.at(-1)!.body, /task `t2`/);
});

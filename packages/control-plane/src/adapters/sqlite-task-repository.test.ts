import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTask, markInProgress, restartTask, startTask, type Task } from '@factory/core';
import { SqliteTaskRepository } from './sqlite-task-repository.ts';

const draft = (id: string, now = '2026-11-12T10:00:00.000Z', rank = 0): Task =>
  createTask({ projectId: 'p1', title: id, specification: 'spec', repoUrl: 'https://github.com/o/r' }, { id, now, rank });

const repository = () => new SqliteTaskRepository(':memory:');

test('inserts and gets a task unchanged', () => {
  const repo = repository();
  const task = { ...draft('a'), baseBranch: 'main', labels: ['x'] };
  repo.insert(task);
  assert.deepEqual(repo.get('a'), task);
  assert.equal(repo.get('missing'), undefined);
});

test('rejects inserting the same id twice', () => {
  const repo = repository();
  repo.insert(draft('a'));
  assert.throws(() => repo.insert(draft('a')));
});

test('deletes a task and its token hash, and ignores unknown ids', () => {
  const repo = repository();
  repo.insert(markInProgress(startTask(draft('a')), { tokenHash: 'h', executionId: 'c' }, '2026-01-01T00:00:00.000Z'));
  repo.insert(draft('b'));
  repo.delete('a');
  repo.delete('missing');
  assert.equal(repo.get('a'), undefined);
  assert.equal(repo.findByTokenHash('h'), undefined);
  assert.deepEqual(repo.list().map((t) => t.id), ['b']);
});

test('lists in rank order, optionally filtered by status', () => {
  const repo = repository();
  repo.insert(draft('b', '2026-11-12T10:00:00.000Z', 1));
  repo.insert(startTask(draft('a', '2026-11-12T11:00:00.000Z', 0)));
  repo.insert(draft('c', '2026-11-12T09:00:00.000Z', 2));
  assert.deepEqual(repo.list().map((t) => t.id), ['a', 'b', 'c']);
  assert.deepEqual(repo.list(['queued']).map((t) => t.id), ['a']);
  assert.deepEqual(repo.list(['draft', 'queued']).map((t) => t.id), ['a', 'b', 'c']);
  assert.deepEqual(repo.list([]), []);
});

test('ranks tasks stored before ranks existed below the ranked ones, oldest first', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'tasks.db');
  const repo = new SqliteTaskRepository(path);
  repo.insert(draft('ranked', '2026-11-12T12:00:00.000Z', 4));
  const legacy = (id: string, createdAt: string) => {
    const { rank: _dropped, ...task } = draft(id, createdAt);
    return task;
  };
  repo.insert(legacy('new', '2026-11-12T11:00:00.000Z') as Task);
  repo.insert(legacy('old', '2026-11-12T10:00:00.000Z') as Task);
  repo.close();
  const reopened = new SqliteTaskRepository(path);
  assert.deepEqual(reopened.list().map((task) => `${task.id}=${task.rank}`), ['ranked=4', 'old=5', 'new=6']);
  reopened.close();
});

test('reads execution fields stored on the task before executions had their own record', () => {
  const repo = repository();
  const worker = { state: 'idle' as const, since: '2026-11-12T11:00:00.000Z' };
  const flat = (id: string, fields: object) => ({ ...draft(id), status: 'in_progress', ...fields }) as unknown as Task;
  repo.insert(
    flat('full', {
      tokenHash: 'h1',
      executionId: 'c1',
      worker,
      workAcceptedAt: '2026-11-12T10:30:00.000Z',
      agentConsoleUrl: 'http://127.0.0.1:1',
      agentConsolePassword: 'pw',
    }),
  );
  repo.insert(flat('unstated', { tokenHash: 'h2', executionId: 'c2' }));
  repo.insert(flat('detached', { tokenHash: 'h3' }));
  assert.deepEqual(repo.get('full')!.execution, {
    id: 'c1',
    tokenHash: 'h1',
    worker,
    workAcceptedAt: '2026-11-12T10:30:00.000Z',
    console: { url: 'http://127.0.0.1:1', password: 'pw' },
  });
  assert.deepEqual(repo.get('unstated')!.execution, {
    id: 'c2',
    tokenHash: 'h2',
    worker: { state: 'working', since: '2026-11-12T10:00:00.000Z' },
  });
  assert.equal(repo.get('detached')!.execution, undefined);
  for (const key of ['tokenHash', 'executionId', 'worker', 'workAcceptedAt', 'agentConsoleUrl', 'agentConsolePassword']) {
    assert.equal(key in repo.get('full')!, false, key);
  }
});

test('reads tasks stored before models existed as opus', () => {
  const repo = repository();
  const { model: _dropped, ...legacy } = { ...draft('old'), model: 'sonnet' as const };
  repo.insert(legacy as Task);
  repo.insert({ ...draft('new'), model: 'sonnet' });
  assert.equal(repo.get('old')?.model, 'opus');
  assert.equal(repo.get('new')?.model, 'sonnet');
  assert.deepEqual(repo.list().map((task) => `${task.id}=${task.model}`), ['new=sonnet', 'old=opus']);
});

test('reads tasks stored before agents were chosen per task as claude', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'tasks.db');
  const repo = new SqliteTaskRepository(path);
  const { agent: _dropped, ...legacy } = draft('old');
  repo.insert(legacy as Task);
  repo.insert({ ...draft('new'), agent: 'opencode' });
  repo.close();
  const reopened = new SqliteTaskRepository(path);
  assert.equal(reopened.get('old')?.agent, 'claude');
  assert.equal(reopened.get('new')?.agent, 'opencode');
  assert.deepEqual(reopened.list().map((task) => `${task.id}=${task.agent}`), ['new=opencode', 'old=claude']);
  reopened.close();
});

test('reads tasks stored before follow-ups existed with none', () => {
  const repo = repository();
  const { followUps: _dropped, ...legacy } = draft('old');
  repo.insert(legacy as Task);
  const followUps = [{ id: 'f1', createdAt: '2026-11-12T10:00:00.000Z', message: 'm' }];
  repo.insert({ ...draft('new'), followUps });
  assert.deepEqual(repo.get('old')?.followUps, []);
  assert.deepEqual(repo.get('new')?.followUps, followUps);
});

test('reads tasks stored before dependencies existed with none', () => {
  const repo = repository();
  const { dependsOn: _dropped, ...legacy } = draft('old');
  repo.insert(legacy as Task);
  repo.insert({ ...draft('new'), dependsOn: ['old'] });
  assert.deepEqual(repo.get('old')?.dependsOn, []);
  assert.deepEqual(repo.get('new')?.dependsOn, ['old']);
});

test('reads pull requests stored before statuses existed as merged on done tasks, open otherwise', () => {
  const repo = repository();
  const legacy = { url: 'https://github.com/o/r/pull/1', title: 'pr' };
  repo.insert({ ...draft('running'), status: 'ready', pullRequests: [legacy] } as unknown as Task);
  repo.insert({ ...draft('done'), status: 'done', pullRequests: [legacy] } as unknown as Task);
  const closed = { ...legacy, status: 'closed' as const };
  repo.insert({ ...draft('new'), status: 'done', pullRequests: [closed] });
  assert.deepEqual(repo.get('running')?.pullRequests, [{ ...legacy, status: 'open' }]);
  assert.deepEqual(repo.get('done')?.pullRequests, [{ ...legacy, status: 'merged' }]);
  assert.deepEqual(repo.get('new')?.pullRequests, [closed]);
});

test('reads decisions stored with the chosen text as an index, adding unlisted text as the last option', () => {
  const repo = repository();
  const base = { createdAt: '2026-11-12T10:00:00.000Z', problem: 'p', options: ['a', 'b'], reasoning: 'r' };
  const decisions = [
    { ...base, id: 'd1', chosen: 'b' },
    { ...base, id: 'd2', chosen: 'a, but tweaked' },
    { ...base, id: 'd3', chosen: 0 },
    { ...base, id: 'd4', options: [] },
  ];
  repo.insert({ ...draft('old'), decisions } as unknown as Task);
  assert.deepEqual(repo.get('old')?.decisions, [
    { ...base, id: 'd1', chosen: 1 },
    { ...base, id: 'd2', options: ['a', 'b', 'a, but tweaked'], chosen: 2 },
    { ...base, id: 'd3', chosen: 0 },
    { ...base, id: 'd4', options: [] },
  ]);
});

test('saves changes including status and execution columns', () => {
  const repo = repository();
  repo.insert(startTask(draft('a')));
  const running = markInProgress(repo.get('a')!, { tokenHash: 'h1', executionId: 'c1' }, '2026-01-01T00:00:00.000Z');
  repo.save(running);
  assert.deepEqual(repo.get('a'), running);
  assert.deepEqual(repo.list(['in_progress']).map((t) => t.id), ['a']);
  assert.deepEqual(repo.list(['queued']), []);
});

test('round-trips session metrics and their absence', () => {
  const repo = repository();
  const measured = { ...draft('a'), metrics: { durationMs: 723_000, costUsd: 1.2345 } };
  repo.insert(measured);
  repo.insert(draft('b'));
  assert.deepEqual(repo.get('a'), measured);
  assert.equal('metrics' in repo.get('b')!, false);
  repo.save({ ...measured, metrics: { durationMs: 724_000, costUsd: 1.5 } });
  assert.deepEqual(repo.get('a')?.metrics, { durationMs: 724_000, costUsd: 1.5 });
});

test('finds a task by token hash', () => {
  const repo = repository();
  repo.insert(startTask(draft('a')));
  repo.save(markInProgress(repo.get('a')!, { tokenHash: 'h1', executionId: 'c1' }, '2026-01-01T00:00:00.000Z'));
  assert.equal(repo.findByTokenHash('h1')?.id, 'a');
  assert.equal(repo.findByTokenHash('h2'), undefined);
});

const running = (id: string): Task =>
  markInProgress(startTask(draft(id)), { tokenHash: `h-${id}`, executionId: `c-${id}` }, '2026-01-01T00:00:00.000Z');

test('saves a heartbeat without rewriting the task, and reads it with every query', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'tasks.db');
  const repo = new SqliteTaskRepository(path);
  repo.insert(running('a'));
  const heartbeat = { at: '2026-11-13T10:00:00.000Z', phase: 'working' as const, activity: 'Running Bash: yarn test' };
  repo.saveHeartbeat('a', heartbeat);
  repo.saveHeartbeat('a', { at: '2026-11-13T10:00:15.000Z', phase: 'awaiting_work' });
  const latest = { at: '2026-11-13T10:00:15.000Z', phase: 'awaiting_work' };
  const stored = running('a');
  assert.deepEqual(repo.get('a'), { ...stored, execution: { ...stored.execution!, lastHeartbeat: latest } });
  assert.deepEqual(repo.list(['in_progress'])[0]?.execution?.lastHeartbeat, latest);
  assert.deepEqual(repo.findByTokenHash('h-a')?.execution?.lastHeartbeat, latest);
  repo.close();
  const raw = new DatabaseSync(path);
  const { data } = raw.prepare("SELECT data FROM tasks WHERE id = 'a'").get() as { data: string };
  raw.close();
  assert.equal('lastHeartbeat' in JSON.parse(data).execution, false);
});

test('a saved task without a heartbeat clears it, and deleting the task removes it', () => {
  const repo = repository();
  repo.insert(running('a'));
  repo.saveHeartbeat('a', { at: '2026-11-13T10:00:00.000Z', phase: 'working' });
  repo.save(restartTask(repo.get('a')!));
  assert.equal('lastHeartbeat' in repo.get('a')!, false);
  repo.save(running('a'));
  repo.saveHeartbeat('a', { at: '2026-11-13T10:00:00.000Z', phase: 'working' });
  repo.delete('a');
  repo.insert(running('a'));
  assert.equal('lastHeartbeat' in repo.get('a')!, false);
});

test('drops heartbeats stored in the task data before they had their own table', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'tasks.db');
  new SqliteTaskRepository(path).insert(running('a'));
  const raw = new DatabaseSync(path);
  raw.prepare(`UPDATE tasks SET data = json_set(data, '$.lastHeartbeat', json('{"at":"x","phase":"working"}'))`).run();
  raw.close();
  assert.equal('lastHeartbeat' in new SqliteTaskRepository(path).get('a')!, false);
});

test('refuses to save a task that was never inserted', () => {
  assert.throws(() => repository().save(draft('a')), /does not exist/);
});

test('appends changes with the task, lists them oldest first, and deletes them with it', () => {
  const repo = repository();
  const at = '2026-11-13T10:00:00.000Z';
  repo.insert(draft('a'), [{ at, actor: 'user', userId: 'u1', field: 'created' }]);
  repo.insert(draft('b'), [{ at, actor: 'user', userId: 'u1', field: 'created' }]);
  repo.save({ ...startTask(draft('a')), labels: ['x'] }, [
    { at, actor: 'user', userId: 'u2', field: 'labels', from: [], to: ['x'] },
    { at, actor: 'agent', field: 'status', from: 'draft', to: 'queued' },
  ]);
  assert.deepEqual(repo.listChanges('a'), [
    { at, actor: 'user', userId: 'u1', field: 'created' },
    { at, actor: 'user', userId: 'u2', field: 'labels', from: [], to: ['x'] },
    { at, actor: 'agent', field: 'status', from: 'draft', to: 'queued' },
  ]);
  repo.delete('a');
  assert.deepEqual(repo.listChanges('a'), []);
  assert.equal(repo.listChanges('b').length, 1);
});

test('appends no changes when saving an unknown task', () => {
  const repo = repository();
  const change = { at: '2026-11-13T10:00:00.000Z', actor: 'user', field: 'created' } as const;
  assert.throws(() => repo.save(draft('ghost'), [change]));
  assert.deepEqual(repo.listChanges('ghost'), []);
});

test('adds the user column to a changelog created before changes recorded their user; old rows read without one', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'tasks.db');
  const at = '2026-11-13T10:00:00.000Z';
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE task_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL,
    field TEXT NOT NULL, from_value TEXT, to_value TEXT
  )`);
  old.prepare("INSERT INTO task_changes (task_id, at, actor, field) VALUES ('a', ?, 'user', 'created')").run(at);
  old.close();

  const repo = new SqliteTaskRepository(path);
  repo.insert(draft('a'));
  repo.save(startTask(draft('a')), [{ at, actor: 'user', userId: 'u1', field: 'status', from: 'draft', to: 'queued' }]);
  assert.deepEqual(repo.listChanges('a'), [
    { at, actor: 'user', field: 'created' },
    { at, actor: 'user', userId: 'u1', field: 'status', from: 'draft', to: 'queued' },
  ]);
  repo.close();
  // Opening the migrated database again leaves it as it is.
  assert.equal(new SqliteTaskRepository(path).listChanges('a').length, 2);
});

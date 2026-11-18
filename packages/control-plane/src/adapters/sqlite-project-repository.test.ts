import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, type Project } from '@factory/core';
import { SqliteProjectRepository } from './sqlite-project-repository.ts';

const project = (id: string, now: string): Project => createProject({ title: id, description: 'd' }, { id, now });

test('inserts, gets, lists oldest first and saves projects', () => {
  const repo = new SqliteProjectRepository(':memory:');
  repo.insert(project('b', '2026-11-12T11:00:00.000Z'));
  repo.insert(project('a', '2026-11-12T10:00:00.000Z'));
  assert.deepEqual(repo.get('a'), project('a', '2026-11-12T10:00:00.000Z'));
  assert.equal(repo.get('missing'), undefined);
  assert.deepEqual(repo.list().map((p) => p.id), ['a', 'b']);
  repo.save({ ...repo.get('a')!, title: 'renamed' });
  assert.equal(repo.get('a')!.title, 'renamed');
});

test('rejects duplicate ids and saving an unknown project', () => {
  const repo = new SqliteProjectRepository(':memory:');
  repo.insert(project('a', '2026-11-12T10:00:00.000Z'));
  assert.throws(() => repo.insert(project('a', '2026-11-12T10:00:00.000Z')));
  assert.throws(() => repo.save(project('missing', '2026-11-12T10:00:00.000Z')), /does not exist/);
});

test('appends changes with the project and lists them oldest first, with the user id only for users', () => {
  const repo = new SqliteProjectRepository(':memory:');
  const at = '2026-11-13T10:00:00.000Z';
  repo.insert(project('a', at), [{ at, actor: 'user', userId: 'u1', field: 'created' }]);
  repo.insert(project('b', at));
  repo.save({ ...project('a', at), title: 'renamed', autoMerge: true }, [
    { at, actor: 'user', userId: 'u2', field: 'title', from: 'a', to: 'renamed' },
    { at, actor: 'system', field: 'autoMerge', from: false, to: true },
  ]);
  assert.deepEqual(repo.listChanges('a'), [
    { at, actor: 'user', userId: 'u1', field: 'created' },
    { at, actor: 'user', userId: 'u2', field: 'title', from: 'a', to: 'renamed' },
    { at, actor: 'system', field: 'autoMerge', from: false, to: true },
  ]);
  assert.deepEqual(repo.listChanges('b'), []);
  assert.throws(() => repo.save(project('ghost', at), [{ at, actor: 'user', userId: 'u1', field: 'title', from: 'x', to: 'y' }]));
  assert.deepEqual(repo.listChanges('ghost'), []);
});

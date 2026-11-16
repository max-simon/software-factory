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

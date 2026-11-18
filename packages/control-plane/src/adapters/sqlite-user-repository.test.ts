import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUser, DomainError, disableUser, localProvider, renameUser, type User } from '@factory/core';
import { SqliteUserRepository } from './sqlite-user-repository.ts';

const user = (id: string, username: string, now: string): User => createUser({ username }, { id, now });
const isDuplicateUsername = (error: unknown) => error instanceof DomainError && error.code === 'duplicate_username';

test('inserts, gets, lists oldest first and updates users', () => {
  const repo = new SqliteUserRepository(':memory:');
  repo.insert(user('u2', 'bob', '2026-11-12T11:00:00.000Z'));
  repo.insert(user('u1', 'ada', '2026-11-12T10:00:00.000Z'));
  assert.deepEqual(repo.get('u1'), user('u1', 'ada', '2026-11-12T10:00:00.000Z'));
  assert.equal(repo.get('missing'), undefined);
  assert.equal(repo.getByUsername('  ADA ')?.id, 'u1');
  assert.equal(repo.getByUsername('nobody'), undefined);
  assert.deepEqual(repo.list().map((u) => u.id), ['u1', 'u2']);

  const renamed = { ...renameUser(repo.get('u1')!, 'Ada Lovelace'), updatedAt: '2026-11-13T10:00:00.000Z' };
  repo.update(renamed);
  assert.deepEqual(repo.get('u1'), renamed);
  const disabled = disableUser(renamed, '2026-11-14T10:00:00.000Z');
  repo.update(disabled);
  assert.equal(repo.get('u1')!.disabledAt, '2026-11-14T10:00:00.000Z');
  assert.equal(repo.list().length, 2);
});

test('rejects taken usernames on insert and update, and updating an unknown user', () => {
  const repo = new SqliteUserRepository(':memory:');
  repo.insert(user('u1', 'ada', '2026-11-12T10:00:00.000Z'));
  repo.insert(user('u2', 'bob', '2026-11-12T10:00:00.000Z'));
  assert.throws(() => repo.insert(user('u3', 'ada', '2026-11-12T10:00:00.000Z')), isDuplicateUsername);
  assert.throws(() => repo.update({ ...repo.get('u2')!, username: 'ada' }), isDuplicateUsername);
  assert.throws(() => repo.insert(user('u1', 'carol', '2026-11-12T10:00:00.000Z')), (e) => !isDuplicateUsername(e));
  assert.throws(() => repo.update(user('missing', 'dave', '2026-11-12T10:00:00.000Z')), /does not exist/);
});

test('links identities and keeps the local password hash', () => {
  const repo = new SqliteUserRepository(':memory:');
  repo.insert(user('u1', 'ada', '2026-11-12T10:00:00.000Z'));
  repo.insert(user('u2', 'bob', '2026-11-12T10:00:00.000Z'));
  repo.linkIdentity({ provider: 'github', subject: '42', userId: 'u1' });
  assert.deepEqual(repo.findIdentity('github', '42'), { provider: 'github', subject: '42', userId: 'u1' });
  assert.equal(repo.findIdentity('github', '43'), undefined);
  assert.throws(() => repo.linkIdentity({ provider: 'github', subject: '42', userId: 'u2' }));
  assert.throws(() => repo.linkIdentity({ provider: 'github', subject: '7', userId: 'missing' }));

  repo.linkIdentity({ provider: localProvider, subject: 'u1', userId: 'u1' });
  assert.equal(repo.getPasswordHash('u1'), undefined);
  repo.setPasswordHash('u1', 'hash-1');
  repo.setPasswordHash('u1', 'hash-2');
  assert.equal(repo.getPasswordHash('u1'), 'hash-2');
  // Setting a password links the local identity when it is missing.
  repo.setPasswordHash('u2', 'hash-3');
  assert.deepEqual(repo.findIdentity(localProvider, 'u2'), { provider: localProvider, subject: 'u2', userId: 'u2' });
  assert.equal(repo.getPasswordHash('u2'), 'hash-3');
  assert.equal(repo.getPasswordHash('missing'), undefined);
  assert.throws(() => repo.setPasswordHash('missing', 'hash'));
});

test('keeps users in a database file across connections', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-users-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'factory.db');
  const first = new SqliteUserRepository(path);
  first.insert(user('u1', 'ada', '2026-11-12T10:00:00.000Z'));
  first.setPasswordHash('u1', 'hash');
  first.close();
  const second = new SqliteUserRepository(path);
  assert.equal(second.getByUsername('ada')?.id, 'u1');
  assert.equal(second.getPasswordHash('u1'), 'hash');
  second.close();
});

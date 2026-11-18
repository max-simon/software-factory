import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, type PasswordHasher } from '@factory/core';
import { SqliteAccessTokenRepository } from './adapters/sqlite-access-token-repository.ts';
import { SqliteSessionRepository } from './adapters/sqlite-session-repository.ts';
import { SqliteUserRepository } from './adapters/sqlite-user-repository.ts';
import { ScryptPasswordHasher } from './auth/passwords.ts';
import { hashSessionToken } from './auth/session-service.ts';
import { UserAccountService } from './user-account-service.ts';

const password = 'correct horse battery';
const at = '2026-11-12T10:00:00.000Z';

function setup() {
  const scrypt = new ScryptPasswordHasher({ N: 2 ** 10 });
  let verifications = 0;
  const hasher: PasswordHasher = {
    hash: (text) => scrypt.hash(text),
    verify: (text, hash) => {
      verifications += 1;
      return scrypt.verify(text, hash);
    },
  };
  const users = new SqliteUserRepository(':memory:');
  const sessions = new SqliteSessionRepository(':memory:');
  const tokens = new SqliteAccessTokenRepository(':memory:');
  let ids = 0;
  const accounts = new UserAccountService({ users, passwords: users, hasher, sessions, tokens, now: () => at, newId: () => `u${++ids}` });
  const addSession = (token: string, userId: string) =>
    sessions.insert({ idHash: hashSessionToken(token), userId, createdAt: at, lastSeenAt: at, expiresAt: '2026-12-01T00:00:00.000Z' });
  const addToken = (id: string, userId: string) => tokens.insert({ id, userId, name: id, createdAt: at }, `hash-${id}`);
  return { accounts, users, sessions, tokens, hasher, addSession, addToken, verifications: () => verifications };
}

test('changePassword rejects a new password it cannot set before checking the current one', async () => {
  const { accounts, verifications } = setup();
  const user = await accounts.create({ username: 'ada' }, password);
  await assert.rejects(
    accounts.changePassword(user.id, password, 'short', 'session'),
    (error) => error instanceof DomainError && error.code === 'invalid_password',
  );
  assert.equal(verifications(), 0);
  assert.equal(await accounts.changePassword(user.id, 'not the password', 'a brand new password', 'session'), false);
});

test('changePassword keeps the given session and ends the user’s other sessions and tokens only', async () => {
  const { accounts, sessions, tokens, addSession, addToken } = setup();
  const ada = await accounts.create({ username: 'ada' }, password);
  const bob = await accounts.create({ username: 'bob' }, password);
  addSession('mine', ada.id);
  addSession('other', ada.id);
  addSession('bobs', bob.id);
  addToken('t1', ada.id);
  addToken('t2', bob.id);
  assert.equal(await accounts.changePassword(ada.id, password, 'a brand new password', 'mine'), true);
  assert.notEqual(sessions.get(hashSessionToken('mine')), undefined);
  assert.equal(sessions.get(hashSessionToken('other')), undefined);
  assert.notEqual(sessions.get(hashSessionToken('bobs')), undefined);
  assert.deepEqual(tokens.listForUser(ada.id), []);
  assert.equal(tokens.listForUser(bob.id).length, 1);
});

test('disable says whether the user was active and ends its sessions and tokens either way', async () => {
  const { accounts, users, sessions, tokens, addSession, addToken } = setup();
  const ada = await accounts.create({ username: 'ada' }, password);
  assert.equal(accounts.disable(ada.id), true);
  assert.equal(users.get(ada.id)!.disabledAt, at);
  addSession('late', ada.id);
  addToken('t1', ada.id);
  assert.equal(accounts.disable(ada.id), false);
  assert.equal(sessions.get(hashSessionToken('late')), undefined);
  assert.deepEqual(tokens.listForUser(ada.id), []);
  assert.throws(() => accounts.disable('nobody'), (error) => error instanceof DomainError && error.code === 'unknown_user');
});

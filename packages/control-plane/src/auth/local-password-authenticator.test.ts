import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUser, disableUser, localProvider, type PasswordHasher } from '@factory/core';
import { SqliteUserRepository } from '../adapters/sqlite-user-repository.ts';
import { LocalPasswordAuthenticator } from './local-password-authenticator.ts';
import { ScryptPasswordHasher } from './passwords.ts';

const now = '2026-11-12T10:00:00.000Z';
const password = 'correct horse battery';

class CountingHasher implements PasswordHasher {
  readonly #inner = new ScryptPasswordHasher({ N: 2 ** 10 });
  verified = 0;
  hash(value: string): Promise<string> {
    return this.#inner.hash(value);
  }
  verify(value: string, hash: string): Promise<boolean> {
    this.verified += 1;
    return this.#inner.verify(value, hash);
  }
}

async function setup() {
  const users = new SqliteUserRepository(':memory:');
  const hasher = new CountingHasher();
  for (const [id, username] of [['u1', 'ada'], ['u2', 'bob'], ['u3', 'carol']] as const) {
    users.insert(createUser({ username }, { id, now }));
  }
  users.linkIdentity({ provider: localProvider, subject: 'u1', userId: 'u1' });
  users.setPasswordHash('u1', await hasher.hash(password));
  users.setPasswordHash('u2', await hasher.hash(password));
  users.update(disableUser(users.get('u2')!, now));
  // carol has no local password, as if she signed in through an IdP only.
  const authenticator = new LocalPasswordAuthenticator({ users, passwords: users, hasher });
  return { authenticator, hasher };
}

test('resolves the user id for the right password, case-insensitive username', async () => {
  const { authenticator } = await setup();
  assert.equal(await authenticator.authenticate({ kind: 'password', username: 'ada', password }), 'u1');
  assert.equal(await authenticator.authenticate({ kind: 'password', username: ' ADA ', password }), 'u1');
});

test('rejects a wrong password', async () => {
  const { authenticator, hasher } = await setup();
  assert.equal(await authenticator.authenticate({ kind: 'password', username: 'ada', password: 'wrong password!' }), undefined);
  assert.equal(hasher.verified, 1);
});

test('rejects disabled, unknown and passwordless users after hashing anyway', async () => {
  const { authenticator, hasher } = await setup();
  for (const username of ['bob', 'nobody', 'carol']) {
    const before = hasher.verified;
    assert.equal(await authenticator.authenticate({ kind: 'password', username, password }), undefined, username);
    assert.equal(hasher.verified, before + 1, username);
  }
});

test('rejects overlong passwords without hashing', async () => {
  const { authenticator, hasher } = await setup();
  const result = await authenticator.authenticate({ kind: 'password', username: 'ada', password: 'x'.repeat(257) });
  assert.equal(result, undefined);
  assert.equal(hasher.verified, 0);
});

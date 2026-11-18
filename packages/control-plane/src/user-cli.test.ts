import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, localProvider, type DomainErrorCode } from '@factory/core';
import { SqliteSessionRepository } from './adapters/sqlite-session-repository.ts';
import { SqliteUserRepository } from './adapters/sqlite-user-repository.ts';
import { ScryptPasswordHasher } from './auth/passwords.ts';
import { hashSessionToken, SessionService } from './auth/session-service.ts';
import { runUserCli, UsageError } from './user-cli.ts';

const hasher = new ScryptPasswordHasher({ N: 2 ** 10 });
const rejectsWith = (code: DomainErrorCode) => (error: unknown) => error instanceof DomainError && error.code === code;

function setup() {
  const users = new SqliteUserRepository(':memory:');
  const sessionStore = new SqliteSessionRepository(':memory:');
  const passwords: string[] = [];
  let output = '';
  let ids = 0;
  let clock = 0;
  const run = (...argv: string[]) =>
    runUserCli(argv, {
      users,
      passwords: users,
      sessions: sessionStore,
      hasher,
      readPassword: async () => {
        const next = passwords.shift();
        if (next === undefined) throw new Error('no password queued');
        return next;
      },
      stdout: { write: (text: string) => (output += text) },
      now: () => new Date(Date.UTC(2026, 10, 12, 10, clock++)).toISOString(),
      newId: () => `id${++ids}`,
    });
  return { users, sessionStore, passwords, run, output: () => output };
}

test('add creates a user with a local password', async () => {
  const { users, passwords, run, output } = setup();
  passwords.push('first password');
  await run('add', 'Ada', '--display-name', 'Ada Lovelace');
  const user = users.getByUsername('ada')!;
  assert.equal(user.id, 'id1');
  assert.equal(user.displayName, 'Ada Lovelace');
  assert.deepEqual(users.findIdentity(localProvider, 'id1'), { provider: localProvider, subject: 'id1', userId: 'id1' });
  assert.equal(await hasher.verify('first password', users.getPasswordHash('id1')!), true);
  assert.match(output(), /created user ada/);
});

test('add rejects taken usernames and short passwords without creating a user', async () => {
  const { users, passwords, run } = setup();
  passwords.push('first password');
  await run('add', 'ada');
  await assert.rejects(run('add', 'ADA'), rejectsWith('duplicate_username'));
  passwords.push('too short');
  await assert.rejects(run('add', 'bob'), rejectsWith('invalid_password'));
  assert.equal(users.getByUsername('bob'), undefined);
  assert.equal(users.list().length, 1);
});

test('passwd replaces the password', async () => {
  const { users, passwords, run } = setup();
  passwords.push('first password', 'second password');
  await run('add', 'ada');
  await run('passwd', 'ada');
  const hash = users.getPasswordHash('id1')!;
  assert.equal(await hasher.verify('second password', hash), true);
  assert.equal(await hasher.verify('first password', hash), false);
  await assert.rejects(run('passwd', 'nobody'), rejectsWith('unknown_user'));
});

test('rename and disable change the user; a disabled user cannot be changed', async () => {
  const { users, passwords, run, output } = setup();
  passwords.push('first password');
  await run('add', 'ada');
  await run('rename', 'ada', 'Ada', 'Lovelace');
  assert.equal(users.get('id1')!.displayName, 'Ada Lovelace');
  await run('disable', 'ada');
  const disabled = users.get('id1')!;
  assert.equal(disabled.disabledAt, disabled.updatedAt);
  await run('disable', 'ada');
  assert.match(output(), /already disabled/);
  passwords.push('second password');
  await assert.rejects(run('passwd', 'ada'), rejectsWith('user_disabled'));
  await assert.rejects(run('rename', 'ada', 'Someone'), rejectsWith('user_disabled'));
  await assert.rejects(run('disable', 'nobody'), rejectsWith('unknown_user'));
});

test('list prints a table of users', async () => {
  const { passwords, run, output } = setup();
  await run('list');
  assert.equal(output(), 'no users\n');
  passwords.push('first password', 'second password');
  await run('add', 'ada', '--display-name', 'Ada Lovelace');
  await run('add', 'bob');
  await run('disable', 'bob');
  const before = output().length;
  await run('list');
  const lines = output().slice(before).trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^USERNAME\s+DISPLAY NAME\s+STATUS\s+CREATED$/);
  assert.match(lines[1]!, /^ada\s+Ada Lovelace\s+active\s+2026-11-12T10:00:00.000Z$/);
  assert.match(lines[2]!, /^bob\s+bob\s+disabled\s+2026-11-12T10:01:00.000Z$/);
});

test('rejects unknown commands and wrong arguments with usage', async () => {
  const { run } = setup();
  const isUsage = (error: unknown) => error instanceof UsageError && /Usage: yarn user/.test(error.message);
  await assert.rejects(run(), isUsage);
  await assert.rejects(run('frobnicate'), isUsage);
  await assert.rejects(run('add'), isUsage);
  await assert.rejects(run('rename', 'ada'), isUsage);
  await assert.rejects(run('list', '--display-name', 'x'), isUsage);
  await assert.rejects(run('add', 'ada', '--password', 'secret'), isUsage);
});

test('disable ends the sessions of the user and leaves those of others', async () => {
  const { users, sessionStore, passwords, run } = setup();
  passwords.push('first password', 'other password');
  await run('add', 'ada');
  await run('add', 'bob');
  const sessions = new SessionService({ sessions: sessionStore, users, idleTimeoutMs: 3_600_000, maxLifetimeMs: 86_400_000 });
  const ada = [sessions.createSession('id1').token, sessions.createSession('id1').token];
  const bob = sessions.createSession('id2').token;
  await run('disable', 'ada');
  for (const token of ada) assert.equal(sessionStore.get(hashSessionToken(token)), undefined);
  assert.deepEqual(sessions.resolve(bob), { userId: 'id2', via: 'session' });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, localProvider, type DomainErrorCode } from '@factory/core';
import { SqliteAccessTokenRepository } from './adapters/sqlite-access-token-repository.ts';
import { SqliteSessionRepository } from './adapters/sqlite-session-repository.ts';
import { SqliteUserRepository } from './adapters/sqlite-user-repository.ts';
import { AccessTokenService, hashAccessToken } from './auth/access-token-service.ts';
import { ScryptPasswordHasher } from './auth/passwords.ts';
import { hashSessionToken, SessionService } from './auth/session-service.ts';
import { UserAccountService } from './user-account-service.ts';
import { runUserCli, UsageError } from './user-cli.ts';

const hasher = new ScryptPasswordHasher({ N: 2 ** 10 });
const rejectsWith = (code: DomainErrorCode) => (error: unknown) => error instanceof DomainError && error.code === code;

function setup() {
  const users = new SqliteUserRepository(':memory:');
  const sessionStore = new SqliteSessionRepository(':memory:');
  const tokenStore = new SqliteAccessTokenRepository(':memory:');
  const passwords: string[] = [];
  let output = '';
  let ids = 0;
  let clock = 0;
  const now = () => new Date(Date.UTC(2026, 10, 12, 10, clock++)).toISOString();
  const newId = () => `id${++ids}`;
  const run = (...argv: string[]) =>
    runUserCli(argv, {
      users,
      accounts: new UserAccountService({ users, passwords: users, hasher, sessions: sessionStore, tokens: tokenStore, now, newId }),
      accessTokens: new AccessTokenService({ tokens: tokenStore, users, now: () => Date.parse(now()), newId }),
      readPassword: async () => {
        const next = passwords.shift();
        if (next === undefined) throw new Error('no password queued');
        return next;
      },
      stdout: { write: (text: string) => (output += text) },
    });
  return { users, sessionStore, tokenStore, passwords, run, output: () => output };
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

test('token prints a new personal access token once and stores only its hash', async () => {
  const { users, tokenStore, passwords, run, output } = setup();
  passwords.push('first password');
  await run('add', 'ada');
  const before = output().length;
  await run('token', 'ADA', 'my', 'laptop');
  const printed = output().slice(before);
  assert.match(printed, /^fct_[\w-]{43}\n$/);
  const token = printed.trimEnd();
  const stored = tokenStore.getByHash(hashAccessToken(token))!;
  assert.deepEqual(stored, { id: 'id2', userId: 'id1', name: 'my laptop', createdAt: '2026-11-12T10:01:00.000Z' });
  const tokens = new AccessTokenService({ tokens: tokenStore, users });
  assert.deepEqual(tokens.resolve(token), { userId: 'id1', via: 'token' });
});

test('token takes an optional expiry in whole days', async () => {
  const { tokenStore, passwords, run } = setup();
  passwords.push('first password');
  await run('add', 'ada');
  await run('token', 'ada', 'ci', '--expires-in-days', '30');
  assert.equal(tokenStore.listForUser('id1')[0]!.expiresAt, '2026-12-12T10:01:00.000Z');
  for (const days of ['0', '1.5', '7d', '3651']) {
    await assert.rejects(run('token', 'ada', 'ci', '--expires-in-days', days), rejectsWith('invalid_token_expiry'), days);
  }
  await assert.rejects(run('token', 'ada', ' '), rejectsWith('invalid_token_name'));
  assert.equal(tokenStore.listForUser('id1').length, 1);
});

test('token refuses unknown and disabled users and wrong arguments', async () => {
  const { passwords, run } = setup();
  passwords.push('first password');
  await run('add', 'ada');
  await run('disable', 'ada');
  await assert.rejects(run('token', 'ada', 'laptop'), rejectsWith('user_disabled'));
  await assert.rejects(run('token', 'nobody', 'laptop'), rejectsWith('unknown_user'));
  const isUsage = (error: unknown) => error instanceof UsageError && /token <username> <name\.\.\.>/.test(error.message);
  await assert.rejects(run('token', 'ada'), isUsage);
  await assert.rejects(run('list', '--expires-in-days', '3'), isUsage);
});

test('disable revokes the tokens of the user and leaves those of others', async () => {
  const { users, tokenStore, passwords, run } = setup();
  passwords.push('first password', 'other password');
  await run('add', 'ada');
  await run('add', 'bob');
  const tokens = new AccessTokenService({ tokens: tokenStore, users });
  tokens.issue('id1', { name: 'laptop' });
  const bob = tokens.issue('id2', { name: 'laptop' }).token;
  await run('disable', 'ada');
  assert.deepEqual(tokenStore.listForUser('id1'), []);
  assert.deepEqual(tokens.resolve(bob), { userId: 'id2', via: 'token' });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DomainError, type DomainErrorCode } from './errors.ts';
import {
  assertActiveUser,
  assertUsernameAvailable,
  changeUsername,
  createUser,
  disableUser,
  isActiveUser,
  normalizeUsername,
  parseUsername,
  renameUser,
  type User,
} from './user.ts';

const now = '2026-01-01T00:00:00Z';
const later = '2026-02-01T00:00:00Z';

const user = (overrides: Partial<User> = {}): User => ({
  ...createUser({ username: 'ada', displayName: 'Ada Lovelace' }, { id: 'u1', now }),
  ...overrides,
});

const throwsCode = (fn: () => unknown, code: DomainErrorCode) =>
  assert.throws(fn, (error: unknown) => error instanceof DomainError && error.code === code);

describe('parseUsername', () => {
  it('normalises to trimmed lowercase', () => {
    assert.equal(normalizeUsername('  Ada.L '), 'ada.l');
    assert.equal(parseUsername('  Ada.L_x-1 '), 'ada.l_x-1');
  });

  it('accepts 3 to 32 characters', () => {
    assert.equal(parseUsername('abc'), 'abc');
    assert.equal(parseUsername('a'.repeat(32)), 'a'.repeat(32));
    throwsCode(() => parseUsername('ab'), 'invalid_username');
    throwsCode(() => parseUsername('a'.repeat(33)), 'invalid_username');
    throwsCode(() => parseUsername('   '), 'invalid_username');
  });

  it('rejects characters outside [a-z0-9._-]', () => {
    for (const name of ['ada lovelace', 'ada@example', 'adä', 'ada/x', 'ada+1']) {
      throwsCode(() => parseUsername(name), 'invalid_username');
    }
  });
});

describe('createUser', () => {
  it('builds an active user with the given id and timestamps', () => {
    assert.deepEqual(createUser({ username: 'Ada', displayName: ' Ada Lovelace ' }, { id: 'u1', now }), {
      id: 'u1',
      username: 'ada',
      displayName: 'Ada Lovelace',
      createdAt: now,
      updatedAt: now,
    });
  });

  it('defaults the display name to the username', () => {
    assert.equal(createUser({ username: 'Ada' }, { id: 'u1', now }).displayName, 'ada');
  });

  it('validates username and display name', () => {
    throwsCode(() => createUser({ username: 'a!' }, { id: 'u1', now }), 'invalid_username');
    throwsCode(() => createUser({ username: 'ada', displayName: '  ' }, { id: 'u1', now }), 'invalid_display_name');
    throwsCode(() => createUser({ username: 'ada', displayName: 'x'.repeat(101) }, { id: 'u1', now }), 'invalid_display_name');
  });
});

describe('renameUser', () => {
  it('changes only the display name', () => {
    const renamed = renameUser(user(), '  Countess  ');
    assert.deepEqual(renamed, { ...user(), displayName: 'Countess' });
  });

  it('rejects an empty display name', () => {
    throwsCode(() => renameUser(user(), ''), 'invalid_display_name');
  });

  it('rejects a disabled user', () => {
    throwsCode(() => renameUser(user({ disabledAt: later }), 'Countess'), 'user_disabled');
  });
});

describe('changeUsername', () => {
  it('changes the username and keeps the id', () => {
    const changed = changeUsername(user(), 'Lovelace');
    assert.equal(changed.username, 'lovelace');
    assert.equal(changed.id, 'u1');
    assert.equal(changed.displayName, 'Ada Lovelace');
  });

  it('validates the new username', () => {
    throwsCode(() => changeUsername(user(), 'no spaces'), 'invalid_username');
  });

  it('rejects a disabled user', () => {
    throwsCode(() => changeUsername(user({ disabledAt: later }), 'lovelace'), 'user_disabled');
  });
});

describe('disableUser', () => {
  it('sets disabledAt', () => {
    const disabled = disableUser(user(), later);
    assert.equal(disabled.disabledAt, later);
    assert.equal(isActiveUser(disabled), false);
    assert.equal(isActiveUser(user()), true);
  });

  it('keeps the first disabledAt when disabled again', () => {
    const disabled = disableUser(user(), later);
    assert.equal(disableUser(disabled, '2026-03-01T00:00:00Z'), disabled);
  });
});

describe('assertUsernameAvailable', () => {
  it('passes when nobody or the user itself holds the username', () => {
    assertUsernameAvailable('ada', undefined);
    assertUsernameAvailable('ada', user(), 'u1');
  });

  it('throws duplicate_username when another user holds it', () => {
    throwsCode(() => assertUsernameAvailable('ada', user()), 'duplicate_username');
    throwsCode(() => assertUsernameAvailable('ada', user(), 'u2'), 'duplicate_username');
  });
});

describe('assertActiveUser', () => {
  it('returns an active user', () => {
    assert.deepEqual(assertActiveUser(user(), 'u1'), user());
  });

  it('throws unknown_user and user_disabled', () => {
    throwsCode(() => assertActiveUser(undefined, 'u9'), 'unknown_user');
    throwsCode(() => assertActiveUser(user({ disabledAt: later }), 'u1'), 'user_disabled');
  });
});

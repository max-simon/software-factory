import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAccessTokenExpiry, parseAccessTokenName } from './access-token.ts';
import { DomainError, type DomainErrorCode } from './errors.ts';

const rejectsWith = (code: DomainErrorCode) => (error: unknown) => error instanceof DomainError && error.code === code;

test('a token name is trimmed and 1 to 100 characters long', () => {
  assert.equal(parseAccessTokenName('  laptop  '), 'laptop');
  assert.equal(parseAccessTokenName('x'.repeat(100)), 'x'.repeat(100));
  assert.throws(() => parseAccessTokenName('   '), rejectsWith('invalid_token_name'));
  assert.throws(() => parseAccessTokenName('x'.repeat(101)), rejectsWith('invalid_token_name'));
});

test('a token expiry is a whole number of days from 1 to 3650', () => {
  assert.equal(parseAccessTokenExpiry(1), 1);
  assert.equal(parseAccessTokenExpiry(3650), 3650);
  for (const days of [0, -1, 1.5, 3651, '30', null, Number.NaN]) {
    assert.throws(() => parseAccessTokenExpiry(days), rejectsWith('invalid_token_expiry'), String(days));
  }
});

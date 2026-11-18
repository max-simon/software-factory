import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '@factory/core';
import { parsePassword, ScryptPasswordHasher } from './passwords.ts';

// Small N keeps the tests fast; the defaults are exercised once below.
const hasher = new ScryptPasswordHasher({ N: 2 ** 10 });

test('hashes and verifies passwords', async () => {
  const hash = await hasher.hash('correct horse battery');
  assert.match(hash, /^scrypt\$1024\$8\$1\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/);
  assert.equal(await hasher.verify('correct horse battery', hash), true);
  assert.equal(await hasher.verify('correct horse batterY', hash), false);
  assert.equal(await hasher.verify('', hash), false);
});

test('salts every hash', async () => {
  const [a, b] = await Promise.all([hasher.hash('same password!'), hasher.hash('same password!')]);
  assert.notEqual(a, b);
  assert.notEqual(a.split('$')[4], b.split('$')[4]);
  assert.equal(await hasher.verify('same password!', a), true);
  assert.equal(await hasher.verify('same password!', b), true);
});

test('verifies with the parameters encoded in the hash', async () => {
  const other = await new ScryptPasswordHasher({ N: 2 ** 11, r: 4, p: 2 }).hash('another password');
  assert.match(other, /^scrypt\$2048\$4\$2\$/);
  assert.equal(await hasher.verify('another password', other), true);
  const defaults = await new ScryptPasswordHasher().hash('default params');
  assert.match(defaults, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await hasher.verify('default params', defaults), true);
});

test('rejects malformed hashes without throwing', async () => {
  const [, n, r, p, salt, key] = (await hasher.hash('a fine password')).split('$');
  const malformed = [
    '',
    'not a hash',
    `bcrypt$${n}$${r}$${p}$${salt}$${key}`,
    `scrypt$${n}$${r}$${p}$${salt}`,
    `scrypt$${n}$${r}$${p}$${salt}$${key}$extra`,
    `scrypt$1000$${r}$${p}$${salt}$${key}`,
    `scrypt$0$${r}$${p}$${salt}$${key}`,
    `scrypt$${2 ** 30}$${r}$${p}$${salt}$${key}`,
    `scrypt$${n}$x$${p}$${salt}$${key}`,
    `scrypt$${n}$${r}$-1$${salt}$${key}`,
    `scrypt$${n}$${r}$${p}$$${key}`,
    `scrypt$${n}$${r}$${p}$${salt}$!!!`,
    `scrypt$${n}$${r}$${p}$${salt}$AAAA`,
  ];
  for (const hash of malformed) assert.equal(await hasher.verify('a fine password', hash), false, hash);
});

test('password policy allows 12 to 256 characters', () => {
  const isInvalid = (error: unknown) => error instanceof DomainError && error.code === 'invalid_password';
  assert.equal(parsePassword('x'.repeat(12)), 'x'.repeat(12));
  assert.equal(parsePassword('x'.repeat(256)), 'x'.repeat(256));
  assert.throws(() => parsePassword(''), isInvalid);
  assert.throws(() => parsePassword('x'.repeat(11)), isInvalid);
  assert.throws(() => parsePassword('x'.repeat(257)), isInvalid);
});

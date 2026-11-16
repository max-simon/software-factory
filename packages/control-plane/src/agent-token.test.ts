import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentToken, hashAgentToken } from './agent-token.ts';

test('createAgentToken returns 32 random bytes as hex with their SHA-256 hash', () => {
  const { token, tokenHash } = createAgentToken();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.match(tokenHash, /^[0-9a-f]{64}$/);
  assert.equal(tokenHash, hashAgentToken(token));
  assert.notEqual(tokenHash, token);
});

test('createAgentToken never repeats a token', () => {
  assert.notEqual(createAgentToken().token, createAgentToken().token);
});

test('hashAgentToken is hex SHA-256', () => {
  assert.equal(hashAgentToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

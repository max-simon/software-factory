import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLocalRequest } from './browser-guard.ts';

test('accepts loopback hosts with and without a loopback origin', () => {
  for (const host of ['127.0.0.1:4700', 'localhost:4700', 'LOCALHOST', '[::1]:4700']) {
    assert.equal(isLocalRequest({ host }), true, host);
  }
  assert.equal(isLocalRequest({ host: '127.0.0.1:4700', origin: 'http://localhost:4700' }), true);
});

test('rejects foreign hosts, foreign origins and a missing host', () => {
  assert.equal(isLocalRequest({ host: 'evil.example:4700' }), false);
  assert.equal(isLocalRequest({ host: 'localhost.evil.example' }), false);
  assert.equal(isLocalRequest({}), false);
  for (const origin of ['https://evil.example', 'http://evil.example:4700', 'null', 'https://localhost:4700']) {
    assert.equal(isLocalRequest({ host: '127.0.0.1:4700', origin }), false, origin);
  }
});

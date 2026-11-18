import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoginThrottle } from './login-throttle.ts';

function setup() {
  let clock = Date.parse('2026-11-12T10:00:00.000Z');
  const throttle = new LoginThrottle({ now: () => clock });
  return { throttle, advance: (ms: number) => (clock += ms) };
}

const keys = ['user:ada', 'client:127.0.0.1'];

test('locks after the fifth failure in a row, doubling the lockout up to 15 minutes', () => {
  const { throttle, advance } = setup();
  for (let i = 0; i < 4; i++) throttle.recordFailure(keys);
  assert.equal(throttle.retryAfterMs(keys), 0);
  throttle.recordFailure(keys);
  assert.equal(throttle.retryAfterMs(keys), 30_000);
  advance(10_000);
  assert.equal(throttle.retryAfterMs(keys), 20_000);
  advance(20_000);
  assert.equal(throttle.retryAfterMs(keys), 0);
  const lockouts = [];
  for (let i = 0; i < 7; i++) {
    throttle.recordFailure(keys);
    lockouts.push(throttle.retryAfterMs(keys));
    advance(throttle.retryAfterMs(keys));
  }
  assert.deepEqual(lockouts, [60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
});

test('a success resets the keys', () => {
  const { throttle } = setup();
  for (let i = 0; i < 5; i++) throttle.recordFailure(keys);
  throttle.recordSuccess(keys);
  assert.equal(throttle.retryAfterMs(keys), 0);
  throttle.recordFailure(keys);
  assert.equal(throttle.retryAfterMs(keys), 0);
});

test('a lock on any one key refuses the login, other keys stay free', () => {
  const { throttle } = setup();
  for (let i = 0; i < 5; i++) throttle.recordFailure([`user:u${i}`, 'client:a']);
  assert.equal(throttle.retryAfterMs(['user:ada', 'client:a']), 30_000);
  assert.equal(throttle.retryAfterMs(['user:u0', 'client:b']), 0);
  for (let i = 0; i < 5; i++) throttle.recordFailure(['user:bob', `client:c${i}`]);
  assert.equal(throttle.retryAfterMs(['user:bob', 'client:d']), 30_000);
  assert.equal(throttle.retryAfterMs(['user:ada', 'client:c0']), 0);
});

test('forgets failures after a day without one', () => {
  const { throttle, advance } = setup();
  for (let i = 0; i < 4; i++) throttle.recordFailure(keys);
  advance(24 * 3_600_000);
  throttle.recordFailure(keys);
  assert.equal(throttle.retryAfterMs(keys), 0);
});

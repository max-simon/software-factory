import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDoorbell, serveDoorbell } from './doorbell.ts';

test('a wait resolves at the next ring', async () => {
  const doorbell = createDoorbell();
  const waiting = doorbell.wait();
  doorbell.ring();
  assert.equal(await waiting, true);
});

test('a ring before the wait is kept until reset, so none is lost between request and wait', async () => {
  const doorbell = createDoorbell();
  doorbell.ring();
  assert.equal(await doorbell.wait(), true);
  doorbell.reset();
  let isSettled = false;
  void doorbell.wait().then(() => (isSettled = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(isSettled, false);
});

test('closing ends pending and later waits with false', async () => {
  const doorbell = createDoorbell();
  const waiting = doorbell.wait();
  doorbell.close();
  assert.equal(await waiting, false);
  assert.equal(await doorbell.wait(), false);
});

test('the served doorbell rings on POST /nudge only', async (t) => {
  const doorbell = await serveDoorbell(0);
  t.after(() => doorbell.close());
  const base = `http://127.0.0.1:${doorbell.port}`;

  assert.equal((await fetch(`${base}/nudge`)).status, 404);
  assert.equal((await fetch(`${base}/other`, { method: 'POST' })).status, 404);
  const waiting = doorbell.wait();
  assert.equal((await fetch(`${base}/nudge`, { method: 'POST' })).status, 204);
  assert.equal(await waiting, true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PauseWatch } from './pause-watch.ts';

function setup() {
  let now = 1_000_000;
  const logged: string[] = [];
  const watch = new PauseWatch({ now: () => now, pauseMs: 10_000, log: (message) => logged.push(message) });
  return { watch, logged, advance: (ms: number) => (now += ms), startedAt: now };
}

test('counts from its creation while checks come regularly', () => {
  const f = setup();
  for (let i = 0; i < 100; i++) {
    f.advance(1_000);
    assert.equal(f.watch.check(), f.startedAt);
  }
  assert.deepEqual(f.logged, []);
});

test('a gap longer than the pause threshold counts from its end', () => {
  const f = setup();
  f.advance(1_000);
  f.watch.check();
  const resumedAt = f.advance(3_600_000);
  assert.equal(f.watch.check(), resumedAt);
  f.advance(1_000);
  assert.equal(f.watch.check(), resumedAt);
  assert.match(f.logged[0]!, /paused for 3600 s/);
});

test('a gap of exactly the threshold is no pause', () => {
  const f = setup();
  f.advance(10_000);
  assert.equal(f.watch.check(), f.startedAt);
});

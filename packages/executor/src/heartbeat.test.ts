import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Heartbeat } from '@factory/core';
import { createHeartbeat, intervalSchedule, type HeartbeatDeps, type Schedule } from './heartbeat.ts';

type Sent = Omit<Heartbeat, 'at'>;

/** A schedule ticked by hand, so tests never wait for the interval. */
function manualSchedule() {
  const clock = { tick: undefined as (() => void) | undefined, intervalMs: 0, isCancelled: false };
  const schedule: Schedule = (tick, ms) => {
    clock.tick = tick;
    clock.intervalMs = ms;
    return () => {
      clock.isCancelled = true;
    };
  };
  return { clock, schedule };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(send?: HeartbeatDeps['send']) {
  const sent: Sent[] = [];
  const logs: string[] = [];
  const { clock, schedule } = manualSchedule();
  const heartbeat = createHeartbeat({
    send: send ?? (async (beat) => void sent.push(beat)),
    intervalMs: 15_000,
    log: (message) => logs.push(message),
    schedule,
  });
  return { heartbeat, sent, logs, clock };
}

test('sends on start, then on every tick with the latest activity', async () => {
  const { heartbeat, sent, clock } = setup();
  heartbeat.start('setting_up');
  assert.equal(clock.intervalMs, 15_000);
  await settle();
  heartbeat.setPhase('working');
  await settle();
  heartbeat.setActivity('Thinking');
  heartbeat.setActivity('Running Bash: yarn test');
  assert.equal(sent.length, 2, 'activity alone sends nothing');
  clock.tick!();
  await settle();
  assert.deepEqual(sent, [
    { phase: 'setting_up' },
    { phase: 'working' },
    { phase: 'working', activity: 'Running Bash: yarn test' },
  ]);
});

test('a new phase clears the activity; the same phase sends nothing', async () => {
  const { heartbeat, sent } = setup();
  heartbeat.start('working');
  await settle();
  heartbeat.setActivity('Thinking');
  heartbeat.setPhase('working');
  heartbeat.setPhase('setting_up');
  await settle();
  assert.deepEqual(sent, [{ phase: 'working' }, { phase: 'setting_up' }]);
});

test('nothing is sent before start or after stop, and a new start beats again', async () => {
  const { heartbeat, sent, clock } = setup();
  heartbeat.setPhase('working');
  heartbeat.start('setting_up');
  heartbeat.start('working');
  heartbeat.stop();
  assert.ok(clock.isCancelled);
  const stoppedTick = clock.tick!;
  stoppedTick();
  heartbeat.setPhase('working');
  await settle();
  assert.deepEqual(sent, [{ phase: 'setting_up' }]);

  heartbeat.start('working');
  await settle();
  assert.deepEqual(sent, [{ phase: 'setting_up' }, { phase: 'working' }]);
});

test('failures are logged and the next beat is sent anyway', async () => {
  let attempts = 0;
  const { heartbeat, logs, clock } = setup(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('connection refused');
  });
  heartbeat.start('working');
  await settle();
  clock.tick!();
  await settle();
  assert.equal(attempts, 2);
  assert.deepEqual(logs, ['heartbeat failed: connection refused']);
});

test('one request at a time: beats due meanwhile collapse into one with the latest state', async () => {
  const sent: Sent[] = [];
  let release = () => {};
  const { heartbeat, clock } = setup(async (beat) => {
    sent.push(beat);
    await new Promise<void>((resolve) => (release = resolve));
  });
  heartbeat.start('working');
  clock.tick!();
  heartbeat.setActivity('Thinking');
  clock.tick!();
  assert.equal(sent.length, 1);
  release();
  await settle();
  assert.deepEqual(sent, [{ phase: 'working' }, { phase: 'working', activity: 'Thinking' }]);
  release();
});

test('the real schedule ticks and does not keep the process alive', async () => {
  let ticks = 0;
  const cancel = intervalSchedule(() => (ticks += 1), 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  cancel();
  const after = ticks;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(after > 0);
  assert.equal(ticks, after);
});

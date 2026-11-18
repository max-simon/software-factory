import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createActivityReporter, type Defer } from './activity-reporter.ts';

/** A reporter whose timer fires by hand. */
function reporter(send: (entries: string[]) => Promise<void> = async () => {}) {
  const timers: Array<() => void> = [];
  const logs: string[] = [];
  const defer: Defer = (run) => {
    timers.push(run);
    return () => timers.splice(timers.indexOf(run), 1);
  };
  return { timers, logs, reporter: createActivityReporter({ send, delayMs: 2_000, log: (m) => logs.push(m), defer }) };
}

test('batches the lines added before the timer fires', async () => {
  const batches: string[][] = [];
  const { timers, reporter: r } = reporter(async (entries) => void batches.push(entries));
  r.add('Starting session');
  r.add('Running Bash: yarn test');
  assert.equal(timers.length, 1);
  timers[0]!();
  await r.flush();
  r.add('Thinking');
  await r.flush();
  assert.deepEqual(batches, [['Starting session', 'Running Bash: yarn test'], ['Thinking']]);
  assert.equal(timers.length, 0);
});

test('a flush with nothing waiting sends nothing', async () => {
  let sent = 0;
  const { reporter: r } = reporter(async () => void (sent += 1));
  await r.flush();
  assert.equal(sent, 0);
});

test('sends one batch at a time, in order', async () => {
  const batches: string[][] = [];
  let release: () => void = () => {};
  const { reporter: r } = reporter(async (entries) => {
    batches.push(entries);
    if (batches.length === 1) await new Promise<void>((resolve) => (release = resolve));
  });
  r.add('a');
  const first = r.flush();
  await new Promise(setImmediate);
  r.add('b');
  const second = r.flush();
  await new Promise(setImmediate);
  assert.deepEqual(batches, [['a']]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(batches, [['a'], ['b']]);
});

test('keeps the latest 200 lines of a batch', async () => {
  const batches: string[][] = [];
  const { reporter: r } = reporter(async (entries) => void batches.push(entries));
  for (let i = 0; i < 250; i++) r.add(`line ${i}`);
  await r.flush();
  assert.equal(batches[0]!.length, 200);
  assert.equal(batches[0]![0], 'line 50');
});

test('a failed report is logged and dropped', async () => {
  const { logs, reporter: r } = reporter(async () => {
    throw new Error('down');
  });
  r.add('a');
  await r.flush();
  assert.deepEqual(logs, ['activity report failed: down']);
});

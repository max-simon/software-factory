import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityFeed } from './activity-feed.ts';

const entry = (text: string) => ({ at: '2026-11-18T10:00:00.000Z', text });

test('keeps a task’s entries in order until its next turn starts', () => {
  const feed = new ActivityFeed();
  assert.deepEqual(feed.list('t1'), []);
  feed.append('t1', [entry('Starting session')]);
  feed.append('t1', [entry('Running Bash: yarn test'), entry('Thinking')]);
  feed.append('t2', [entry('Other task')]);
  assert.deepEqual(feed.list('t1').map((e) => e.text), ['Starting session', 'Running Bash: yarn test', 'Thinking']);
  feed.startTurn('t1');
  assert.deepEqual(feed.list('t1'), []);
  assert.deepEqual(feed.list('t2').map((e) => e.text), ['Other task']);
});

test('keeps the latest 300 entries of a task', () => {
  const feed = new ActivityFeed();
  feed.append('t1', Array.from({ length: 310 }, (_, i) => entry(`line ${i}`)));
  const kept = feed.list('t1');
  assert.equal(kept.length, 300);
  assert.equal(kept[0]!.text, 'line 10');
});

test('drops the least recently active task beyond 50', () => {
  const feed = new ActivityFeed();
  for (let i = 0; i < 50; i++) feed.append(`t${i}`, [entry('x')]);
  feed.append('t0', [entry('y')]);
  feed.append('t50', [entry('x')]);
  assert.deepEqual(feed.list('t1'), [], 't1 was the least recently active');
  assert.equal(feed.list('t0').length, 2);
  assert.equal(feed.list('t50').length, 1);
});

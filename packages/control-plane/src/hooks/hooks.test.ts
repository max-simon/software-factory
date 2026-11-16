import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task, TaskEvent } from '@factory/core';
import { Hooks } from './hooks.ts';

const event: TaskEvent = { type: 'task.created', task: { id: 't1' } as Task };

test('emit hands the event to every hook without running any inside the call', async () => {
  const seen: string[] = [];
  const hooks = new Hooks();
  hooks.register({ name: 'a', handle: async (e) => void seen.push(`a:${e.type}`) });
  hooks.register({ name: 'b', handle: async (e) => void seen.push(`b:${e.type}`) });

  const done = hooks.emit(event);
  assert.deepEqual(seen, []);
  await done;
  assert.deepEqual(seen, ['a:task.created', 'b:task.created']);
});

test('a failing hook is logged and does not stop the others', async () => {
  const logged: string[] = [];
  const seen: string[] = [];
  const hooks = new Hooks((message) => logged.push(message));
  hooks.register({
    name: 'throws',
    handle: () => {
      throw new Error('boom');
    },
  });
  hooks.register({ name: 'rejects', handle: async () => Promise.reject(new Error('bang')) });
  hooks.register({ name: 'works', handle: async () => void seen.push('works') });

  await hooks.emit(event);
  assert.deepEqual(seen, ['works']);
  assert.deepEqual(logged, ['hook throws failed on task.created of task t1: boom', 'hook rejects failed on task.created of task t1: bang']);
});

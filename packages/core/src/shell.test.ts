import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTask } from './operations.ts';
import { canOpenShell, parseShellControl, parseShellSize } from './shell.ts';
import { transitions } from './status.ts';
import type { Execution, TaskStatus } from './task.ts';

test('a shell size takes whole numbers, cols 1 to 500 and rows 1 to 200', () => {
  assert.deepEqual(parseShellSize(1, 1), { cols: 1, rows: 1 });
  assert.deepEqual(parseShellSize(500, 200), { cols: 500, rows: 200 });
  assert.deepEqual(parseShellSize(80, 24), { cols: 80, rows: 24 });
  const rejected: Array<[unknown, unknown]> = [
    [0, 24],
    [80, 0],
    [501, 24],
    [80, 201],
    [-1, 24],
    [1.5, 24],
    [80, 1.5],
    ['80', 24],
    [80, '24'],
    [Number.NaN, 24],
    [80, Number.NaN],
    [Number.POSITIVE_INFINITY, 24],
    [null, 24],
    [80, null],
    [undefined, 24],
  ];
  for (const [cols, rows] of rejected) {
    assert.equal(parseShellSize(cols, rows), undefined, `${String(cols)}x${String(rows)}`);
  }
});

test('a resize control message is parsed from its JSON frame', () => {
  assert.deepEqual(parseShellControl('{"type":"resize","cols":120,"rows":40}'), { type: 'resize', cols: 120, rows: 40 });
  assert.deepEqual(parseShellControl('{"type":"resize","cols":500,"rows":200}'), { type: 'resize', cols: 500, rows: 200 });
  assert.deepEqual(parseShellControl('{"type":"resize","cols":1,"rows":1}'), { type: 'resize', cols: 1, rows: 1 });
});

test('anything but an exact, valid resize message is rejected', () => {
  const rejected = [
    '',
    'not json',
    '{"type":"resize","cols":80,',
    'null',
    '42',
    '"resize"',
    'true',
    '[]',
    '[{"type":"resize","cols":80,"rows":24}]',
    '{}',
    '{"type":"input","cols":80,"rows":24}',
    '{"cols":80,"rows":24}',
    '{"type":"resize","cols":80,"rows":24,"extra":1}',
    '{"type":"resize","cols":80}',
    '{"type":"resize","rows":24}',
    '{"type":"resize","cols":0,"rows":24}',
    '{"type":"resize","cols":501,"rows":24}',
    '{"type":"resize","cols":80,"rows":0}',
    '{"type":"resize","cols":80,"rows":201}',
    '{"type":"resize","cols":1.5,"rows":24}',
    '{"type":"resize","cols":"80","rows":24}',
    '{"type":"resize","cols":null,"rows":24}',
  ];
  for (const text of rejected) {
    assert.equal(parseShellControl(text), undefined, text);
  }
});

const execution: Execution = { id: 'c1', tokenHash: 'h', worker: { state: 'working', since: '2026-01-01T00:00:00Z' } };
const statuses = Object.keys(transitions) as TaskStatus[];

const taskWith = (status: TaskStatus, hasExecution: boolean, shellEnabled: boolean) => ({
  ...createTask({ projectId: 'p1', title: 't', specification: 's', shellEnabled }, { id: 't1', now: '2026-01-01T00:00:00Z', rank: 0 }),
  status,
  ...(hasExecution && { execution }),
});

test('a shell opens into the execution server of a task that allows it, unless the task is done', () => {
  for (const status of statuses) {
    assert.equal(canOpenShell(taskWith(status, true, true)), status !== 'done', status);
  }
});

test('no shell opens without an execution server or when the task disables it', () => {
  for (const status of statuses) {
    assert.equal(canOpenShell(taskWith(status, false, true)), false, `${status} without execution`);
    assert.equal(canOpenShell(taskWith(status, true, false)), false, `${status} disabled`);
    assert.equal(canOpenShell(taskWith(status, false, false)), false, `${status} disabled without execution`);
  }
});

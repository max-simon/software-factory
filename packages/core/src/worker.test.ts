import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DomainError, type DomainErrorCode } from './errors.ts';
import { createTask } from './operations.ts';
import type { Execution, Task, TaskStatus } from './task.ts';
import {
  acceptWork,
  agentConsoleOf,
  isPausedForUsageLimit,
  isWorking,
  markWorking,
  moveAgentConsole,
  needsNotify,
  pendingFollowUps,
  pendingWork,
  recordHeartbeat,
  recordUsageLimit,
  releaseWorker,
  usageLimitFallbackMs,
  usageLimitResumeAt,
} from './worker.ts';

const at = (day: number) => `2026-01-0${day}T00:00:00.000Z`;
const now = at(5);

/** A task in `status` with an execution server whose worker works since day 1. */
const taskIn = (status: TaskStatus, overrides: Partial<Task> = {}, execution: Partial<Execution> = {}): Task => ({
  ...createTask({ projectId: 'p1', title: 't', specification: 's' }, { id: 'task-1', now: at(1), rank: 0 }),
  status,
  execution: { id: 'c', tokenHash: 'h', worker: { state: 'working', since: at(1) }, ...execution },
  ...overrides,
});

const rejectsWith = (code: DomainErrorCode) => (error: unknown) =>
  error instanceof DomainError && error.code === code;

const followUps = [
  { id: 'f1', createdAt: at(1), message: 'one', deliveredAt: at(2) },
  { id: 'f2', createdAt: at(2), message: 'two' },
  { id: 'f3', createdAt: at(3), message: 'three' },
];

describe('recordHeartbeat', () => {
  const heartbeat = { at: '2026-01-01T00:00:15Z', phase: 'working' as const, activity: 'Running Bash: yarn test' };

  it('replaces the last heartbeat in every status a runner may be awake in', () => {
    for (const status of ['in_progress', 'input_required', 'ready', 'failed'] as const) {
      const previous = { at: '2026-01-01T00:00:00Z', phase: 'setting_up' as const };
      const task = recordHeartbeat(taskIn(status, {}, { lastHeartbeat: previous }), heartbeat);
      assert.deepEqual(task.execution?.lastHeartbeat, heartbeat);
    }
  });

  it('is rejected before dispatch and after the end', () => {
    for (const status of ['draft', 'queued', 'done'] as const) {
      assert.throws(() => recordHeartbeat(taskIn(status), heartbeat), rejectsWith('not_active'));
    }
  });

  it('is rejected without an execution server', () => {
    assert.throws(() => recordHeartbeat(taskIn('in_progress', { execution: undefined }), heartbeat), rejectsWith('no_execution'));
  });
});

describe('pendingFollowUps', () => {
  it('lists follow-ups no runner accepted yet, in order', () => {
    assert.deepEqual(pendingFollowUps(taskIn('in_progress', { followUps })).map((f) => f.id), ['f2', 'f3']);
    assert.deepEqual(pendingFollowUps(taskIn('in_progress')), []);
  });
});

describe('pendingWork', () => {
  it('hands out the task itself until a runner accepted it, with any follow-ups', () => {
    assert.deepEqual(pendingWork(taskIn('in_progress'), now), { followUps: [], inputIds: [] });
    assert.deepEqual(pendingWork(taskIn('in_progress', { followUps }), now), { followUps: followUps.slice(1), inputIds: [] });
  });

  it('has nothing once the task was accepted and nothing new arrived', () => {
    assert.equal(pendingWork(taskIn('in_progress', {}, { workAcceptedAt: at(2) }), now), undefined);
  });

  it('hands out pending follow-ups after the task was accepted', () => {
    const work = pendingWork(taskIn('in_progress', { followUps }, { workAcceptedAt: at(2) }), now);
    assert.deepEqual(work?.followUps.map((f) => f.id), ['f2', 'f3']);
  });

  it('hands out input settled since the last acceptance, not older or open input', () => {
    const task = taskIn('in_progress', {
      questions: [
        { id: 'q1', createdAt: at(1), problem: 'old', type: 'text', options: [], answer: ['a'] },
        { id: 'q2', createdAt: at(3), problem: 'new', type: 'text', options: [], answer: ['b'] },
      ],
      decisions: [
        { id: 'd1', createdAt: at(3), problem: 'p', options: [], reasoning: 'r', approval: { status: 'approved' } },
        { id: 'd2', createdAt: at(3), problem: 'p', options: [], reasoning: 'r' },
      ],
      artifacts: [{ id: 'a1', createdAt: at(4), title: 't', kind: 'k', content: 'c', approval: { status: 'changes_requested', comment: 'c' } }],
    }, { workAcceptedAt: at(2) });
    assert.deepEqual(pendingWork(task, now)?.inputIds, ['q2', 'd1', 'a1']);
  });

  it('has nothing unless the task is in progress', () => {
    for (const status of ['queued', 'input_required', 'ready', 'failed', 'done'] as const) {
      assert.equal(pendingWork(taskIn(status, { followUps }), now), undefined, status);
    }
  });
});

describe('acceptWork', () => {
  it('stamps the given follow-ups and the acceptance, keeping earlier delivery times', () => {
    const task = acceptWork(taskIn('in_progress', { followUps }), ['f1', 'f2'], at(5));
    assert.deepEqual(task.followUps.map((f) => `${f.id}=${f.deliveredAt}`), [`f1=${at(2)}`, `f2=${at(5)}`, 'f3=undefined']);
    assert.equal(task.execution?.workAcceptedAt, at(5));
    assert.deepEqual(pendingWork(task, now)?.followUps.map((f) => f.id), ['f3']);
  });

  it('rejects an unknown follow-up and any status but in_progress', () => {
    assert.throws(() => acceptWork(taskIn('in_progress', { followUps }), ['f9'], at(5)), rejectsWith('unknown_follow_up'));
    assert.throws(() => acceptWork(taskIn('ready', { followUps }), [], at(5)), rejectsWith('not_active'));
  });
});

describe('worker state', () => {
  const idle = { state: 'idle' as const, since: at(2) };

  it('markWorking marks the worker working from now', () => {
    assert.deepEqual(markWorking(taskIn('in_progress', {}, { worker: idle }), at(3)).execution?.worker, { state: 'working', since: at(3) });
  });

  it('releaseWorker idles the worker and keeps a status the agent reported', () => {
    for (const status of ['input_required', 'ready', 'failed'] as const) {
      const task = releaseWorker(taskIn(status), 'lost', at(3));
      assert.deepEqual([task.status, task.execution?.worker], [status, { state: 'idle', since: at(3) }]);
    }
  });

  it('releaseWorker fails a task still in progress with the reason', () => {
    const task = releaseWorker(taskIn('in_progress'), 'the agent stopped', at(3));
    assert.deepEqual([task.status, task.failureReason, task.failedAt, task.execution?.worker.state], ['failed', 'the agent stopped', at(3), 'idle']);
  });

  it('needsNotify holds for an idle worker with pending work only', () => {
    const waiting = taskIn('in_progress', { followUps }, { worker: idle, workAcceptedAt: at(1) });
    assert.equal(needsNotify(waiting, now), true);
    assert.equal(needsNotify(markWorking(waiting, at(3)), now), false);
    assert.equal(needsNotify({ ...waiting, followUps: [] }, now), false);
    assert.equal(needsNotify({ ...waiting, execution: undefined }, now), false);
  });

  it('isWorking holds for a working or notified worker only', () => {
    assert.equal(isWorking(taskIn('in_progress')), true);
    assert.equal(isWorking(taskIn('in_progress', {}, { worker: idle })), false);
    assert.equal(isWorking(taskIn('queued', { execution: undefined })), false);
  });

  it('rejects worker changes without an execution server', () => {
    assert.throws(() => markWorking(taskIn('in_progress', { execution: undefined }), at(3)), rejectsWith('no_execution'));
  });
});

describe('usage limit', () => {
  const reportedAt = '2026-01-01T10:00:00.000Z';
  const idle = { state: 'idle' as const, since: reportedAt };
  const paused = (resetsAt?: string) =>
    recordUsageLimit(taskIn('in_progress', { followUps }, { worker: idle, workAcceptedAt: at(1) }), resetsAt, reportedAt);

  it('usageLimitResumeAt resumes a minute after the reported reset', () => {
    assert.equal(usageLimitResumeAt('2026-01-01T15:00:00.000Z', reportedAt), '2026-01-01T15:01:00.000Z');
  });

  it('usageLimitResumeAt resumes a minute from now for a reset already past', () => {
    assert.equal(usageLimitResumeAt('2026-01-01T09:00:00.000Z', reportedAt), '2026-01-01T10:01:00.000Z');
  });

  it('usageLimitResumeAt falls back without a reset and caps a reset beyond the longest limit', () => {
    assert.equal(Date.parse(usageLimitResumeAt(undefined, reportedAt)) - Date.parse(reportedAt), usageLimitFallbackMs);
    assert.equal(usageLimitResumeAt('2027-01-01T00:00:00.000Z', reportedAt), '2026-01-09T10:00:00.000Z');
  });

  it('recordUsageLimit keeps the task in progress and records when it resumes', () => {
    const task = paused('2026-01-01T15:00:00.000Z');
    assert.equal(task.status, 'in_progress');
    assert.deepEqual(task.execution?.usageLimit, {
      since: reportedAt,
      resetsAt: '2026-01-01T15:00:00.000Z',
      resumesAt: '2026-01-01T15:01:00.000Z',
    });
    assert.equal(paused().execution?.usageLimit?.resetsAt, undefined);
  });

  it('recordUsageLimit is rejected unless the task is in progress', () => {
    for (const status of ['input_required', 'ready', 'failed'] as const) {
      assert.throws(() => recordUsageLimit(taskIn(status), undefined, reportedAt), rejectsWith('not_active'), status);
    }
    assert.throws(() => recordUsageLimit(taskIn('in_progress', { execution: undefined }), undefined, reportedAt), rejectsWith('no_execution'));
  });

  it('holds back all work until the session resumes, then hands out work even with nothing new', () => {
    const task = paused('2026-01-01T15:00:00.000Z');
    assert.equal(pendingWork(task, '2026-01-01T15:00:59.000Z'), undefined);
    assert.equal(needsNotify(task, '2026-01-01T15:00:59.000Z'), false);
    assert.deepEqual(pendingWork(task, '2026-01-01T15:01:00.000Z')?.followUps.map((f) => f.id), ['f2', 'f3']);
    const withNothingNew = { ...task, followUps: [] };
    assert.deepEqual(pendingWork(withNothingNew, '2026-01-01T15:01:00.000Z'), { followUps: [], inputIds: [] });
    assert.equal(needsNotify(withNothingNew, '2026-01-01T15:01:00.000Z'), true);
  });

  it('isPausedForUsageLimit holds until the session resumes, and only while in progress', () => {
    const task = paused('2026-01-01T15:00:00.000Z');
    assert.equal(isPausedForUsageLimit(task, '2026-01-01T12:00:00.000Z'), true);
    assert.equal(isPausedForUsageLimit(task, '2026-01-01T15:01:00.000Z'), false);
    assert.equal(isPausedForUsageLimit({ ...task, status: 'failed' }, '2026-01-01T12:00:00.000Z'), false);
    assert.equal(isPausedForUsageLimit(taskIn('in_progress'), '2026-01-01T12:00:00.000Z'), false);
  });

  it('releaseWorker idles a paused task without failing it, and fails it once the pause is over', () => {
    const task = paused('2026-01-01T15:00:00.000Z');
    const waiting = releaseWorker(task, 'lost', '2026-01-01T10:00:01.000Z');
    assert.deepEqual([waiting.status, waiting.execution?.worker.state], ['in_progress', 'idle']);
    assert.equal(releaseWorker(task, 'lost', '2026-01-01T15:02:00.000Z').status, 'failed');
  });

  it('acceptWork ends the pause', () => {
    const task = acceptWork(paused('2026-01-01T15:00:00.000Z'), [], '2026-01-01T15:01:05.000Z');
    assert.equal(task.execution?.usageLimit, undefined);
    assert.equal(task.execution?.workAcceptedAt, '2026-01-01T15:01:05.000Z');
  });
});

describe('moveAgentConsole', () => {
  it('replaces the console address and keeps its password', () => {
    const task = taskIn('in_progress', {}, { console: { url: 'http://127.0.0.1:1', password: 'pw' } });
    assert.deepEqual(moveAgentConsole(task, 'http://127.0.0.1:2').execution?.console, { url: 'http://127.0.0.1:2', password: 'pw' });
  });

  it('rejects a task without a console', () => {
    assert.throws(() => moveAgentConsole(taskIn('in_progress'), 'http://127.0.0.1:2'), rejectsWith('no_execution'));
  });
});

describe('agentConsoleOf', () => {
  it('returns the console with its password', () => {
    const task = taskIn('in_progress', {}, { console: { url: 'http://127.0.0.1:1', password: 'pw' } });
    assert.deepEqual(agentConsoleOf(task), { url: 'http://127.0.0.1:1', password: 'pw' });
  });

  it('rejects a task without a console', () => {
    assert.throws(() => agentConsoleOf(taskIn('in_progress')), rejectsWith('no_execution'));
  });
});

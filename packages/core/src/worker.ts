import { DomainError } from './errors.ts';
import { markFailed } from './operations.ts';
import type { AgentConsole, Execution, FollowUp, Heartbeat, Task, TaskStatus, Work } from './task.ts';

// The worker lifecycle: the control plane starts an execution server; its
// runner asks for work with a heartbeat, accepts it, beats while it works, and
// asks again. Getting no work, it goes idle and waits; the control plane
// notifies it when new work arrives.

/** Four missed beats: one lost heartbeat or a slow request must not count as a dead execution server. */
export const heartbeatTimeoutMs = 60_000;

// A runner reports ready or a failure during its turn and asks for work only afterwards.
const awakeStatuses: readonly TaskStatus[] = ['in_progress', 'input_required', 'ready', 'failed'];

/** Applies `change` to the task's execution; the worker lifecycle needs one. */
function updateExecution(task: Task, change: Partial<Execution>): Task {
  if (task.execution === undefined) {
    throw new DomainError('no_execution', `task ${task.id} has no execution server`);
  }
  return { ...task, execution: { ...task.execution, ...change } };
}

/** Replaces the last heartbeat. */
export function recordHeartbeat(task: Task, heartbeat: Heartbeat): Task {
  if (!awakeStatuses.includes(task.status)) {
    throw new DomainError('not_active', `task is ${task.status}, heartbeats are accepted only while it runs`);
  }
  return updateExecution(task, { lastHeartbeat: { ...heartbeat } });
}

/** Follow-ups no runner has accepted yet, oldest first. */
export const pendingFollowUps = (task: Pick<Task, 'followUps'>): FollowUp[] =>
  task.followUps.filter((f) => f.deliveredAt === undefined);

/**
 * Answered questions and reviewed approval requests the agent made since the
 * runner last accepted work: every turn starts with accepted work, so these
 * are the ones its session has not heard about.
 */
function settledInputIds(task: Task): string[] {
  const since = task.execution?.workAcceptedAt;
  if (since === undefined) return [];
  // Inclusive: an item handed out twice is harmless, one never handed out stalls the task.
  const isNew = (item: { createdAt: string }) => item.createdAt >= since;
  const answered = task.questions.filter((q) => q.answer !== undefined && isNew(q));
  const reviewed = [...task.decisions, ...task.artifacts].filter(
    (i) => i.approval !== undefined && i.approval.status !== 'pending' && isNew(i),
  );
  return [...answered, ...reviewed].map((item) => item.id);
}

/**
 * The work the control plane owes the task's runner: the task itself until a
 * runner accepted it, then follow-ups and settled input. Only an in-progress
 * task has work: the last answer or review resumes a task awaiting input, and
 * a follow-up moves a ready or failed one back.
 */
export function pendingWork(task: Task): Work | undefined {
  if (task.status !== 'in_progress') return undefined;
  const work: Work = { followUps: pendingFollowUps(task), inputIds: settledInputIds(task) };
  const hasWork = task.execution?.workAcceptedAt === undefined || work.followUps.length > 0 || work.inputIds.length > 0;
  return hasWork ? work : undefined;
}

/**
 * Records that the runner took the work it was handed: its follow-ups count as
 * delivered. Accepting again is harmless, so a runner that lost the reply retries.
 */
export function acceptWork(task: Task, followUpIds: readonly string[], now: string): Task {
  if (task.status !== 'in_progress') {
    throw new DomainError('not_active', `task is ${task.status}, work is accepted only while it is in progress`);
  }
  const unknown = followUpIds.find((id) => !task.followUps.some((f) => f.id === id));
  if (unknown !== undefined) throw new DomainError('unknown_follow_up', `task ${task.id} has no follow-up ${unknown}`);
  const followUps = task.followUps.map((f) =>
    followUpIds.includes(f.id) && f.deliveredAt === undefined ? { ...f, deliveredAt: now } : f,
  );
  return updateExecution({ ...task, followUps }, { workAcceptedAt: now });
}

/** The execution server was notified of work and is expected to ask for it. */
export const markWorking = (task: Task, now: string): Task => updateExecution(task, { worker: { state: 'working', since: now } });

/**
 * The worker is done: it found no work, or it went silent. A task still in
 * progress then lost its agent's outcome and fails with `reason`; in any other
 * status the task waits, idle, for its next work.
 */
export function releaseWorker(task: Task, reason: string, now: string): Task {
  const idle = updateExecution(task, { worker: { state: 'idle', since: now } });
  return task.status === 'in_progress' ? markFailed(idle, reason, now) : idle;
}

/** Whether the task's execution server is idle although work waits for it. */
export const needsNotify = (task: Task): boolean =>
  task.execution?.worker.state === 'idle' && pendingWork(task) !== undefined;

/** Whether the task's execution server works on it or was notified of work. */
export const isWorking = (task: Task): boolean => task.execution !== undefined && task.execution.worker.state !== 'idle';

/** A new agent console address of the task's execution server, which a restart may have moved. */
export function moveAgentConsole(task: Task, url: string): Task {
  const console = task.execution?.console;
  if (console === undefined) throw new DomainError('no_execution', `task ${task.id} has no agent console`);
  return updateExecution(task, { console: { ...console, url } });
}

/** The agent console of the task's execution server; only opencode execution servers have one. */
export function agentConsoleOf(task: Task): AgentConsole {
  const console = task.execution?.console;
  if (console === undefined) {
    throw new DomainError('no_execution', `task ${task.id} has no agent console: it needs an opencode execution server`);
  }
  return console;
}

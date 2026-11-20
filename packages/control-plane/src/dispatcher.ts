import {
  hasOpenInput,
  heartbeatTimeoutMs,
  isBlocked,
  isPausedForUsageLimit,
  isWorking,
  needsNotify,
  type ExecutionRuntime,
  type StartedExecution,
  type Task,
} from '@factory/core';
import { createAgentToken } from './agent-token.ts';
import type { LifecycleService } from './lifecycle-service.ts';
import { redact } from './redact.ts';
import type { TaskStore } from './task-store.ts';

export interface DispatcherDeps {
  tasks: TaskStore;
  lifecycle: LifecycleService;
  runtime: ExecutionRuntime;
  /** Control-plane address as seen from an execution server. */
  controlPlaneUrl: string;
  /** Execution servers that may be working at the same time; notified ones may exceed it briefly. */
  maxRunning: number;
  /** How long a failed task keeps its idle execution server for a follow-up. */
  followUpWindowMs: number;
  /** Secret values to strip from log tails before they are stored as failure reasons. */
  secrets: readonly string[];
  log?: (message: string) => void;
  /** Epoch milliseconds. */
  now?: () => number;
  /**
   * Since when the control plane has run without a pause, in epoch
   * milliseconds; defaults to when the dispatcher was created.
   */
  awakeSince?: () => number;
}

// Covers starting, resuming or restarting the execution server and its runner
// before the first heartbeat; remote compute may also pull the image first.
export const startupTimeoutMs = 5 * 60_000;
// Orphans only arise from rare crashes and failed removals. Listing them is a
// single call however many tasks there are, but not worth making every pass.
export const orphanSweepIntervalMs = 10 * 60_000;

/** For tasks with an execution server only. */
const workerSince = (task: Task): number => Date.parse(task.execution!.worker.since);

/**
 * Ready, or waiting for the engineer on its pull requests only; its last
 * reports have arrived, and none of its pull requests is open as last
 * recorded, which is the pull request observer's job. A task waiting for an
 * answer or approval is never done, whatever its pull requests.
 */
const isSettleable = (task: Task): boolean =>
  (task.status === 'ready' || (task.status === 'input_required' && !hasOpenInput(task))) &&
  !isWorking(task) &&
  task.pullRequests.every((pr) => pr.status !== 'open');

export class Dispatcher {
  readonly #deps: DispatcherDeps;
  readonly #log: (message: string) => void;
  readonly #now: () => number;
  /**
   * Heartbeats sent while the control plane was down were never received, and
   * none were sent while the host slept, so silence counts from here.
   */
  readonly #awakeSince: () => number;
  #lastSweepAt: number | undefined;

  constructor(deps: DispatcherDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? ((message) => console.error(message));
    this.#now = deps.now ?? Date.now;
    const startedAt = this.#now();
    this.#awakeSince = deps.awakeSince ?? (() => startedAt);
  }

  /**
   * One pass: remove orphaned execution servers when a sweep is due, restart
   * silent workers, notify idle workers that have work, start queued tasks
   * whose dependencies are done in rank order while fewer workers than the
   * limit are working and no task of their agent waits for a usage limit,
   * mark ready tasks, and those waiting for the engineer on their pull
   * requests only, done once none of their pull requests is open, and remove
   * execution servers no task needs.
   */
  async reconcile(): Promise<void> {
    const { tasks, lifecycle, maxRunning } = this.#deps;
    await this.#sweepOrphansIfDue();
    await this.#forEach(tasks.list().filter(isWorking), (task) => this.#restartIfSilent(task));
    const now = new Date(this.#now()).toISOString();
    const inProgress = tasks.list(['in_progress']);
    await this.#forEach(inProgress.filter((task) => needsNotify(task, now)), (task) => this.#notify(task));
    const all = tasks.list();
    const freeSlots = Math.max(0, maxRunning - all.filter(isWorking).length);
    // Every task of an agent runs on the same credential, so a new one would only hit the same limit.
    const limitedAgents = new Set(inProgress.filter((task) => isPausedForUsageLimit(task, now)).map((task) => task.agent));
    const startable = tasks.list(['queued']).filter((task) => !isBlocked(task, all) && !limitedAgents.has(task.agent));
    await this.#forEach(startable.slice(0, freeSlots), (task) => this.#dispatch(task));
    await this.#forEach(tasks.list(['ready', 'input_required']).filter(isSettleable), async (task) => {
      lifecycle.markDone(task.id);
    });
    await this.#forEach(tasks.list(['done']), (task) => this.#removeExecution(task));
    await this.#forEach(tasks.list(['failed']).filter((task) => this.#isFollowUpWindowOver(task)), (task) =>
      this.#removeExecution(task),
    );
  }

  /** Due on the first pass, when orphans of a crash show up, then once per interval. */
  async #sweepOrphansIfDue(): Promise<void> {
    const now = this.#now();
    if (this.#lastSweepAt !== undefined && now - this.#lastSweepAt < orphanSweepIntervalMs) return;
    // Recorded before the sweep so a failing runtime is retried at the next interval, not every pass.
    this.#lastSweepAt = now;
    try {
      await this.#removeOrphans();
    } catch (error) {
      this.#log(`dispatcher: cannot list execution servers: ${this.#redact(describe(error))}`);
    }
  }

  /**
   * Removes execution servers no task knows. No lock needed: passes never
   * overlap and this runs before dispatching, so no execution server is between
   * `start` and `markInProgress`. Engineer actions may remove one concurrently,
   * which `remove` tolerates.
   */
  async #removeOrphans(): Promise<void> {
    const { tasks, runtime } = this.#deps;
    const listed = await runtime.listExecutions();
    const known = new Set(tasks.list().flatMap((task) => (task.execution ? [task.execution.id] : [])));
    for (const executionId of listed.filter((id) => !known.has(id))) {
      try {
        await runtime.remove(executionId);
        this.#log(`dispatcher: removed orphaned execution server ${executionId}`);
      } catch (error) {
        this.#log(`dispatcher: execution server ${executionId}: ${this.#redact(describe(error))}`);
      }
    }
  }

  async #dispatch(task: Task): Promise<void> {
    const { lifecycle, runtime, controlPlaneUrl } = this.#deps;
    const { token, tokenHash } = createAgentToken();
    let execution: StartedExecution;
    try {
      execution = await runtime.start({
        taskId: task.id,
        controlPlaneUrl,
        token,
        model: task.model,
        agent: task.agent,
        ...(task.repoUrl && { repoUrl: task.repoUrl }),
        ...(task.baseBranch && { baseBranch: task.baseBranch }),
      });
    } catch (error) {
      lifecycle.markFailed(task.id, `cannot start execution server: ${this.#redact(describe(error))}`);
      return;
    }
    try {
      lifecycle.markInProgress(task.id, { tokenHash, ...execution });
    } catch (error) {
      // The task was cancelled or deleted while its execution server started;
      // nothing would ever stop that execution server.
      await runtime.remove(execution.executionId);
      throw error;
    }
  }

  /**
   * Marked working before the runtime call, so a runner that reports and goes
   * idle while the call is still running is not marked working afterwards.
   * Notified once: a runner that never asks for the work turns silent and is restarted.
   */
  async #notify(task: Task): Promise<void> {
    const { lifecycle, runtime } = this.#deps;
    lifecycle.markWorking(task.id);
    try {
      this.#moveAgentConsole(task, await runtime.notify(task.execution!.id, task.agent));
    } catch (error) {
      lifecycle.releaseWorker(task.id, `cannot notify execution server: ${this.#redact(describe(error))}`);
    }
  }

  /**
   * A silent server may have exited or hang. It is released first, so a task
   * still in progress fails for its silence before the restarted runner asks
   * for work; one waiting for input or a follow-up keeps waiting, since the
   * restarted runner resumes the session.
   */
  async #restartIfSilent(task: Task): Promise<void> {
    const { lifecycle, runtime } = this.#deps;
    if (!this.#isSilent(task)) return;
    lifecycle.releaseWorker(task.id, 'execution server stopped sending heartbeats before the task finished');
    this.#moveAgentConsole(task, await runtime.restart(task.execution!.id, task.agent));
  }

  #moveAgentConsole(task: Task, { agentConsoleUrl }: { agentConsoleUrl?: string }): void {
    if (agentConsoleUrl !== undefined && agentConsoleUrl !== task.execution?.console?.url) {
      this.#deps.lifecycle.moveAgentConsole(task.id, agentConsoleUrl);
    }
  }

  /** Silent: no heartbeat within the timeout, or none since it was started or notified within the startup timeout. */
  #isSilent(task: Task): boolean {
    const since = workerSince(task);
    const heartbeat = task.execution?.lastHeartbeat;
    const lastBeat = heartbeat ? Date.parse(heartbeat.at) : undefined;
    const [lastSign, timeout] =
      lastBeat !== undefined && lastBeat >= since ? [lastBeat, heartbeatTimeoutMs] : [since, startupTimeoutMs];
    return this.#now() - Math.max(lastSign, this.#awakeSince()) > timeout;
  }

  #isFollowUpWindowOver(task: Task): boolean {
    return task.execution !== undefined && !isWorking(task) && this.#now() - workerSince(task) > this.#deps.followUpWindowMs;
  }

  async #removeExecution(task: Task): Promise<void> {
    if (!task.execution) return;
    await this.#deps.runtime.remove(task.execution.id);
    this.#deps.lifecycle.detachExecution(task.id);
  }

  #redact(text: string): string {
    return redact(text, this.#deps.secrets);
  }

  // One broken task must not stop the others from being reconciled.
  async #forEach(tasks: Task[], handle: (task: Task) => Promise<void>): Promise<void> {
    for (const task of tasks) {
      try {
        await handle(task);
      } catch (error) {
        this.#log(`dispatcher: task ${task.id}: ${this.#redact(describe(error))}`);
      }
    }
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

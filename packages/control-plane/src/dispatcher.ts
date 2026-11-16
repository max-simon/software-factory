import {
  heartbeatTimeoutMs,
  isBlocked,
  isWorking,
  needsNotify,
  type ExecutionRuntime,
  type PullRequest,
  type PullRequestReader,
  type StartedExecution,
  type Task,
  type TaskStatus,
} from '@factory/core';
import { createAgentToken } from './agent-token.ts';
import type { LifecycleService } from './lifecycle-service.ts';
import type { TaskStore } from './task-store.ts';

export interface DispatcherDeps {
  tasks: TaskStore;
  lifecycle: LifecycleService;
  runtime: ExecutionRuntime;
  pullRequests: PullRequestReader;
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
// Pull requests stay open for hours or days; GitHub's rate limit is per hour.
export const pullRequestCheckIntervalMs = 60_000;
// Orphans only arise from rare crashes and failed removals. Listing them is a
// single call however many tasks there are, but not worth making every pass.
export const orphanSweepIntervalMs = 10 * 60_000;

/** For tasks with an execution server only. */
const workerSince = (task: Task): number => Date.parse(task.execution!.worker.since);

/** Statuses whose pull requests may still change: the agent may push, reviewers may review. */
const watchedStatuses: readonly TaskStatus[] = ['in_progress', 'input_required', 'ready', 'failed'];
const hasOpenPullRequest = (task: Task): boolean => task.pullRequests.some((pr) => pr.status === 'open');
/** Its last reports have arrived, so it is done once no pull request is open. */
const isSettleable = (task: Task): boolean => task.status === 'ready' && !isWorking(task);
/** A failed task's pull requests are watched only while a follow-up can still resume its agent. */
const isWatched = (task: Task): boolean =>
  (task.status !== 'failed' || task.execution !== undefined) && (hasOpenPullRequest(task) || isSettleable(task));
const reviewIds = (pr: PullRequest): string | undefined => pr.reviews?.map((review) => review.id).join();
const hasChanged = (before: PullRequest, after: PullRequest): boolean =>
  after.status !== before.status || after.title !== before.title || reviewIds(after) !== reviewIds(before);

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
  /** Per watched task, when its pull requests were last read; a restart reads them all once. */
  readonly #pullRequestChecks = new Map<string, number>();

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
   * limit are working, read the open
   * pull requests of started tasks and settle ready ones, and remove execution
   * servers no task needs.
   */
  async reconcile(): Promise<void> {
    const { tasks, maxRunning } = this.#deps;
    await this.#sweepOrphansIfDue();
    await this.#forEach(tasks.list().filter(isWorking), (task) => this.#restartIfSilent(task));
    await this.#forEach(tasks.list(['in_progress']).filter(needsNotify), (task) => this.#notify(task));
    const all = tasks.list();
    const freeSlots = Math.max(0, maxRunning - all.filter(isWorking).length);
    const startable = tasks.list(['queued']).filter((task) => !isBlocked(task, all));
    await this.#forEach(startable.slice(0, freeSlots), (task) => this.#dispatch(task));
    const watched = tasks.list(watchedStatuses).filter(isWatched);
    this.#forgetPullRequestChecks(watched);
    await this.#forEach(watched, (task) => this.#checkPullRequestsIfDue(task));
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

  /** A task that is watched again later is read at once. */
  #forgetPullRequestChecks(watched: readonly Task[]): void {
    const ids = new Set(watched.map((task) => task.id));
    for (const id of this.#pullRequestChecks.keys()) if (!ids.has(id)) this.#pullRequestChecks.delete(id);
  }

  /**
   * Reads the open pull requests of a task and records changes to title, status
   * and reviews. A settleable task is marked done once none is open, at once
   * when it has none.
   */
  async #checkPullRequestsIfDue(task: Task): Promise<void> {
    const { tasks, lifecycle, pullRequests } = this.#deps;
    const now = this.#now();
    const lastCheck = this.#pullRequestChecks.get(task.id);
    if (lastCheck !== undefined && now - lastCheck < pullRequestCheckIntervalMs) return;
    // Recorded first, so a failing GitHub is asked again only at the next interval.
    this.#pullRequestChecks.set(task.id, now);
    const open = task.pullRequests.filter((pr) => pr.status === 'open');
    const current = await Promise.all(open.map((pr) => pullRequests.read(pr.url)));
    const changed = current.filter((pr, i) => hasChanged(open[i]!, pr));
    if (changed.length > 0) lifecycle.updatePullRequests(task.id, changed);
    if (current.some((pr) => pr.status === 'open')) return;
    // A follow-up may have resumed the task while GitHub was asked.
    if (isSettleable(tasks.get(task.id))) lifecycle.markDone(task.id);
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
    return this.#deps.secrets.filter(Boolean).reduce((result, secret) => result.replaceAll(secret, '[redacted]'), text);
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

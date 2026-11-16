import {
  detachExecution,
  markDone,
  markFailed,
  markInProgress,
  markWorking,
  moveAgentConsole,
  releaseWorker,
  updatePullRequests,
  type PullRequest,
  type StartedExecution,
  type Task,
} from '@factory/core';
import type { TaskStore } from './task-store.ts';

/**
 * What the control plane records on its own while it runs tasks: execution
 * servers started, notified, released and removed, and what it read of the
 * pull requests. The dispatcher decides when; this service records it.
 */
export class LifecycleService {
  readonly #tasks: TaskStore;

  constructor(tasks: TaskStore) {
    this.#tasks = tasks;
  }

  markInProgress(id: string, started: { tokenHash: string } & StartedExecution): Task {
    return this.#tasks.update(id, 'system', (task) => markInProgress(task, started, this.#tasks.now()));
  }

  markWorking(id: string): Task {
    return this.#tasks.update(id, 'system', (task) => markWorking(task, this.#tasks.now()));
  }

  /** The worker is done; a task still in progress fails with `reason`. */
  releaseWorker(id: string, reason: string): Task {
    return this.#tasks.update(id, 'system', (task) => releaseWorker(task, reason, this.#tasks.now()));
  }

  /** A notified or restarted execution server may publish its agent console on another port. */
  moveAgentConsole(id: string, url: string): Task {
    return this.#tasks.update(id, 'system', (task) => moveAgentConsole(task, url));
  }

  detachExecution(id: string): Task {
    return this.#tasks.update(id, 'system', detachExecution);
  }

  markFailed(id: string, reason: string): Task {
    return this.#tasks.update(id, 'system', (task) => markFailed(task, reason));
  }

  markDone(id: string): Task {
    return this.#tasks.update(id, 'system', markDone);
  }

  updatePullRequests(id: string, updates: readonly PullRequest[]): Task {
    return this.#tasks.update(id, 'system', (task) => updatePullRequests(task, updates));
  }
}

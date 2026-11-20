import { randomBytes } from 'node:crypto';
import {
  canOpenShell,
  DomainError,
  maxShellsPerTask,
  type ExecutionRuntime,
  type Principal,
  type ShellEndpoint,
  type ShellRequest,
  type ShellSize,
  type Task,
} from '@factory/core';
import { describe } from './hooks/hooks.ts';
import { redact } from './redact.ts';
import { NotFoundError, type TaskStore } from './task-store.ts';

export interface ShellServiceDeps {
  tasks: Pick<TaskStore, 'get'>;
  runtime: Pick<ExecutionRuntime, 'notifyShell'>;
  /** Milliseconds an open shell may go without input before `sweep` closes it. */
  idleTimeoutMs: number;
  /** Milliseconds a runner has to attach to a request before the browser is told it failed. */
  connectTimeoutMs?: number;
  /** Secret values to strip from logged errors. */
  secrets: readonly string[];
  log?: (message: string) => void;
  /** Epoch milliseconds. */
  now?: () => number;
  newId?: () => string;
}

export interface AttachedShell {
  browser: ShellEndpoint;
  /** For `recordInput`. */
  shellId: string;
}

/** WebSocket close code for every end the service decides; 4000 to 4999 are free for applications. */
const closeCode = 4000;
const defaultConnectTimeoutMs = 10_000;

interface Shell {
  request: ShellRequest;
  browser: ShellEndpoint;
  isAuthorized: () => boolean;
  connectTimer?: NodeJS.Timeout;
  /** Set once a runner attached. */
  runner?: ShellEndpoint;
  /** Epoch milliseconds of the last input, or of the attach. */
  lastInputAt?: number;
}

const unavailableReason = (task: Task): string => {
  if (!task.shellEnabled) return 'the shell is disabled for this task';
  if (!task.execution) return 'the task has no execution server';
  return 'the task is done';
};

/**
 * Pairs an engineer's browser with the runner of the task's execution server.
 * Kept in memory only: a restarted control plane has no open connections.
 * It never relays bytes and never closes one side when the other closes.
 */
export class ShellService {
  readonly #deps: ShellServiceDeps;
  readonly #log: (message: string) => void;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #shells = new Map<string, Shell>();

  constructor(deps: ShellServiceDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? ((message) => console.error(message));
    this.#now = deps.now ?? Date.now;
    this.#newId = deps.newId ?? (() => randomBytes(8).toString('hex'));
  }

  /**
   * Records a pending request and wakes the execution server, whose runner
   * then attaches. A failure after the request was accepted reaches the
   * engineer as the browser endpoint's close reason.
   */
  async open(
    principal: Principal,
    taskId: string,
    size: ShellSize,
    browser: ShellEndpoint,
    isAuthorized: () => boolean,
  ): Promise<void> {
    const task = this.#findTask(taskId);
    if (!canOpenShell(task)) throw new DomainError('shell_unavailable', `cannot open a shell: ${unavailableReason(task)}`);
    if (this.#shellsOf(taskId).length >= maxShellsPerTask) {
      throw new DomainError('shell_limit', `at most ${maxShellsPerTask} shells may be open into a task at a time`);
    }
    const id = this.#newId();
    const request: ShellRequest = { id, taskId, size, requestedBy: principal.userId, createdAt: new Date(this.#now()).toISOString() };
    const connectTimer = setTimeout(
      () => this.#end(id, 'the execution server did not connect'),
      this.#deps.connectTimeoutMs ?? defaultConnectTimeoutMs,
    ).unref();
    this.#shells.set(id, { request, browser, isAuthorized, connectTimer });
    browser.onClose(() => this.#forget(id));
    try {
      await this.#deps.runtime.notifyShell(task.execution!.id);
    } catch (error) {
      this.#log(`shell: task ${taskId}: cannot notify execution server: ${redact(describe(error), this.#deps.secrets)}`);
      this.#end(id, 'cannot reach the execution server');
    }
  }

  /** The task's requests no runner has attached to yet. */
  pendingFor(task: Task): ShellRequest[] {
    return this.#shellsOf(task.id)
      .filter((shell) => !shell.runner)
      .map((shell) => shell.request);
  }

  /** Pairs the runner with a pending request of its own task, once; the idle clock starts now. */
  attach(task: Task, requestId: string, runner: ShellEndpoint): AttachedShell {
    const shell = this.#shells.get(requestId);
    // Another task's request is reported as unknown, so a runner learns nothing of other tasks.
    if (!shell || shell.request.taskId !== task.id || shell.runner) {
      throw new NotFoundError(`shell request ${requestId} not found`);
    }
    if (!canOpenShell(task)) throw new DomainError('shell_unavailable', `cannot open a shell: ${unavailableReason(task)}`);
    clearTimeout(shell.connectTimer);
    shell.runner = runner;
    shell.lastInputAt = this.#now();
    runner.onClose(() => this.#forget(requestId));
    return { browser: shell.browser, shellId: requestId };
  }

  recordInput(shellId: string): void {
    const shell = this.#shells.get(shellId);
    if (shell?.runner) shell.lastInputAt = this.#now();
  }

  /** True while a shell into the task is pending or open. */
  hasOpenShell(taskId: string): boolean {
    return this.#shellsOf(taskId).length > 0;
  }

  /** Closes the shells of engineers who lost their authorization, pending ones included, and open shells idle too long. */
  sweep(): void {
    const now = this.#now();
    const { idleTimeoutMs } = this.#deps;
    const minutes = Math.max(1, Math.round(idleTimeoutMs / 60_000));
    const idleReason = `closed after ${minutes} minute${minutes === 1 ? '' : 's'} without input`;
    for (const [id, shell] of this.#shells) {
      if (!shell.isAuthorized()) this.#end(id, 'signed out');
      else if (shell.lastInputAt !== undefined && now - shell.lastInputAt >= idleTimeoutMs) this.#end(id, idleReason);
    }
  }

  #findTask(taskId: string): Task {
    try {
      return this.#deps.tasks.get(taskId);
    } catch (error) {
      if (error instanceof NotFoundError) throw new DomainError('unknown_task', `task ${taskId} not found`);
      throw error;
    }
  }

  #shellsOf(taskId: string): Shell[] {
    return [...this.#shells.values()].filter((shell) => shell.request.taskId === taskId);
  }

  /** Forgotten first, so the endpoint's own close listener finds nothing left to do; a shell already gone stays closed. */
  #end(id: string, reason: string): void {
    const shell = this.#shells.get(id);
    if (!shell) return;
    this.#forget(id);
    shell.browser.close(closeCode, reason);
  }

  #forget(id: string): void {
    clearTimeout(this.#shells.get(id)?.connectTimer);
    this.#shells.delete(id);
  }
}

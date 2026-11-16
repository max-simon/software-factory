import { randomBytes } from 'node:crypto';
import {
  addFollowUp,
  agentConsoleOf,
  answerQuestion,
  assertDeletable,
  assertValidDependencies,
  cancelTask,
  createTask,
  editTask,
  moveTask,
  nextRank,
  requestClarification,
  restartTask,
  returnToDraft,
  reviewItem,
  startTask,
  type ChangeActor,
  type ExecutionRuntime,
  type NewTask,
  type Review,
  type ReviewerNote,
  type Task,
  type TaskEdit,
} from '@factory/core';
import type { TaskStore } from './task-store.ts';

export interface TaskServiceDeps {
  tasks: TaskStore;
  runtime: ExecutionRuntime;
  newId?: () => string;
}

/** What the engineer does with tasks, through the web UI or the MCP server; hooks act on their behalf. */
export class TaskService {
  readonly #tasks: TaskStore;
  readonly #runtime: ExecutionRuntime;
  readonly #newId: () => string;

  constructor(deps: TaskServiceDeps) {
    this.#tasks = deps.tasks;
    this.#runtime = deps.runtime;
    this.#newId = deps.newId ?? (() => randomBytes(5).toString('hex'));
  }

  create(input: NewTask): Task {
    const all = this.#tasks.list();
    const task = createTask(input, { id: this.#newId(), now: this.#tasks.now(), rank: nextRank(all) });
    assertValidDependencies(task, task.dependsOn, all);
    this.#tasks.insert(task);
    return task;
  }

  edit(id: string, edit: TaskEdit): Task {
    return this.#tasks.update(id, 'user', (task) => editTask(task, edit, this.#tasks.list()));
  }

  start(id: string): Task {
    return this.#tasks.update(id, 'user', startTask);
  }

  /** `reviewer` when the spec reviewer holds the task on the engineer's behalf. */
  requestClarification(id: string, note: string, actor: Extract<ChangeActor, 'user' | 'reviewer'> = 'user'): Task {
    return this.#tasks.update(id, actor, (task) => requestClarification(task, note));
  }

  returnToDraft(id: string): Task {
    return this.#tasks.update(id, 'user', returnToDraft);
  }

  /**
   * Fails a queued or running task and removes its execution server. The task
   * is saved first, so the dispatcher does not report the removed server as a
   * crash and the dying runner cannot change the task.
   */
  async cancel(id: string): Promise<Task> {
    const { execution } = this.#tasks.get(id);
    const cancelled = this.#tasks.update(id, 'user', cancelTask);
    if (execution !== undefined) await this.#runtime.remove(execution.id);
    return cancelled;
  }

  /**
   * Queues a started task again from its specification. The old execution
   * server is removed after the task is saved; if the dispatcher starts the new
   * one first, that replaces the old one by name anyway.
   */
  async restart(id: string): Promise<Task> {
    const { execution } = this.#tasks.get(id);
    const restarted = this.#tasks.update(id, 'user', restartTask);
    if (execution !== undefined) await this.#runtime.remove(execution.id);
    return restarted;
  }

  /**
   * Removes a task in any status, stopping its execution server first. Refused
   * while a task that has not started depends on it, which would wait forever.
   */
  async delete(id: string): Promise<void> {
    const { execution } = this.#tasks.get(id);
    assertDeletable(id, this.#tasks.list());
    if (execution !== undefined) await this.#runtime.remove(execution.id);
    this.#tasks.delete(id);
  }

  /**
   * Moves a task before `beforeId`, or to the bottom; returns the tasks of its
   * project in their new order. Ranks are global, so dispatch order holds across projects.
   */
  move(id: string, beforeId?: string): Task[] {
    this.#tasks.saveRanks(moveTask(this.#tasks.list(), id, beforeId));
    return this.#tasks.listByProject(this.#tasks.get(id).projectId);
  }

  /** `byReviewer` marks an answer the input reviewer gives on the engineer's behalf. */
  answer(id: string, questionId: string, answer: string[], byReviewer?: ReviewerNote): Task {
    return this.#tasks.update(id, actorOf(byReviewer), (task) => answerQuestion(task, questionId, answer, byReviewer));
  }

  /** `byReviewer` marks a review the input reviewer gives on the engineer's behalf. */
  review(id: string, itemId: string, review: Review, byReviewer?: ReviewerNote): Task {
    return this.#tasks.update(id, actorOf(byReviewer), (task) => reviewItem(task, itemId, review, byReviewer));
  }

  /** Queues a message for the agent; the dispatcher notifies the execution server if it is idle. */
  addFollowUp(id: string, message: string): Task {
    return this.#tasks.update(id, 'user', (task) =>
      addFollowUp(task, { id: this.#tasks.newItemId('f'), createdAt: this.#tasks.now(), message }),
    );
  }

  /** Where to open the agent's web console of a task's running execution server, and how to sign in. */
  agentConsole(id: string): { url: string; username: string; password: string } {
    const console = agentConsoleOf(this.#tasks.get(id));
    // opencode fixes the user name of its Basic auth.
    return { url: console.url, username: 'opencode', password: console.password };
  }
}

const actorOf = (byReviewer: ReviewerNote | undefined): ChangeActor => (byReviewer ? 'reviewer' : 'user');

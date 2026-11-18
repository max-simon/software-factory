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
  type ActivityEntry,
  type ChangeAuthor,
  type ExecutionRuntime,
  type NewTask,
  type Principal,
  type Responder,
  type Review,
  type ReviewerNote,
  type Task,
  type TaskEdit,
} from '@factory/core';
import type { ActivityFeed } from './activity-feed.ts';
import type { TaskStore } from './task-store.ts';

export interface TaskServiceDeps {
  tasks: TaskStore;
  activity: ActivityFeed;
  runtime: ExecutionRuntime;
  newId?: () => string;
}

/** The input reviewer answering or reviewing on the engineer's behalf, with why. */
export interface ByReviewer {
  reviewer: ReviewerNote;
}

/**
 * What the engineer does with tasks, through the web UI or the MCP server; hooks act on their behalf.
 * Every change takes the `Principal` who makes it, so the task and its changelog record the user's id.
 */
export class TaskService {
  readonly #tasks: TaskStore;
  readonly #activity: ActivityFeed;
  readonly #runtime: ExecutionRuntime;
  readonly #newId: () => string;

  constructor(deps: TaskServiceDeps) {
    this.#tasks = deps.tasks;
    this.#activity = deps.activity;
    this.#runtime = deps.runtime;
    this.#newId = deps.newId ?? (() => randomBytes(5).toString('hex'));
  }

  create(input: NewTask, by: Principal): Task {
    const all = this.#tasks.list();
    const task = createTask(input, { id: this.#newId(), now: this.#tasks.now(), rank: nextRank(all), createdBy: by.userId });
    assertValidDependencies(task, task.dependsOn, all);
    this.#tasks.insert(task, by);
    return task;
  }

  edit(id: string, edit: TaskEdit, by: Principal): Task {
    return this.#tasks.update(id, by, (task) => editTask(task, edit, this.#tasks.list()));
  }

  start(id: string, by: Principal): Task {
    return this.#tasks.update(id, by, startTask);
  }

  /** `reviewer` when the spec reviewer holds the task on the engineer's behalf. */
  requestClarification(id: string, note: string, by: Principal | 'reviewer'): Task {
    return this.#tasks.update(id, by, (task) => requestClarification(task, note));
  }

  returnToDraft(id: string, by: Principal): Task {
    return this.#tasks.update(id, by, returnToDraft);
  }

  /**
   * Fails a queued or running task and removes its execution server. The task
   * is saved first, so the dispatcher does not report the removed server as a
   * crash and the dying runner cannot change the task.
   */
  async cancel(id: string, by: Principal): Promise<Task> {
    const { execution } = this.#tasks.get(id);
    const cancelled = this.#tasks.update(id, by, cancelTask);
    if (execution !== undefined) await this.#runtime.remove(execution.id);
    return cancelled;
  }

  /**
   * Queues a started task again from its specification. The old execution
   * server is removed after the task is saved; if the dispatcher starts the new
   * one first, that replaces the old one by name anyway.
   */
  async restart(id: string, by: Principal): Promise<Task> {
    const { execution } = this.#tasks.get(id);
    const restarted = this.#tasks.update(id, by, restartTask);
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

  /** `by` is the answering user, or the input reviewer answering on the engineer's behalf. */
  answer(id: string, questionId: string, answer: string[], by: Principal | ByReviewer): Task {
    return this.#tasks.update(id, authorOf(by), (task) => answerQuestion(task, questionId, answer, responderOf(by)));
  }

  /** `by` is the reviewing user, or the input reviewer reviewing on the engineer's behalf. */
  review(id: string, itemId: string, review: Review, by: Principal | ByReviewer): Task {
    return this.#tasks.update(id, authorOf(by), (task) => reviewItem(task, itemId, review, responderOf(by)));
  }

  /** Queues a message for the agent; the dispatcher notifies the execution server if it is idle. */
  addFollowUp(id: string, message: string, by: Principal): Task {
    return this.#tasks.update(id, by, (task) =>
      addFollowUp(task, { id: this.#tasks.newItemId('f'), createdAt: this.#tasks.now(), message, authorId: by.userId }),
    );
  }

  /** Where to open the agent's web console of a task's running execution server, and how to sign in. */
  agentConsole(id: string): { url: string; username: string; password: string } {
    const console = agentConsoleOf(this.#tasks.get(id));
    // opencode fixes the user name of its Basic auth.
    return { url: console.url, username: 'opencode', password: console.password };
  }

  /** What the agent did in its current turn, oldest first. */
  activity(id: string): ActivityEntry[] {
    this.#tasks.get(id);
    return this.#activity.list(id);
  }
}

const isReviewer = (by: Principal | ByReviewer): by is ByReviewer => 'reviewer' in by;

const authorOf = (by: Principal | ByReviewer): ChangeAuthor => (isReviewer(by) ? 'reviewer' : by);

// Only the id goes into the task: `via` is how the user signed in, not who they are.
const responderOf = (by: Principal | ByReviewer): Responder => (isReviewer(by) ? by : { userId: by.userId });

import { randomBytes } from 'node:crypto';
import {
  changeMeta,
  pullRequestEvents,
  taskChanges,
  type ChangeAuthor,
  type Heartbeat,
  type Task,
  type TaskChange,
  type TaskEvent,
  type TaskRepository,
  type TaskStatus,
} from '@factory/core';

export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

export interface TaskStoreDeps {
  repository: TaskRepository;
  /** Receives every created or updated task once it is saved; must not throw. */
  onEvent?: (event: TaskEvent) => void;
  now?: () => string;
  /** A new id for a question (`q`), decision (`d`), artifact (`a`) or follow-up (`f`) of a task. */
  newItemId?: (prefix: ItemPrefix) => string;
}

export type ItemPrefix = 'q' | 'd' | 'a' | 'f';

// Random, not counted: a restart empties the task's lists, and a hook still
// holding an item id of the earlier run must not hit an item of the new one.
const randomItemId = (prefix: ItemPrefix): string => `${prefix}-${randomBytes(4).toString('hex')}`;

/**
 * Reads tasks, and saves them for the services: every change is applied as one
 * core operation, saved with its changelog, then published. The services
 * decide which change; the store is what they share.
 */
export class TaskStore {
  readonly #repository: TaskRepository;
  readonly #onEvent: (event: TaskEvent) => void;
  readonly now: () => string;
  readonly newItemId: (prefix: ItemPrefix) => string;

  constructor(deps: TaskStoreDeps) {
    this.#repository = deps.repository;
    this.#onEvent = deps.onEvent ?? (() => {});
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newItemId = deps.newItemId ?? randomItemId;
  }

  get(id: string): Task {
    const task = this.#repository.get(id);
    if (!task) throw new NotFoundError(`task ${id} not found`);
    return task;
  }

  /** All tasks, or only those in one of `statuses`, in rank order. */
  list(statuses?: readonly TaskStatus[]): Task[] {
    return this.#repository.list(statuses);
  }

  /** The project's tasks in rank order; the caller checks that the project exists. */
  listByProject(projectId: string): Task[] {
    return this.list().filter((task) => task.projectId === projectId);
  }

  /** Who changed title, specification, labels or status of a task, and when; oldest first. */
  changes(id: string): TaskChange[] {
    this.get(id);
    return this.#repository.listChanges(id);
  }

  findByTokenHash(tokenHash: string): Task | undefined {
    return this.#repository.findByTokenHash(tokenHash);
  }

  findByExternalUrl(url: string): Task | undefined {
    return this.#repository.findByExternalUrl(url);
  }

  /** `by` is the user who created the task, or `system` for a managed task the control plane imported. */
  insert(task: Task, by: ChangeAuthor): void {
    this.#repository.insert(task, [{ ...changeMeta(task.createdAt, by), field: 'created' }]);
    this.#onEvent({ type: 'task.created', task });
  }

  /**
   * Loads the task, applies `operation`, stamps `updatedAt`, saves it with its
   * changelog and publishes it, followed by what changed on its pull requests.
   * A change `by` a user records the user's id, never a name.
   */
  update(id: string, by: ChangeAuthor, operation: (task: Task) => Task): Task {
    const current = this.get(id);
    const now = this.now();
    const next = { ...operation(current), updatedAt: now };
    const meta = changeMeta(now, by);
    const changes = taskChanges(current, next, meta);
    this.#repository.save(next, changes);
    const { actor, userId } = meta;
    this.#onEvent({ type: 'task.updated', task: next, actor, ...(userId !== undefined && { userId }), changes });
    pullRequestEvents(current, next).forEach((event) => this.#onEvent(event));
    return next;
  }

  /** Board bookkeeping, not a change to the tasks: no changelog, no event, `updatedAt` stays. */
  saveRanks(tasks: readonly Task[]): void {
    tasks.forEach((task) => this.#repository.save(task));
  }

  /**
   * A heartbeat is a sign of life, not a change to the task: `updatedAt` stays,
   * or every running task would look freshly updated and the board would
   * reorder finished tasks by when their runner last spoke.
   */
  saveHeartbeat(id: string, heartbeat: Heartbeat): void {
    this.#repository.saveHeartbeat(id, heartbeat);
  }

  delete(id: string): void {
    this.#repository.delete(id);
  }
}

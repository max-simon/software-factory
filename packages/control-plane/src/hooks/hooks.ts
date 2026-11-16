import type { Task, TaskEvent } from '@factory/core';
import { NotFoundError, type TaskStore } from '../task-store.ts';

/** Reacts to task events. Each hook picks the events it cares about and ignores the rest. */
export interface Hook {
  /** Names the hook in logs. */
  readonly name: string;
  handle(event: TaskEvent): Promise<void>;
}

/**
 * Hands every event to every hook in the background. The caller has already
 * saved the task and never waits for a hook, so a slow or failing hook delays
 * no request and affects no other hook. Hooks run in memory: one still running
 * when the control plane stops is lost.
 */
export class Hooks {
  readonly #hooks: Hook[] = [];
  readonly #log: (message: string) => void;

  constructor(log: (message: string) => void = (message) => console.error(message)) {
    this.#log = log;
  }

  /** Hooks receive the events emitted after they were registered. */
  register(hook: Hook): void {
    this.#hooks.push(hook);
  }

  /** Returns once every hook has run; the publisher ignores that, tests await it. */
  emit(event: TaskEvent): Promise<void> {
    return Promise.all(
      this.#hooks.map((hook) =>
        // Deferred, so a hook never runs inside the publisher's call, even if it throws synchronously.
        Promise.resolve()
          .then(() => hook.handle(event))
          .catch((error: unknown) => this.#log(`hook ${hook.name} failed on ${event.type} of task ${event.task.id}: ${describe(error)}`)),
      ),
    ).then(() => {});
  }
}

export const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The task as saved now, or nothing once it was deleted: hooks run after the event, so it may be gone. */
export function findTask(tasks: Pick<TaskStore, 'get'>, id: string): Task | undefined {
  try {
    return tasks.get(id);
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
}

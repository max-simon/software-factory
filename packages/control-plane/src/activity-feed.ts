import type { ActivityEntry } from '@factory/core';

const maxEntriesPerTask = 300;
const maxTasks = 50;

/**
 * What the agents did in their latest turn, for the engineer to follow live
 * and to look back on once the task has finished. It is not worth storing: it
 * lives in memory, dies with the process and starts over with every turn
 * (`startTurn` is the only reset; finishing a task keeps its entries). Bounded
 * in entries per task and in tasks, so finished or deleted tasks need no
 * cleanup: the least recently active task is dropped first.
 */
export class ActivityFeed {
  readonly #turns = new Map<string, ActivityEntry[]>();

  /** Forgets the task's earlier turn. */
  startTurn(taskId: string): void {
    this.#put(taskId, []);
  }

  append(taskId: string, entries: readonly ActivityEntry[]): void {
    this.#put(taskId, [...(this.#turns.get(taskId) ?? []), ...entries].slice(-maxEntriesPerTask));
  }

  /** Oldest first; empty for a task with no activity since its turn or the process started. */
  list(taskId: string): ActivityEntry[] {
    return [...(this.#turns.get(taskId) ?? [])];
  }

  // A map iterates in insertion order, so re-inserting makes the first key the least recently active task.
  #put(taskId: string, entries: ActivityEntry[]): void {
    this.#turns.delete(taskId);
    this.#turns.set(taskId, entries);
    if (this.#turns.size > maxTasks) this.#turns.delete(this.#turns.keys().next().value!);
  }
}

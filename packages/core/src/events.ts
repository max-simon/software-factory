import type { ChangeActor, TaskChange } from './changelog.ts';
import type { Task } from './task.ts';

/** What happened to a task, published after the task was saved. */
export type TaskEvent =
  | { type: 'task.created'; task: Task }
  | {
      type: 'task.updated';
      /** As saved. */
      task: Task;
      actor: ChangeActor;
      /** The changelog entries of this update; empty when no tracked field changed. */
      changes: TaskChange[];
    };

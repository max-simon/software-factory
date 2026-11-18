import type { Project } from './project.ts';
import type { Task, TaskStatus } from './task.ts';
import type { Principal } from './user.ts';

/**
 * Who made a change: `user` the engineer through the engineer API, `agent` the
 * coding agent or its runner through the agent API, `reviewer` the reviewer
 * acting on the engineer's behalf, `system` the control plane itself (the dispatcher).
 */
export type ChangeActor = 'user' | 'agent' | 'reviewer' | 'system';

export interface ChangeMeta {
  at: string;
  actor: ChangeActor;
  /**
   * The id of the user who made the change, never a name, so renaming a user
   * changes no record. Set exactly when `actor` is `user`; entries stored
   * before users existed lack it.
   */
  userId?: string;
}

/** Who acts: a signed-in user, or one of the actors that are no person. */
export type ChangeAuthor = Principal | Exclude<ChangeActor, 'user'>;

/** The changelog entry header for a change `by` makes at `at`. */
export const changeMeta = (at: string, by: ChangeAuthor): ChangeMeta =>
  typeof by === 'string' ? { at, actor: by } : { at, actor: 'user', userId: by.userId };

export type TaskChange = ChangeMeta &
  (
    | { field: 'created' }
    | { field: 'title' | 'specification'; from: string; to: string }
    | { field: 'labels' | 'dependsOn'; from: string[]; to: string[] }
    | { field: 'status'; from: TaskStatus; to: TaskStatus }
  );

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((label, i) => label === b[i]);

/** The tracked fields `after` changed relative to `before`, in a fixed field order. */
export function taskChanges(before: Task, after: Task, meta: ChangeMeta): TaskChange[] {
  const changes: TaskChange[] = [];
  if (before.title !== after.title) changes.push({ ...meta, field: 'title', from: before.title, to: after.title });
  if (before.specification !== after.specification) {
    changes.push({ ...meta, field: 'specification', from: before.specification, to: after.specification });
  }
  if (!sameList(before.labels, after.labels)) {
    changes.push({ ...meta, field: 'labels', from: [...before.labels], to: [...after.labels] });
  }
  if (!sameList(before.dependsOn, after.dependsOn)) {
    changes.push({ ...meta, field: 'dependsOn', from: [...before.dependsOn], to: [...after.dependsOn] });
  }
  if (before.status !== after.status) changes.push({ ...meta, field: 'status', from: before.status, to: after.status });
  return changes;
}

export type ProjectChange = ChangeMeta &
  (
    | { field: 'created' }
    | { field: 'title' | 'description'; from: string; to: string }
    | { field: 'autoMerge'; from: boolean; to: boolean }
  );

/** The tracked fields `after` changed relative to `before`, in a fixed field order. */
export function projectChanges(before: Project, after: Project, meta: ChangeMeta): ProjectChange[] {
  const changes: ProjectChange[] = [];
  if (before.title !== after.title) changes.push({ ...meta, field: 'title', from: before.title, to: after.title });
  if (before.description !== after.description) {
    changes.push({ ...meta, field: 'description', from: before.description, to: after.description });
  }
  if (before.autoMerge !== after.autoMerge) {
    changes.push({ ...meta, field: 'autoMerge', from: before.autoMerge, to: after.autoMerge });
  }
  return changes;
}

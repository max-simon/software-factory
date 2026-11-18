import { DomainError } from './errors.ts';
import type { Task } from './task.ts';
import type { User } from './user.ts';

/**
 * The requested assignees, once each is a user who may be assigned; `users`
 * holds the users the repository found among `requested`. A disabled user
 * stays assignable while already assigned, so removing someone else does not
 * fail on them; newly assigning one is refused.
 */
export function checkAssignees(
  current: readonly string[],
  requested: readonly string[],
  users: ReadonlyMap<string, User>,
): readonly string[] {
  for (const id of requested) {
    const user = users.get(id);
    if (user === undefined) throw new DomainError('unknown_user', `user ${id} does not exist`);
    if (user.disabledAt !== undefined && !current.includes(id)) {
      throw new DomainError('user_disabled', `user ${id} is disabled and cannot be assigned`);
    }
  }
  return requested;
}

/** Replaces the assignees in any status; repeated ids count once, in first-seen order, and none removes the field. */
export function setAssignees(task: Task, ids: readonly string[]): Task {
  const { assignees: _replaced, ...rest } = task;
  const assignees = [...new Set(ids)];
  return assignees.length === 0 ? rest : { ...rest, assignees };
}

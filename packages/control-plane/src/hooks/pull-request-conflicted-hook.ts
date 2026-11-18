import type { TaskEvent } from '@factory/core';
import type { LifecycleService } from '../lifecycle-service.ts';
import type { Hook } from './hooks.ts';

/** The executor image installs the skill under this name; see packages/executor/skills. */
export const resolveConflictSkill = 'resolve-merge-conflict';

/** `baseBranch` is unset for a pull request recorded before the control plane read base branches. */
export function conflictFollowUp(pullRequestUrl: string, baseBranch?: string): string {
  const base = baseBranch === undefined ? 'its base branch' : `its base branch \`${baseBranch}\``;
  return [`${pullRequestUrl} has merge conflicts with ${base}.`, `Use the \`${resolveConflictSkill}\` skill to resolve them.`].join('\n');
}

/**
 * Hands a merge conflict of one of a task's pull requests with its base branch
 * to its agent as a follow-up, which resumes a ready or failed task, like a
 * review does: the agent that wrote the pull request knows best how its side
 * of the conflict should end up. A task that cannot take follow-ups any more
 * fails the hook, which is logged.
 */
export class PullRequestConflictedHook implements Hook {
  readonly name = 'pull-request-conflicted';
  readonly #lifecycle: Pick<LifecycleService, 'addFollowUp'>;

  constructor(deps: { lifecycle: Pick<LifecycleService, 'addFollowUp'> }) {
    this.#lifecycle = deps.lifecycle;
  }

  async handle(event: TaskEvent): Promise<void> {
    if (event.type !== 'pull_request.conflicted') return;
    this.#lifecycle.addFollowUp(event.task.id, conflictFollowUp(event.pullRequest.url, event.pullRequest.baseBranch));
  }
}

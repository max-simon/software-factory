import type { PullRequestReview, TaskEvent } from '@factory/core';
import type { LifecycleService } from '../lifecycle-service.ts';
import type { Hook } from './hooks.ts';

/** The executor image installs the skill under this name; see packages/executor/skills. */
export const addressReviewSkill = 'address-pr-review';

const states: Record<PullRequestReview['state'], string> = {
  approved: 'approved',
  changes_requested: 'changes requested',
  commented: 'commented',
};

/** An approval without a body asks for nothing; one with only inline comments is missed, since `read` lists reviews, not their comments. */
const asksForWork = (review: PullRequestReview): boolean => review.state !== 'approved' || review.body.trim() !== '';

export function reviewFollowUp(pullRequestUrl: string, review: PullRequestReview): string {
  return [
    `@${review.author} submitted a review (${states[review.state]}) on ${pullRequestUrl}: ${review.url}`,
    `Use the \`${addressReviewSkill}\` skill to address review ${review.id}.`,
  ].join('\n');
}

/**
 * Hands a review submitted on one of a task's pull requests to its agent as a
 * follow-up, which resumes a ready or failed task. The task's own agent
 * addresses it, in the session that wrote the pull request. A task that cannot
 * take follow-ups any more (its execution server is gone) fails the hook, which
 * is logged.
 */
export class PullRequestReviewedHook implements Hook {
  readonly name = 'pull-request-reviewed';
  readonly #lifecycle: Pick<LifecycleService, 'addFollowUp'>;

  constructor(deps: { lifecycle: Pick<LifecycleService, 'addFollowUp'> }) {
    this.#lifecycle = deps.lifecycle;
  }

  async handle(event: TaskEvent): Promise<void> {
    if (event.type !== 'pull_request.reviewed' || !asksForWork(event.review)) return;
    this.#lifecycle.addFollowUp(event.task.id, reviewFollowUp(event.pullRequest.url, event.review));
  }
}

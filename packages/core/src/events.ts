import type { ChangeActor, TaskChange } from './changelog.ts';
import type { PullRequest, PullRequestReview, Task } from './task.ts';

/** What happened to a task, published after the task was saved. */
export type TaskEvent =
  | { type: 'task.created'; task: Task }
  | {
      type: 'task.updated';
      /** As saved. */
      task: Task;
      actor: ChangeActor;
      /** The id of the user who made the update; set exactly when `actor` is `user`. */
      userId?: string;
      /** The changelog entries of this update; empty when no tracked field changed. */
      changes: TaskChange[];
    }
  | PullRequestEvent;

/**
 * What happened to one of a task's pull requests on its host, published after
 * the task recorded it. `task` and `pullRequest` are as saved.
 */
export type PullRequestEvent =
  | { type: 'pull_request.reviewed'; task: Task; pullRequest: PullRequest; review: PullRequestReview }
  /** Its head moved to `pullRequest.headSha`. */
  | { type: 'pull_request.pushed'; task: Task; pullRequest: PullRequest }
  /** It newly conflicts with its base branch. */
  | { type: 'pull_request.conflicted'; task: Task; pullRequest: PullRequest }
  | { type: 'pull_request.merged'; task: Task; pullRequest: PullRequest }
  | { type: 'pull_request.closed'; task: Task; pullRequest: PullRequest };

/**
 * The pull request events between two saved versions of a task, derived from
 * what was recorded, so they do not depend on how it was learned (polling or a
 * webhook). Pull requests new to the task, or gone from it, raise none.
 */
export function pullRequestEvents(before: Task, after: Task): PullRequestEvent[] {
  return after.pullRequests.flatMap((pullRequest) => {
    const previous = before.pullRequests.find((pr) => pr.url === pullRequest.url);
    return previous === undefined ? [] : eventsOf(after, previous, pullRequest);
  });
}

function eventsOf(task: Task, before: PullRequest, after: PullRequest): PullRequestEvent[] {
  const events: PullRequestEvent[] = [];
  // An unknown head is the first read, not a push.
  if (before.headSha !== undefined && after.headSha !== undefined && after.headSha !== before.headSha) {
    events.push({ type: 'pull_request.pushed', task, pullRequest: after });
  }
  // Unread reviews count as new: the first read follows right after the agent reported the pull request.
  const known = new Set(before.reviews?.map((review) => review.id));
  for (const review of after.reviews ?? []) {
    if (!known.has(review.id)) events.push({ type: 'pull_request.reviewed', task, pullRequest: after, review });
  }
  // Only a conflict found anew counts: one already reported stays known until the host clears it.
  if (after.status === 'open' && before.hasConflicts !== true && after.hasConflicts === true) {
    events.push({ type: 'pull_request.conflicted', task, pullRequest: after });
  }
  if (before.status === 'open' && after.status !== 'open') {
    events.push({ type: `pull_request.${after.status}`, task, pullRequest: after });
  }
  return events;
}

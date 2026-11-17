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
  if (before.status === 'open' && after.status !== 'open') {
    events.push({ type: `pull_request.${after.status}`, task, pullRequest: after });
  }
  return events;
}

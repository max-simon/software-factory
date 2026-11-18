import { type PullRequest, type PullRequestReader, type Task, type TaskStatus } from '@factory/core';
import { describe } from './hooks/hooks.ts';
import type { LifecycleService } from './lifecycle-service.ts';
import { redact } from './redact.ts';
import type { TaskStore } from './task-store.ts';

export interface PullRequestObserverDeps {
  tasks: Pick<TaskStore, 'list'>;
  lifecycle: Pick<LifecycleService, 'updatePullRequests'>;
  pullRequests: PullRequestReader;
  /** Secret values to strip from logged errors. */
  secrets: readonly string[];
  log?: (message: string) => void;
}

// Pull requests stay open for hours or days; GitHub's rate limit is per hour.
export const pullRequestPollIntervalMs = 60_000;

/** Statuses whose pull requests may still change: the agent may push, reviewers may review. */
const watchedStatuses: readonly TaskStatus[] = ['in_progress', 'input_required', 'ready', 'failed'];
/** A failed task's pull requests are watched only while a follow-up can still resume its agent. */
const isWatched = (task: Task): boolean =>
  (task.status !== 'failed' || task.execution !== undefined) && task.pullRequests.some((pr) => pr.status === 'open');
const reviewIds = (pr: PullRequest): string | undefined => pr.reviews?.map((review) => review.id).join();
const hasChanged = (before: PullRequest, after: PullRequest): boolean =>
  after.status !== before.status ||
  after.title !== before.title ||
  after.headSha !== before.headSha ||
  reviewIds(after) !== reviewIds(before) ||
  after.baseBranch !== before.baseBranch ||
  // Unknown mergeability is GitHub still computing it, not a change; the recorded one is kept.
  (after.hasConflicts !== undefined && after.hasConflicts !== before.hasConflicts);

/**
 * Polls the open pull requests of watched tasks and records what changed; the
 * task store derives the pull request events from the recorded change. It is
 * the only source of pull request state, so a GitHub webhook can replace it:
 * the webhook records the same changes through `LifecycleService.updatePullRequests`
 * and this observer is no longer run.
 */
export class PullRequestObserver {
  readonly #deps: PullRequestObserverDeps;
  readonly #log: (message: string) => void;

  constructor(deps: PullRequestObserverDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? ((message) => console.error(message));
  }

  /** One poll of every watched task; one failing task does not stop the others. */
  async observe(): Promise<void> {
    for (const task of this.#deps.tasks.list(watchedStatuses).filter(isWatched)) {
      try {
        await this.#observe(task);
      } catch (error) {
        this.#log(`pull request observer: task ${task.id}: ${redact(describe(error), this.#deps.secrets)}`);
      }
    }
  }

  async #observe(task: Task): Promise<void> {
    const open = task.pullRequests.filter((pr) => pr.status === 'open');
    const current = await Promise.all(open.map((pr) => this.#deps.pullRequests.read(pr.url)));
    const changed = current.filter((pr, i) => hasChanged(open[i]!, pr));
    if (changed.length > 0) this.#deps.lifecycle.updatePullRequests(task.id, changed);
  }
}

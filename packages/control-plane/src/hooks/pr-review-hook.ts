import type { PrReview, PrReviewOutcome, PrReviewRequest, PullRequestWriter, Reviewer, Task, TaskEvent } from '@factory/core';
import type { LifecycleService } from '../lifecycle-service.ts';
import type { ProjectService } from '../project-service.ts';
import { ReviewTracker } from '../review-tracker.ts';
import type { TaskStore } from '../task-store.ts';
import { describe, findTask, type Hook } from './hooks.ts';

export interface PrReviewHookDeps {
  /** Read again before a decision is posted or merged: the task may have moved on during the review. */
  tasks: Pick<TaskStore, 'get'>;
  /** Records each outcome, and once a run is over, whether the task needs the engineer. */
  lifecycle: Pick<LifecycleService, 'recordPrReview' | 'requireInputForPullRequests'>;
  pullRequests: PullRequestWriter;
  reviewer: Pick<Reviewer, 'reviewPr'>;
  projects: ProjectService;
  /** Where the running reviews show; a hook of its own when unset. */
  reviews?: ReviewTracker;
  log?: (message: string) => void;
}

/** A task that turns ready has finished its work, so its pull requests no longer change under the review. */
export function triggersPrReview(event: TaskEvent): boolean {
  return event.type === 'task.updated' && event.task.status === 'ready' && event.changes.some((change) => change.field === 'status');
}

export function decisionComment({ risk, comment }: PrReview, isMerging: boolean): string {
  const heading =
    risk !== 'low'
      ? `**PR review: ${risk} risk.** Left open for a human review.`
      : isMerging
        ? '**PR review: low risk.** Merging without a human review.'
        : '**PR review: low risk.** Auto-merge is off for this project, so it is left open for a human.';
  return `${heading}\n\n${comment.trim()}`;
}

const unreviewedComment = "**PR review failed.** The pull request is left open for a human review; the factory's log has the cause.";

const unmergedComment = '**PR review did not merge this pull request.** Its task changed while the decision was posted; it is left open for a human review.';

/**
 * Lets the reviewer judge the risk of each open pull request of a task once
 * the task turns ready. It always comments its decision on the pull request,
 * and merges the low-risk ones if the project has auto-merge on; the
 * dispatcher then reads them as merged and marks the task done. Anything else
 * stays open for a human: a higher risk, auto-merge off, a failed review, a
 * refused merge. Nothing is retried. Its comments are conversation comments,
 * which the factory never reads back, so a review never resumes the task.
 *
 * It records each outcome on its pull request. Once a run has handled every
 * open pull request, it has the task wait for the engineer (`input_required`)
 * if it left one open; the task moves only if it is still `ready`.
 *
 * A review takes minutes, and the task may move on meanwhile: a follow-up, a
 * cancel or a restart. One run per task goes at a time, and a newer run (the
 * task turned ready again) outdates the running one. A decision is posted, and
 * a pull request merged, only while its run is the latest, the task is still
 * `ready` and the pull request is still one of its open ones; an outdated run
 * moves no task.
 */
export class PrReviewHook implements Hook {
  readonly name = 'pr-review';
  readonly #deps: PrReviewHookDeps;
  readonly #log: (message: string) => void;
  readonly #reviews: ReviewTracker;
  /** Per task, its latest run; an earlier run still going is outdated. */
  readonly #runs = new Map<string, { generation: number; done: Promise<void> }>();
  #generation = 0;

  constructor(deps: PrReviewHookDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? ((message) => console.error(message));
    this.#reviews = deps.reviews ?? new ReviewTracker();
  }

  async handle(event: TaskEvent): Promise<void> {
    if (!triggersPrReview(event)) return;
    const id = event.task.id;
    const generation = ++this.#generation;
    // After the task's previous run, however it ended: each merge moves the base branch the next one merges into.
    const previous = this.#runs.get(id)?.done.catch(() => {}) ?? Promise.resolve();
    const done = previous.then(() => this.#reviewAll(id, generation));
    this.#runs.set(id, { generation, done });
    try {
      await done;
    } finally {
      if (this.#runs.get(id)?.generation === generation) this.#runs.delete(id);
    }
  }

  /** Reviews the open pull requests of the task as saved now, one after another, then settles the task's status. */
  async #reviewAll(id: string, generation: number): Promise<void> {
    const task = findTask(this.#deps.tasks, id);
    if (task === undefined) return;
    for (const { url } of task.pullRequests.filter((pr) => pr.status === 'open')) {
      if (!this.#isCurrent(id, generation, url)) continue;
      await this.#review(task, url, generation).catch((error: unknown) =>
        this.#log(`pr review: cannot review ${url} of task ${id}: ${describe(error)}`),
      );
    }
    if (this.#runs.get(id)?.generation !== generation) return;
    try {
      this.#deps.lifecycle.requireInputForPullRequests(id);
    } catch (error) {
      this.#log(`pr review: cannot have task ${id} wait for its pull requests: ${describe(error)}`);
    }
  }

  /** Whether the run may still act on the pull request: no newer run, the task still ready, the pull request still its own and open. */
  #isCurrent(id: string, generation: number, url: string): boolean {
    if (this.#runs.get(id)?.generation !== generation) return false;
    const task = findTask(this.#deps.tasks, id);
    return task?.status === 'ready' && task.pullRequests.some((pr) => pr.url === url && pr.status === 'open');
  }

  // Shown from reading the head until the decision is commented and any merge is over, however it ends.
  async #review(task: Task, url: string, generation: number): Promise<void> {
    this.#reviews.startPrReview(url);
    try {
      await this.#reviewTracked(task, url, generation);
    } finally {
      this.#reviews.finishPrReview(url);
    }
  }

  async #reviewTracked(task: Task, url: string, generation: number): Promise<void> {
    const { pullRequests, reviewer, projects } = this.#deps;
    let request: PrReviewRequest;
    let review: PrReview;
    try {
      // Read before the reviewer starts: if the agent pushes while it reads,
      // the merge pinned to this commit is refused, so nothing unseen is merged.
      const headSha = await pullRequests.readHead(url);
      request = { task: { title: task.title, specification: task.specification }, pullRequest: { url, headSha } };
      review = await reviewer.reviewPr(request);
    } catch (error) {
      this.#log(`pr review: cannot review ${url} of task ${task.id}: ${describe(error)}`);
      if (!this.#isCurrent(task.id, generation, url)) return;
      this.#record(task.id, url, { result: 'review_failed' });
      await pullRequests.comment(url, unreviewedComment);
      return;
    }
    if (!this.#isCurrent(task.id, generation, url)) {
      this.#log(`pr review: task ${task.id} changed while ${url} was reviewed; the decision is dropped`);
      return;
    }
    const { risk } = review;
    // Read once the review is done, so a switch the engineer made meanwhile counts.
    const isMerging = risk === 'low' && projects.get(task.projectId).autoMerge;
    if (!isMerging) {
      // Recorded first, so a comment that fails still leaves the pull request to the engineer.
      this.#record(task.id, url, { result: risk === 'low' ? 'auto_merge_off' : 'risky', risk });
      await pullRequests.comment(url, decisionComment(review, false));
      return;
    }
    // Commented first, so no pull request is merged without its reason on it.
    try {
      await pullRequests.comment(url, decisionComment(review, true));
    } catch (error) {
      this.#record(task.id, url, { result: 'review_failed', risk });
      throw error;
    }
    // Checked again: the task may have changed while the comment was posted.
    if (!this.#isCurrent(task.id, generation, url)) {
      this.#log(`pr review: task ${task.id} changed while the decision on ${url} was posted; not merged`);
      this.#record(task.id, url, { result: 'merge_dropped', risk });
      await pullRequests.comment(url, unmergedComment);
      return;
    }
    try {
      await pullRequests.merge(url, request.pullRequest.headSha);
    } catch (error) {
      this.#log(`pr review: cannot merge ${url} of task ${task.id}: ${describe(error)}`);
      this.#record(task.id, url, { result: 'merge_refused', risk });
      await pullRequests.comment(url, `**PR review could not merge this pull request.** It is left open for a human review.\n\n> ${describe(error)}`);
      return;
    }
    // A merged pull request stays open in the task until the control plane reads it again; this keeps it from counting as left open.
    this.#record(task.id, url, { result: 'merged', risk });
  }

  /** A task restarted or finished meanwhile no longer takes the outcome; that is no reason to stop the review. */
  #record(id: string, url: string, outcome: Omit<PrReviewOutcome, 'reviewedAt'>): void {
    try {
      this.#deps.lifecycle.recordPrReview(id, url, outcome);
    } catch (error) {
      this.#log(`pr review: cannot record the review of ${url} of task ${id}: ${describe(error)}`);
    }
  }
}

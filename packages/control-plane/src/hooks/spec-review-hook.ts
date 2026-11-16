import type { Project, Reviewer, SpecReviewRequest, Task, TaskEvent } from '@factory/core';
import type { ProjectService } from '../project-service.ts';
import type { TaskService } from '../task-service.ts';
import { ReviewTracker } from '../review-tracker.ts';
import type { TaskStore } from '../task-store.ts';
import { describe, findTask, type Hook } from './hooks.ts';

export interface SpecReviewHookDeps {
  tasks: TaskStore;
  service: TaskService;
  projects: ProjectService;
  reviewer: Pick<Reviewer, 'reviewSpec'>;
  /** Where the running reviews show; a hook of its own when unset. */
  reviews?: ReviewTracker;
  log?: (message: string) => void;
}

/**
 * A draft is reviewed when it is created, when the engineer edits its title,
 * specification or dependencies, and when it returns to draft from a clarification. The
 * reviewer's own clarification request leaves draft, so it triggers nothing.
 */
export function triggersSpecReview(event: TaskEvent): boolean {
  if (event.task.status !== 'draft') return false;
  if (event.type === 'task.created') return true;
  return event.actor === 'user' && event.changes.some((change) => ['title', 'specification', 'dependsOn', 'status'].includes(change.field));
}

export function specReviewRequest(task: Task, project: Project, projectTasks: readonly Task[]): SpecReviewRequest {
  return {
    project: { title: project.title, description: project.description },
    task: {
      title: task.title,
      specification: task.specification,
      labels: task.labels,
      autonomyMode: task.autonomyMode,
      ...(task.repoUrl !== undefined && { repoUrl: task.repoUrl }),
      ...(task.baseBranch !== undefined && { baseBranch: task.baseBranch }),
    },
    otherTasks: projectTasks
      .filter((other) => other.id !== task.id)
      .map(({ id, title, status, labels }) => ({ title, status, labels, isDependency: task.dependsOn.includes(id) })),
  };
}

/**
 * Lets the reviewer judge the specification of draft tasks and holds those it
 * finds unclear or off topic for clarification, with its comment as the note.
 * A task that passes stays a draft: starting it remains the engineer's call.
 */
export class SpecReviewHook implements Hook {
  readonly name = 'spec-review';
  readonly #deps: SpecReviewHookDeps;
  readonly #log: (message: string) => void;
  readonly #reviews: ReviewTracker;
  /** Tasks under review; at most one spec review per task runs at a time. */
  readonly #running = new Set<string>();
  /** Tasks that changed again during their review and need another one. */
  readonly #stale = new Set<string>();

  constructor(deps: SpecReviewHookDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? ((message) => console.error(message));
    this.#reviews = deps.reviews ?? new ReviewTracker();
  }

  async handle(event: TaskEvent): Promise<void> {
    if (!triggersSpecReview(event)) return;
    const id = event.task.id;
    // Reviews take a container and minutes; edits in quick succession get one more run, not one each.
    if (this.#running.has(id)) {
      this.#stale.add(id);
      return;
    }
    this.#running.add(id);
    // Shown for all runs, reruns included, and cleared however they end.
    this.#reviews.startSpecReview(id);
    try {
      do {
        this.#stale.delete(id);
        await this.#review(id).catch((error: unknown) => this.#log(`spec review: cannot review task ${id}: ${describe(error)}`));
      } while (this.#stale.has(id));
    } finally {
      this.#running.delete(id);
      this.#reviews.finishSpecReview(id);
    }
  }

  async #review(id: string): Promise<void> {
    const { tasks, projects, reviewer } = this.#deps;
    const task = findTask(this.#deps.tasks, id);
    if (task?.status !== 'draft') return;
    const project = projects.get(task.projectId);
    const review = await reviewer.reviewSpec(specReviewRequest(task, project, tasks.listByProject(project.id)));
    // The verdict concerns the version the reviewer read. Nothing awaits between
    // this check and the save, so no engineer change slips in between.
    const current = findTask(this.#deps.tasks, id);
    if (current?.status !== 'draft' || current.updatedAt !== task.updatedAt) return;
    if (review.verdict === 'ready') return;
    this.#deps.service.requestClarification(id, review.comment, 'reviewer');
  }
}

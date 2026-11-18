import type { InputResponse, InputReviewRequest, Project, Reviewer, Task, TaskEvent } from '@factory/core';
import type { ProjectService } from '../project-service.ts';
import type { TaskService } from '../task-service.ts';
import { ReviewTracker } from '../review-tracker.ts';
import type { TaskStore } from '../task-store.ts';
import { describe, findTask, type Hook } from './hooks.ts';

export interface InputReviewHookDeps {
  tasks: TaskStore;
  service: TaskService;
  projects: ProjectService;
  reviewer: Pick<Reviewer, 'reviewInput'>;
  /** Where the running reviews show; a hook of its own when unset. */
  reviews?: ReviewTracker;
  log?: (message: string) => void;
}

/** Ids of the questions without an answer and the decisions and artifacts awaiting approval. */
export function openInputIds(task: Pick<Task, 'questions' | 'decisions' | 'artifacts'>): string[] {
  return [
    ...task.questions.filter((question) => question.answer === undefined),
    ...[...task.decisions, ...task.artifacts].filter((item) => item.approval?.status === 'pending'),
  ].map((item) => item.id);
}

/** Only the agent adds input requests; the engineer's own changes never ask for a review. */
export function triggersInputReview(event: TaskEvent): boolean {
  return event.type === 'task.updated' && event.actor === 'agent' && event.task.status === 'input_required';
}

export function inputReviewRequest(task: Task, project: Project, openIds: readonly string[]): InputReviewRequest {
  return {
    project: { title: project.title, description: project.description },
    task: {
      title: task.title,
      specification: task.specification,
      ...(task.repoUrl !== undefined && { repoUrl: task.repoUrl }),
      ...(task.baseBranch !== undefined && { baseBranch: task.baseBranch }),
      plan: task.plan,
      questions: task.questions,
      decisions: task.decisions,
      artifacts: task.artifacts,
      pullRequests: task.pullRequests.map(({ url, title, status }) => ({ url, title, status })),
    },
    openIds: [...openIds],
  };
}

/**
 * Lets the reviewer stand in for the engineer when a supervised agent asks for
 * input. It decides per open question or approval request whether it can give
 * the input itself; what it gives is applied at once and marked as its own,
 * the rest stays with the engineer. Each item is reviewed once, and a failed
 * review leaves all of its items to the engineer.
 */
export class InputReviewHook implements Hook {
  readonly name = 'input-review';
  readonly #deps: InputReviewHookDeps;
  readonly #log: (message: string) => void;
  readonly #reviews: ReviewTracker;
  /** Per task waiting for input, the items already handed to the reviewer. */
  readonly #seen = new Map<string, Set<string>>();
  /** Tasks under review; at most one input review per task runs at a time. */
  readonly #running = new Set<string>();
  /** Tasks that got new input requests during their review and need another one. */
  readonly #stale = new Set<string>();

  constructor(deps: InputReviewHookDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? ((message) => console.error(message));
    this.#reviews = deps.reviews ?? new ReviewTracker();
  }

  async handle(event: TaskEvent): Promise<void> {
    const id = event.task.id;
    // Item ids restart with the task, so what was seen ends with the wait for input.
    if (event.task.status !== 'input_required') this.#seen.delete(id);
    if (!triggersInputReview(event)) return;
    // An agent may ask several questions in one turn; each that arrives while a review runs gets one more run.
    if (this.#running.has(id)) {
      this.#stale.add(id);
      return;
    }
    this.#running.add(id);
    this.#reviews.startInputReview(id);
    try {
      do {
        this.#stale.delete(id);
        await this.#review(id).catch((error: unknown) => this.#log(`input review: cannot review task ${id}: ${describe(error)}`));
      } while (this.#stale.has(id));
    } finally {
      this.#running.delete(id);
      this.#reviews.finishInputReview(id);
    }
  }

  async #review(id: string): Promise<void> {
    const task = findTask(this.#deps.tasks, id);
    if (task?.status !== 'input_required') return;
    const seen = this.#seen.get(id) ?? new Set<string>();
    this.#seen.set(id, seen);
    const openIds = openInputIds(task).filter((itemId) => !seen.has(itemId));
    if (openIds.length === 0) return;
    // Marked before the review, so a failed one is not retried: its items stay with the engineer.
    for (const itemId of openIds) seen.add(itemId);
    const project = this.#deps.projects.get(task.projectId);
    const { responses } = await this.#deps.reviewer.reviewInput(inputReviewRequest(task, project, openIds));
    for (const response of responses) {
      if (!openIds.includes(response.id)) {
        this.#log(`input review: task ${id} has no open item ${response.id} the reviewer was asked about`);
        continue;
      }
      // The engineer may have answered meanwhile, or the answer may not fit; either way the item is left as it is.
      try {
        this.#apply(id, response);
      } catch (error) {
        this.#log(`input review: cannot apply the response to ${response.id} of task ${id}: ${describe(error)}`);
      }
    }
  }

  #apply(id: string, response: InputResponse): void {
    const byReviewer = { reviewer: { rationale: response.rationale.trim() } };
    switch (response.action) {
      case 'answer':
        this.#deps.service.answer(id, response.id, response.answer, byReviewer);
        return;
      case 'approve':
      case 'request_changes': {
        const verdict = response.action === 'approve' ? 'approved' : 'changes_requested';
        this.#deps.service.review(id, response.id, { verdict, ...(response.comment !== undefined && { comment: response.comment }) }, byReviewer);
        return;
      }
      case 'leave_to_human':
        return;
    }
  }
}

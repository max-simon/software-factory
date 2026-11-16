import type { Execution, PullRequest, Task } from './task.ts';

// What each audience sees of a task. Execution state is kept apart from the
// task's content, so a view only decides what to show of the execution.

/** The engineer's view of an execution: no token hash, and the console without its password. */
export type ExecutionView = Omit<Execution, 'tokenHash' | 'console'> & { consoleUrl?: string };

/** Which reviews run right now; they live in the control plane's memory, not in the task. */
export interface ReviewState {
  isSpecUnderReview(taskId: string): boolean;
  isInputUnderReview(taskId: string): boolean;
  isPrUnderReview(url: string): boolean;
}

const noReviews: ReviewState = { isSpecUnderReview: () => false, isInputUnderReview: () => false, isPrUnderReview: () => false };

/** The engineer's view of a pull request, with whether the reviewer judges it right now. */
export type PullRequestView = PullRequest & { isUnderReview: boolean };

/**
 * What the engineer API returns. The console password has its own endpoint, so
 * lists and polls do not spread it.
 */
export type TaskView = Omit<Task, 'execution' | 'pullRequests'> & {
  execution?: ExecutionView;
  pullRequests: PullRequestView[];
  isSpecUnderReview: boolean;
  /** The input reviewer decides on the open questions and approval requests right now. */
  isInputUnderReview: boolean;
};

/** What an agent sees of its own task and of the other tasks in its project. */
export type AgentTaskView = Omit<Task, 'execution'>;

/** One line per task when an agent lists the other tasks in its project. */
export type ProjectTaskSummary = Pick<
  Task,
  'id' | 'title' | 'status' | 'labels' | 'repoUrl' | 'baseBranch' | 'pullRequests' | 'updatedAt'
>;

/** Without `reviews`, no review shows as running. */
export function toTaskView({ execution, ...task }: Task, reviews: ReviewState = noReviews): TaskView {
  const view: TaskView = {
    ...task,
    pullRequests: task.pullRequests.map((pr) => ({ ...pr, isUnderReview: reviews.isPrUnderReview(pr.url) })),
    isSpecUnderReview: reviews.isSpecUnderReview(task.id),
    isInputUnderReview: reviews.isInputUnderReview(task.id),
  };
  if (execution === undefined) return view;
  const { tokenHash: _hidden, console, ...shown } = execution;
  return { ...view, execution: { ...shown, ...(console && { consoleUrl: console.url }) } };
}

export function toAgentTaskView({ execution: _hidden, ...task }: Task): AgentTaskView {
  return task;
}

export function toProjectTaskSummary(task: Task): ProjectTaskSummary {
  const { id, title, status, labels, repoUrl, baseBranch, pullRequests, updatedAt } = task;
  return { id, title, status, labels, repoUrl, baseBranch, pullRequests, updatedAt };
}

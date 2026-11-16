import type { Project } from './project.ts';
import type { PullRequest, Task } from './task.ts';

// The reviewer judges three things: a draft task's specification before it may
// start, the input a supervised agent asks for, and a pull request before it
// is merged. Its answers cross a process boundary and come from a model, so
// they are checked here.

/** What the reviewer reads to judge a draft task: the task, its project and the project's other tasks. */
export interface SpecReviewRequest {
  project: Pick<Project, 'title' | 'description'>;
  task: Pick<Task, 'title' | 'specification' | 'labels' | 'autonomyMode' | 'repoUrl' | 'baseBranch'>;
  /**
   * To spot duplicates and conflicts. `isDependency` marks the tasks the
   * reviewed one depends on: it starts only once they are all done.
   */
  otherTasks: Array<Pick<Task, 'title' | 'status' | 'labels'> & { isDependency: boolean }>;
}

/**
 * `ready`: the task fits its project and a coding agent can start on it.
 * `needs_clarification`: `comment` tells the engineer what to clarify.
 */
export type SpecVerdict = 'ready' | 'needs_clarification';

export interface SpecReview {
  verdict: SpecVerdict;
  /** Markdown for the engineer; never empty for `needs_clarification`. */
  comment: string;
}

/** The pull request the reviewer reads itself to judge the risk of merging it without a human. */
export interface PrReviewRequest {
  /** What the agent was asked to do, to judge whether the change matches it. */
  task: Pick<Task, 'title' | 'specification'>;
  pullRequest: {
    url: string;
    /** The head commit when the review started; only this commit is merged. */
    headSha: string;
  };
}

/** Only `low` may be merged without a human, and only in a project with auto-merge on. */
export type RiskLevel = 'low' | 'medium' | 'high';

/** The reviewer's judgement of a pull request; not to be confused with `PullRequestReview`, one a person submitted on GitHub. */
export interface PrReview {
  risk: RiskLevel;
  /** Markdown posted on the pull request: why this level, and for a human reviewer what to check. */
  comment: string;
}

/**
 * A supervised task waiting for input: the whole task as the agent reported it,
 * and which of its open questions and approval requests to decide on.
 */
export interface InputReviewRequest {
  project: Pick<Project, 'title' | 'description'>;
  task: Pick<Task, 'title' | 'specification' | 'repoUrl' | 'baseBranch' | 'plan' | 'questions' | 'decisions' | 'artifacts'> & {
    pullRequests: Array<Pick<PullRequest, 'url' | 'title' | 'status'>>;
  };
  /** Ids of open questions and pending approval requests of `task`; anything else in it is context. */
  openIds: string[];
}

/** What the reviewer does with one open item; `leave_to_human` keeps it for the engineer. */
export type InputAction = 'answer' | 'approve' | 'request_changes' | 'leave_to_human';

/** `rationale` explains the choice to the engineer; the agent never sees it. */
export type InputResponse = { id: string; rationale: string } & (
  | { action: 'answer'; answer: string[] }
  /** `comment` reaches the agent; required to request changes. */
  | { action: 'approve' | 'request_changes'; comment?: string }
  | { action: 'leave_to_human' }
);

/** One response per item the reviewer decided on; items it skipped stay with the engineer. */
export interface InputReview {
  responses: InputResponse[];
}

export function parseSpecReview(value: unknown): SpecReview {
  const { verdict, comment } = fieldsOf(value);
  if (verdict !== 'ready' && verdict !== 'needs_clarification') {
    throw new Error(`the spec review verdict must be ready or needs_clarification, got ${JSON.stringify(verdict)}`);
  }
  if (typeof comment !== 'string') throw new Error('the spec review comment must be a string');
  if (verdict === 'needs_clarification' && comment.trim() === '') {
    throw new Error('a spec review that asks for clarification needs a comment');
  }
  return { verdict, comment };
}

const riskLevels: readonly unknown[] = ['low', 'medium', 'high'] satisfies RiskLevel[];

export function parsePrReview(value: unknown): PrReview {
  const { risk, comment } = fieldsOf(value);
  if (!riskLevels.includes(risk)) throw new Error(`the PR review risk must be low, medium or high, got ${JSON.stringify(risk)}`);
  // Every decision is explained on the pull request, a merge included.
  if (typeof comment !== 'string' || comment.trim() === '') throw new Error('the PR review needs a comment');
  return { risk: risk as RiskLevel, comment };
}

const inputActions: readonly unknown[] = ['answer', 'approve', 'request_changes', 'leave_to_human'] satisfies InputAction[];

/** Checks the shape only; whether an answer fits its question is up to the operation that applies it. */
export function parseInputReview(value: unknown): InputReview {
  const { responses } = fieldsOf(value);
  if (!Array.isArray(responses)) throw new Error('the input review responses must be an array');
  return { responses: responses.map(parseInputResponse) };
}

function parseInputResponse(value: unknown, index: number): InputResponse {
  const { id, action, answer, comment, rationale } = fieldsOf(value);
  const at = `input review response ${index}`;
  if (typeof id !== 'string' || id === '') throw new Error(`${at} needs an id`);
  if (!inputActions.includes(action)) throw new Error(`${at} has an unknown action ${JSON.stringify(action)}`);
  // The engineer sees why the reviewer acted or held back, whichever it did.
  if (typeof rationale !== 'string' || rationale.trim() === '') throw new Error(`${at} needs a rationale`);
  if (comment !== undefined && typeof comment !== 'string') throw new Error(`${at} has a comment that is not a string`);
  switch (action as InputAction) {
    case 'answer':
      if (!Array.isArray(answer) || !answer.every((item) => typeof item === 'string')) {
        throw new Error(`${at} answers without an array of strings`);
      }
      return { id, rationale, action: 'answer', answer };
    case 'request_changes':
      if (typeof comment !== 'string' || comment.trim() === '') throw new Error(`${at} requests changes without a comment`);
      return { id, rationale, action: 'request_changes', comment };
    case 'approve':
      return { id, rationale, action: 'approve', ...(typeof comment === 'string' && comment.trim() !== '' && { comment }) };
    case 'leave_to_human':
      return { id, rationale, action: 'leave_to_human' };
  }
}

function fieldsOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('the review must be a JSON object');
  return value as Record<string, unknown>;
}

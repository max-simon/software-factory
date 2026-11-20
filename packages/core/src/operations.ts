import { setDependencies } from './dependencies.ts';
import { DomainError } from './errors.ts';
import type { StartedExecution } from './ports.ts';
import { assertTransition } from './status.ts';
import type {
  Artifact,
  AutonomyMode,
  Decision,
  ExternalLink,
  FollowUp,
  PlanStep,
  PrReviewOutcome,
  PullRequest,
  Question,
  Annotation,
  ReviewerNote,
  QuestionType,
  Responder,
  ReviewVerdict,
  SessionMetrics,
  Task,
  TaskModel,
  TaskStatus,
  TokenUsage,
} from './task.ts';

// All operations are pure: they return a new Task and never touch `updatedAt`;
// the caller stamps it when saving.

export interface NewTask {
  projectId: string;
  title: string;
  specification: string;
  repoUrl?: string;
  labels?: string[];
  autonomyMode?: AutonomyMode;
  baseBranch?: string;
  /** Defaults to `opus`. */
  model?: TaskModel;
  /** Defaults to `true`. */
  shellEnabled?: boolean;
  /** Defaults to none; the caller validates them against the other tasks. */
  dependsOn?: string[];
}

export interface TaskEdit {
  title?: string;
  specification?: string;
  labels?: string[];
  /** The complete new list; unlike the other fields, it can change until the task starts. */
  dependsOn?: string[];
}

export interface NewQuestion {
  id: string;
  createdAt: string;
  problem: string;
  type: QuestionType;
  options: string[];
}

export interface NewDecision extends Omit<Decision, 'approval'> {
  requestApproval?: boolean;
}

export interface NewArtifact extends Omit<Artifact, 'approval'> {
  requestApproval?: boolean;
}

export interface Review {
  verdict: ReviewVerdict;
  /** `changes_requested` needs a comment or at least one annotation. */
  comment?: string;
  annotations?: Annotation[];
  /** Approving a decision with another of its options overrides the agent's pick. */
  chosen?: number;
}

export type NewPullRequest = Omit<PullRequest, 'status' | 'reviews'>;

export type NewFollowUp = Omit<FollowUp, 'deliveredAt'>;

const activeStatuses: readonly TaskStatus[] = ['in_progress', 'input_required'];

// Failed is included because the execution server is kept for a while after a failure.
const followUpStatuses: readonly TaskStatus[] = ['in_progress', 'input_required', 'ready', 'failed'];

function transition(task: Task, to: TaskStatus): Task {
  assertTransition(task.status, to);
  return { ...task, status: to };
}

/** For moves the status table allows from several statuses but that make sense from one only. */
function transitionFrom(task: Task, from: TaskStatus, to: TaskStatus): Task {
  if (task.status !== from) {
    throw new DomainError('invalid_transition', `cannot move task from ${task.status} to ${to}`);
  }
  return transition(task, to);
}

function assertActive(task: Task): void {
  if (!activeStatuses.includes(task.status)) {
    throw new DomainError('not_active', `task is ${task.status}, reports are accepted only while it runs`);
  }
}

/**
 * `meta.createdBy` is the id of the user who creates the task. `meta.external`
 * makes it a managed task; it is not part of `NewTask`, so no API client can set it.
 */
export function createTask(
  input: NewTask,
  meta: { id: string; now: string; rank: number; createdBy?: string; external?: ExternalLink },
): Task {
  const task: Task = {
    id: meta.id,
    createdAt: meta.now,
    ...(meta.createdBy !== undefined && { createdBy: meta.createdBy }),
    updatedAt: meta.now,
    projectId: input.projectId,
    title: input.title,
    specification: input.specification,
    labels: input.labels ?? [],
    autonomyMode: input.autonomyMode ?? 'autonomous',
    model: input.model ?? 'opus',
    shellEnabled: input.shellEnabled ?? true,
    status: 'draft',
    rank: meta.rank,
    dependsOn: input.dependsOn ?? [],
    plan: [],
    decisions: [],
    artifacts: [],
    questions: [],
    pullRequests: [],
    followUps: [],
  };
  return {
    ...task,
    ...(meta.external !== undefined && { external: meta.external }),
    ...(input.repoUrl !== undefined && { repoUrl: input.repoUrl }),
    ...(input.baseBranch !== undefined && { baseBranch: input.baseBranch }),
  };
}

// Clarifying a task means editing its specification, so it stays editable until queued.
const editableStatuses: readonly TaskStatus[] = ['draft', 'clarification_required'];

export const isEditable = (status: TaskStatus): boolean => editableStatuses.includes(status);

/** `tasks` are all tasks, which the dependencies are validated against. */
export function editTask(task: Task, edit: TaskEdit, tasks: readonly Task[]): Task {
  const { dependsOn, ...content } = edit;
  const hasContent = Object.values(content).some((value) => value !== undefined);
  // A queued task may still get new dependencies, but nothing else.
  const edited = hasContent || dependsOn === undefined ? editContent(task, content) : task;
  return dependsOn === undefined ? edited : setDependencies(edited, dependsOn, tasks);
}

function editContent(task: Task, edit: Omit<TaskEdit, 'dependsOn'>): Task {
  if (task.external !== undefined) {
    throw new DomainError('externally_managed', `task is managed by ${task.external.key}, change it there`);
  }
  if (!isEditable(task.status)) {
    throw new DomainError('not_editable', `task is ${task.status}, only tasks that are not queued yet can be edited`);
  }
  return {
    ...task,
    title: edit.title ?? task.title,
    specification: edit.specification ?? task.specification,
    labels: edit.labels ?? task.labels,
  };
}

/** What the provider of a managed task owns, as last read from its issue. */
export interface ManagedContent {
  title: string;
  specification: string;
  labels: string[];
  autonomyMode: AutonomyMode;
  model: TaskModel;
}

/**
 * The only way to change the provider-owned fields of a managed task. Like an
 * edit, it stops once the task is queued: the agent works on what it was given.
 */
export function syncManagedContent(task: Task, content: ManagedContent): Task {
  if (task.external === undefined) {
    throw new DomainError('not_managed', `task ${task.id} is not linked to an external issue`);
  }
  if (!isEditable(task.status)) {
    throw new DomainError('not_editable', `task is ${task.status}, only tasks that are not queued yet can be synced`);
  }
  const { title, specification, labels, autonomyMode, model } = content;
  return { ...task, title, specification, labels, autonomyMode, model };
}

/** Rank of a task added below every task on the board. */
export const nextRank = (tasks: readonly Pick<Task, 'rank'>[]): number =>
  tasks.reduce((max, task) => Math.max(max, task.rank + 1), 0);

/**
 * Moves task `id` directly before `beforeId`, or below every task without one,
 * and renumbers the board. Returns only the tasks whose rank changed.
 */
export function moveTask(tasks: readonly Task[], id: string, beforeId?: string): Task[] {
  if (id === beforeId) return [];
  const ordered = [...tasks].sort(byRank);
  const moved = ordered.find((t) => t.id === id);
  if (!moved) throw new DomainError('unknown_task', `there is no task ${id}`);
  const rest = ordered.filter((t) => t.id !== id);
  const index = beforeId === undefined ? rest.length : rest.findIndex((t) => t.id === beforeId);
  if (index === -1) throw new DomainError('unknown_task', `there is no task ${beforeId}`);
  rest.splice(index, 0, moved);
  return rest.flatMap((task, rank) => (task.rank === rank ? [] : [{ ...task, rank }]));
}

// Ties only arise from data written before ranks existed; creation order breaks them.
const byRank = (a: Task, b: Task): number =>
  a.rank - b.rank || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** Queues a draft, or a task whose clarification the engineer settled by starting it. */
export function startTask(task: Task): Task {
  // Moving a started task back to queued is a restart, which also resets it.
  if (!isEditable(task.status)) {
    throw new DomainError('invalid_transition', `cannot move task from ${task.status} to queued`);
  }
  const { clarification: _settled, ...rest } = task;
  return transition(rest, 'queued');
}

/** Holds a draft until `note`, what is unclear about its specification, is settled. */
export function requestClarification(task: Task, note: string): Task {
  const clarification = note.trim();
  if (clarification === '') {
    throw new DomainError('invalid_clarification', 'a clarification request needs a note on what is unclear');
  }
  return { ...transitionFrom(task, 'draft', 'clarification_required'), clarification };
}

/** Settles a clarification without queueing the task. */
export function returnToDraft(task: Task): Task {
  const { clarification: _settled, ...rest } = transitionFrom(task, 'clarification_required', 'draft');
  return rest;
}

/** The execution server was just started; it is working until it asks for work and gets none. */
export function markInProgress(task: Task, started: { tokenHash: string } & StartedExecution, now: string): Task {
  const { tokenHash, executionId } = started;
  // Only the dispatcher calls this; a task cancelled while its execution server started must stay failed.
  return {
    ...transitionFrom(task, 'queued', 'in_progress'),
    execution: {
      id: executionId,
      tokenHash,
      worker: { state: 'working', since: now },
    },
  };
}

export function replacePlan(task: Task, plan: PlanStep[]): Task {
  assertActive(task);
  return { ...task, plan };
}

export function addDecision(task: Task, input: NewDecision): Task {
  const { requestApproval, ...decision } = input;
  if (requestApproval) assertApprovalsAllowed(task);
  assertActive(task);
  if (!requestApproval) return { ...task, decisions: [...task.decisions, decision] };
  return awaitInput({ ...task, decisions: [...task.decisions, { ...decision, approval: { status: 'pending' } }] });
}

export function addArtifact(task: Task, input: NewArtifact): Task {
  const { requestApproval, ...artifact } = input;
  if (requestApproval) assertApprovalsAllowed(task);
  assertActive(task);
  if (!requestApproval) return { ...task, artifacts: [...task.artifacts, artifact] };
  return awaitInput({ ...task, artifacts: [...task.artifacts, { ...artifact, approval: { status: 'pending' } }] });
}

export function addPullRequest(task: Task, input: NewPullRequest): Task {
  assertActive(task);
  if (task.repoUrl === undefined) {
    throw new DomainError(
      'foreign_pull_request',
      'this task has no repository, so it cannot have pull requests: report results with report_artifact',
    );
  }
  if (!belongsToRepository(input.url, task.repoUrl)) {
    throw new DomainError('foreign_pull_request', `${input.url} is not a pull request of ${task.repoUrl}`);
  }
  // Agents retry tool calls; reporting the same PR twice must not duplicate it.
  if (task.pullRequests.some((pr) => pr.url === input.url)) return task;
  return { ...task, pullRequests: [...task.pullRequests, { ...input, status: 'open' }] };
}

/** Replaces reported pull requests with what the control plane read from GitHub; an unknown conflict state keeps the recorded one. */
export function updatePullRequests(task: Task, updates: readonly PullRequest[]): Task {
  if (!followUpStatuses.includes(task.status)) {
    throw new DomainError('not_active', `task is ${task.status}, pull request updates are accepted only while it runs`);
  }
  const unknown = updates.find((update) => !task.pullRequests.some((pr) => pr.url === update.url));
  if (unknown !== undefined) {
    throw new DomainError('unknown_pull_request', `task ${task.id} has no pull request ${unknown.url}`);
  }
  const pullRequests = task.pullRequests.map((pr) => {
    const update = updates.find((candidate) => candidate.url === pr.url);
    if (update === undefined) return pr;
    // The host computes mergeability in the background: not having computed it yet is no news.
    const read = update.hasConflicts === undefined && pr.hasConflicts !== undefined ? { ...update, hasConflicts: pr.hasConflicts } : update;
    // The host knows nothing of the factory's own review.
    return pr.prReview === undefined ? read : { ...read, prReview: pr.prReview };
  });
  return { ...task, pullRequests };
}

/** Records how the factory's PR review of pull request `url` ended; a later review replaces it. */
export function recordPrReview(task: Task, url: string, outcome: PrReviewOutcome): Task {
  if (!followUpStatuses.includes(task.status)) {
    throw new DomainError('not_active', `task is ${task.status}, pull request reviews are recorded only while it runs`);
  }
  if (!task.pullRequests.some((pr) => pr.url === url)) {
    throw new DomainError('unknown_pull_request', `task ${task.id} has no pull request ${url}`);
  }
  const pullRequests = task.pullRequests.map((pr) => (pr.url === url ? { ...pr, prReview: { ...outcome } } : pr));
  return { ...task, pullRequests };
}

/**
 * Open and reviewed, but not merged by the review: it waits for the engineer.
 * A pull request the review merged stays `open` until the control plane reads it again.
 */
export const isLeftOpenByReview = (pr: PullRequest): boolean =>
  pr.status === 'open' && pr.prReview !== undefined && pr.prReview.result !== 'merged';

/**
 * Once the PR review is over, a ready task with a pull request it left open
 * needs the engineer; any other task stays as it is, since it moved on meanwhile.
 */
export function requireInputForPullRequests(task: Task): Task {
  if (task.status !== 'ready' || !task.pullRequests.some(isLeftOpenByReview)) return task;
  return transition(task, 'input_required');
}

export function askQuestion(task: Task, question: NewQuestion): Task {
  if (task.autonomyMode !== 'supervised') {
    throw new DomainError(
      'questions_not_allowed',
      'this task is autonomous: decide yourself and report the decision with report_decision',
    );
  }
  assertActive(task);
  return awaitInput({ ...task, questions: [...task.questions, { ...question }] });
}

/** `by` is the answering user, or the input reviewer answering instead of the engineer. */
export function answerQuestion(task: Task, questionId: string, answer: string[], by: Responder): Task {
  const question = task.questions.find((q) => q.id === questionId);
  if (!question) {
    throw new DomainError('unknown_question', `task ${task.id} has no question ${questionId}`);
  }
  if (question.answer) {
    throw new DomainError('invalid_answer', `question ${questionId} is already answered`);
  }
  if (task.status !== 'input_required') {
    throw new DomainError('invalid_transition', `task is ${task.status}, answers are accepted only while input is required`);
  }
  assertValidAnswer(question, answer);
  const questions = task.questions.map((q) =>
    q.id === questionId ? { ...q, answer: [...answer], ...respondedBy(by, 'answeredBy') } : q,
  );
  return resumeWhenSettled({ ...task, questions });
}

/** Approves or rejects a decision or artifact that awaits approval; `by` is the reviewing user or the input reviewer. */
export function reviewItem(task: Task, itemId: string, review: Review, by: Responder): Task {
  const item = [...task.decisions, ...task.artifacts].find((i) => i.id === itemId);
  if (!item) throw new DomainError('unknown_item', `task ${task.id} has no decision or artifact ${itemId}`);
  if (item.approval?.status !== 'pending') {
    throw new DomainError('invalid_review', `${itemId} is not awaiting approval`);
  }
  if (task.status !== 'input_required') {
    throw new DomainError('invalid_transition', `task is ${task.status}, reviews are accepted only while input is required`);
  }
  const comment = review.comment?.trim();
  const annotations = review.annotations ?? [];
  if (review.verdict === 'changes_requested' && !comment && annotations.length === 0) {
    throw new DomainError('invalid_review', 'requesting changes needs a comment');
  }
  const chosen = overriddenChoice(item, review);
  const approval = {
    status: review.verdict,
    ...(comment ? { comment } : {}),
    ...(annotations.length > 0 ? { annotations: annotations.map((a) => ({ ...a })) } : {}),
    ...(chosen !== undefined && { chosen }),
    ...respondedBy(by, 'reviewedBy'),
  };
  const reviewed = <T extends { id: string }>(items: T[]): T[] =>
    items.map((i) => (i.id === itemId ? { ...i, approval } : i));
  return resumeWhenSettled({ ...task, decisions: reviewed(task.decisions), artifacts: reviewed(task.artifacts) });
}

/** A user is recorded by id under `userKey`, never by name; the input reviewer by its note, without a user. */
function respondedBy<K extends 'answeredBy' | 'reviewedBy'>(by: Responder, userKey: K): { byReviewer: ReviewerNote } | { [P in K]: string } {
  return 'reviewer' in by ? { byReviewer: { ...by.reviewer } } : ({ [userKey]: by.userId } as { [P in K]: string });
}

/** The reviewer's pick when it overrides the agent's; picking the agent's own option is no override. */
function overriddenChoice(item: Decision | Artifact, review: Review): number | undefined {
  if (review.chosen === undefined) return undefined;
  if (review.verdict !== 'approved') throw new DomainError('invalid_review', 'only an approval can pick an option');
  if (!('options' in item) || !Number.isInteger(review.chosen) || review.chosen < 0 || review.chosen >= item.options.length) {
    throw new DomainError('invalid_review', `${item.id} has no option ${review.chosen}`);
  }
  return review.chosen === item.chosen ? undefined : review.chosen;
}

/** True while a question is unanswered or a decision or artifact awaits approval. */
export function hasOpenInput(task: Pick<Task, 'questions' | 'decisions' | 'artifacts'>): boolean {
  return (
    task.questions.some((q) => !q.answer) ||
    [...task.decisions, ...task.artifacts].some((i) => i.approval?.status === 'pending')
  );
}

function assertApprovalsAllowed(task: Task): void {
  if (task.autonomyMode !== 'supervised') {
    throw new DomainError(
      'approvals_not_allowed',
      'this task is autonomous: report without requesting approval and proceed',
    );
  }
}

const awaitInput = (task: Task): Task => (task.status === 'input_required' ? task : transition(task, 'input_required'));

const resumeWhenSettled = (task: Task): Task => (hasOpenInput(task) ? task : transition(task, 'in_progress'));

export const markReady = (task: Task): Task => transition(task, 'ready');

export function markFailed(task: Task, reason: string, now: string): Task {
  return { ...transition(task, 'failed'), failureReason: reason, failedAt: now };
}

export const markDone = (task: Task): Task => transition(task, 'done');

/** Adds one session's usage to the totals; accepted in every status, since reports may arrive late. */
export function addSessionMetrics(task: Task, delta: SessionMetrics): Task {
  const total = task.metrics ?? { durationMs: 0, costUsd: 0 };
  // Tokens used before they were tracked are unknown, so a total without them starts from zero.
  const tokens = delta.tokens ? addTokens(total.tokens ?? noTokens, delta.tokens) : total.tokens;
  return {
    ...task,
    metrics: {
      durationMs: total.durationMs + delta.durationMs,
      costUsd: total.costUsd + delta.costUsd,
      ...(tokens && { tokens }),
    },
  };
}

const noTokens: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

/**
 * Queues a message for the agent. A ready or failed task, or one awaiting the
 * engineer on its pull requests only, goes back to `in_progress`; a task
 * awaiting answers or approvals stays there and gets the message with them.
 * The agent session lives on the execution server, so the task needs one.
 */
export function addFollowUp(task: Task, input: NewFollowUp): Task {
  const message = input.message.trim();
  if (message === '') throw new DomainError('invalid_follow_up', 'a follow-up needs a non-empty message');
  if (!followUpStatuses.includes(task.status)) {
    throw new DomainError(
      'follow_up_not_allowed',
      `task is ${task.status}, follow-ups are accepted only while its execution server exists`,
    );
  }
  // A failed task keeps its execution server only for a while.
  if (task.execution === undefined) {
    throw new DomainError('no_execution', `task ${task.id} has no execution server any more, so it cannot receive follow-ups`);
  }
  const followUps = [...task.followUps, { ...input, message }];
  return resumeForFollowUp({ ...task, followUps });
}

function resumeForFollowUp(task: Task): Task {
  // Input required without open input means only pull requests wait for the engineer, so the agent may work on.
  const isWaitingOnPullRequests = task.status === 'input_required' && !hasOpenInput(task);
  if (task.status !== 'ready' && task.status !== 'failed' && !isWaitingOnPullRequests) return task;
  const { failureReason: _cleared, failedAt: _clearedAt, ...rest } = task;
  return transition(rest, 'in_progress');
}

const cancellableStatuses: readonly TaskStatus[] = ['queued', 'in_progress', 'input_required', 'ready'];

export const isCancellable = (status: TaskStatus): boolean => cancellableStatuses.includes(status);

export const isRestartable = (status: TaskStatus): boolean => !isEditable(status) && status !== 'queued';

/**
 * Fails a queued or running task on the engineer's request. Token and execution
 * go at once, so neither the runner nor a follow-up can revive the task while
 * the caller removes the execution server.
 */
export function cancelTask(task: Task, now: string): Task {
  if (!isCancellable(task.status)) {
    throw new DomainError('invalid_transition', `task is ${task.status}, only queued or running tasks can be cancelled`);
  }
  return detachExecution(markFailed(task, 'Cancelled by the engineer', now));
}

/**
 * Queues a started task again, at its rank, as if it had never run. Metrics
 * stay: that work was paid for. The caller removes the old execution server.
 */
export function restartTask(task: Task): Task {
  if (!isRestartable(task.status)) {
    throw new DomainError('invalid_transition', `task is ${task.status}, only a task that has started can be restarted`);
  }
  const { failureReason: _failure, failedAt: _failedAt, ...kept } = detachExecution(transition(task, 'queued'));
  return { ...kept, plan: [], decisions: [], artifacts: [], questions: [], pullRequests: [], followUps: [] };
}

/** Token, worker state and heartbeat go with their execution server. */
export function detachExecution(task: Task): Task {
  const { execution: _removed, ...rest } = task;
  return rest;
}

function assertValidAnswer(question: Question, answer: string[]): void {
  const invalid = (reason: string): never => {
    throw new DomainError('invalid_answer', `invalid answer to ${question.id}: ${reason}`);
  };
  if (question.type === 'text') {
    if (answer.length !== 1 || answer[0]!.trim() === '') invalid('expected one non-empty text');
    return;
  }
  if (question.type === 'radio' && answer.length !== 1) invalid('expected exactly one option');
  if (new Set(answer).size !== answer.length) invalid('options must not repeat');
  const unknown = answer.find((a) => !question.options.includes(a));
  if (unknown !== undefined) invalid(`"${unknown}" is not one of ${question.options.join(', ')}`);
}

/** Compares owner/name of a GitHub PR URL with the task's repository URL. */
function belongsToRepository(pullRequestUrl: string, repoUrl: string): boolean {
  const pr = parseGitHubPath(pullRequestUrl);
  const repo = parseGitHubPath(repoUrl);
  if (!pr || !repo || pr.host !== repo.host) return false;
  const [owner, name, kind, number] = pr.segments;
  const [repoOwner, repoName] = repo.segments;
  return (
    pr.segments.length === 4 &&
    kind === 'pull' &&
    /^\d+$/.test(number ?? '') &&
    owner?.toLowerCase() === repoOwner?.toLowerCase() &&
    name?.toLowerCase() === repoName?.replace(/\.git$/, '').toLowerCase()
  );
}

function parseGitHubPath(raw: string): { host: string; segments: string[] } | undefined {
  try {
    const url = new URL(raw);
    return { host: url.host.toLowerCase(), segments: url.pathname.split('/').filter(Boolean) };
  } catch {
    return undefined;
  }
}

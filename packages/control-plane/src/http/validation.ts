import type {
  Annotation,
  AutonomyMode,
  Heartbeat,
  HeartbeatPhase,
  NewArtifact,
  NewDecision,
  NewProject,
  NewPullRequest,
  NewQuestion,
  NewTask,
  PlanStep,
  PlanStepStatus,
  ProjectEdit,
  PullRequest,
  PullRequestStatus,
  QuestionType,
  Review,
  ReviewVerdict,
  SessionMetrics,
  TaskEdit,
  TaskAgent,
  TaskModel,
} from '@factory/core';

export class ValidationError extends Error {
  override name = 'ValidationError';
}

type Fields = Record<string, unknown>;

export function object(value: unknown, what = 'request body'): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${what} must be a JSON object`);
  }
  return value as Fields;
}

/**
 * Clients and the control plane can run different versions; a field this
 * version does not know must fail the request instead of being dropped.
 */
function rejectUnknownFields(fields: Fields, known: readonly string[], what = 'request body'): void {
  const unknown = Object.keys(fields).filter((key) => !known.includes(key));
  if (unknown.length > 0) throw new ValidationError(`${what} has unknown fields: ${unknown.join(', ')}`);
}

export function requiredString(fields: Fields, key: string): string {
  const value = fields[key];
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${key} must be a non-empty string`);
  return value;
}

export function optionalString(fields: Fields, key: string): string | undefined {
  return fields[key] === undefined ? undefined : requiredString(fields, key);
}

export function stringArray(fields: Fields, key: string): string[] {
  const value = fields[key];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim() !== '')) {
    throw new ValidationError(`${key} must be an array of non-empty strings`);
  }
  return value as string[];
}

export function optionalStringArray(fields: Fields, key: string): string[] | undefined {
  return fields[key] === undefined ? undefined : stringArray(fields, key);
}

export function optionalBoolean(fields: Fields, key: string): boolean | undefined {
  const value = fields[key];
  if (value !== undefined && typeof value !== 'boolean') throw new ValidationError(`${key} must be a boolean`);
  return value;
}

export function oneOf<T extends string>(fields: Fields, key: string, allowed: readonly T[]): T {
  const value = fields[key];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ValidationError(`${key} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function repositoryUrl(fields: Fields, key: string): string {
  const value = requiredString(fields, key);
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (url?.protocol !== 'https:' || url.pathname.split('/').filter(Boolean).length !== 2) {
    throw new ValidationError(`${key} must be an https URL of a repository, e.g. https://github.com/owner/name`);
  }
  return value;
}

export function parseNewTask(body: unknown): NewTask {
  const fields = object(body);
  const autonomyMode =
    fields.autonomyMode === undefined
      ? undefined
      : oneOf<AutonomyMode>(fields, 'autonomyMode', ['autonomous', 'supervised']);
  const model = fields.model === undefined ? undefined : oneOf<TaskModel>(fields, 'model', ['opus', 'sonnet']);
  const agent = fields.agent === undefined ? undefined : oneOf<TaskAgent>(fields, 'agent', ['claude', 'opencode']);
  const labels = optionalStringArray(fields, 'labels');
  const baseBranch = optionalString(fields, 'baseBranch');
  const repoUrl = fields.repoUrl === undefined ? undefined : repositoryUrl(fields, 'repoUrl');
  if (baseBranch && !repoUrl) throw new ValidationError('baseBranch requires repoUrl');
  const dependsOn = fields.dependsOn === undefined ? undefined : taskIds(fields, 'dependsOn');
  return {
    projectId: requiredString(fields, 'projectId'),
    title: requiredString(fields, 'title'),
    specification: requiredString(fields, 'specification'),
    ...(repoUrl && { repoUrl }),
    ...(labels && { labels }),
    ...(autonomyMode && { autonomyMode }),
    ...(baseBranch && { baseBranch }),
    ...(model && { model }),
    ...(agent && { agent }),
    ...(dependsOn && { dependsOn }),
  };
}

const maxDependencies = 100;

function taskIds(fields: Fields, key: string): string[] {
  const ids = stringArray(fields, key);
  if (ids.length > maxDependencies) throw new ValidationError(`${key} must list at most ${maxDependencies} tasks`);
  return ids;
}

export function parseTaskEdit(body: unknown): TaskEdit {
  const fields = object(body);
  const unknownKeys = Object.keys(fields).filter((k) => !['title', 'specification', 'labels', 'dependsOn'].includes(k));
  if (unknownKeys.length > 0) throw new ValidationError(`cannot edit ${unknownKeys.join(', ')}`);
  const title = optionalString(fields, 'title');
  const specification = optionalString(fields, 'specification');
  const labels = optionalStringArray(fields, 'labels');
  const dependsOn = fields.dependsOn === undefined ? undefined : taskIds(fields, 'dependsOn');
  return {
    ...(title && { title }),
    ...(specification && { specification }),
    ...(labels && { labels }),
    ...(dependsOn && { dependsOn }),
  };
}

/** Any string, including an empty one, so a description can be cleared. */
function optionalText(fields: Fields, key: string): string | undefined {
  const value = fields[key];
  if (value !== undefined && typeof value !== 'string') throw new ValidationError(`${key} must be a string`);
  return value;
}

export function parseNewProject(body: unknown): NewProject {
  const fields = object(body);
  rejectUnknownFields(fields, ['title', 'description', 'autoMerge']);
  const description = optionalText(fields, 'description');
  const autoMerge = optionalBoolean(fields, 'autoMerge');
  return {
    title: requiredString(fields, 'title'),
    ...(description !== undefined && { description }),
    ...(autoMerge !== undefined && { autoMerge }),
  };
}

export function parseProjectEdit(body: unknown): ProjectEdit {
  const fields = object(body);
  rejectUnknownFields(fields, ['title', 'description', 'autoMerge']);
  const title = optionalString(fields, 'title');
  const description = optionalText(fields, 'description');
  const autoMerge = optionalBoolean(fields, 'autoMerge');
  return { ...(title && { title }), ...(description !== undefined && { description }), ...(autoMerge !== undefined && { autoMerge }) };
}

/** `before` is the id of the task to move in front of; absent means the bottom. */
export function parseMove(body: unknown): string | undefined {
  const fields = object(body);
  rejectUnknownFields(fields, ['before']);
  return optionalString(fields, 'before');
}

export function parseAnswer(body: unknown): string[] {
  const fields = object(body);
  const answer = fields.answer;
  if (!Array.isArray(answer) || !answer.every((a) => typeof a === 'string')) {
    throw new ValidationError('answer must be an array of strings');
  }
  return answer as string[];
}

export function parsePlan(body: unknown): PlanStep[] {
  const plan = object(body).plan;
  if (!Array.isArray(plan)) throw new ValidationError('plan must be an array of steps');
  return plan.map((step: unknown, i) => parsePlanStep(step, `plan[${i}]`));
}

function parsePlanStep(value: unknown, what: string): PlanStep {
  const fields = object(value, what);
  const nextStep = optionalString(fields, 'nextStep');
  return {
    title: requiredString(fields, 'title'),
    status: oneOf<PlanStepStatus>(fields, 'status', ['pending', 'in_progress', 'done']),
    ...(nextStep && { nextStep }),
  };
}

export function parseDecision(body: unknown): Omit<NewDecision, 'id' | 'createdAt'> {
  const fields = object(body);
  rejectUnknownFields(fields, ['problem', 'options', 'chosen', 'reasoning', 'requestApproval']);
  const options = stringArray(fields, 'options');
  const chosen = parseChosen(fields.chosen, options.length);
  const requestApproval = optionalBoolean(fields, 'requestApproval');
  return {
    problem: requiredString(fields, 'problem'),
    options,
    ...(chosen !== undefined && { chosen }),
    reasoning: requiredString(fields, 'reasoning'),
    ...(requestApproval && { requestApproval }),
  };
}

function parseChosen(value: unknown, optionCount: number): number | undefined {
  if (optionCount === 0) {
    if (value !== undefined) throw new ValidationError('chosen must be left out when options is empty');
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= optionCount) {
    throw new ValidationError(`chosen must be the 0-based index of one of the ${optionCount} options`);
  }
  return value as number;
}

export function parseArtifact(body: unknown): Omit<NewArtifact, 'id' | 'createdAt'> {
  const fields = object(body);
  rejectUnknownFields(fields, ['title', 'kind', 'content', 'requestApproval']);
  const requestApproval = optionalBoolean(fields, 'requestApproval');
  return {
    title: requiredString(fields, 'title'),
    kind: requiredString(fields, 'kind'),
    content: requiredString(fields, 'content'),
    ...(requestApproval && { requestApproval }),
  };
}

const maxAnnotations = 200;

export function parseReview(body: unknown): Review {
  const fields = object(body);
  rejectUnknownFields(fields, ['verdict', 'comment', 'annotations', 'chosen']);
  const verdict = oneOf<ReviewVerdict>(fields, 'verdict', ['approved', 'changes_requested']);
  const comment = fields.comment;
  if (comment !== undefined && typeof comment !== 'string') throw new ValidationError('comment must be a string');
  const annotations = fields.annotations === undefined ? undefined : parseAnnotations(fields.annotations);
  const chosen = fields.chosen;
  // The range depends on the decision's options, which reviewItem checks.
  if (chosen !== undefined && (!Number.isInteger(chosen) || (chosen as number) < 0)) {
    throw new ValidationError('chosen must be a 0-based option index');
  }
  return {
    verdict,
    ...(comment !== undefined && { comment }),
    ...(annotations && { annotations }),
    ...(chosen !== undefined && { chosen: chosen as number }),
  };
}

function parseAnnotations(value: unknown): Annotation[] {
  if (!Array.isArray(value) || value.length > maxAnnotations) {
    throw new ValidationError(`annotations must be an array of at most ${maxAnnotations} entries`);
  }
  return value.map((entry: unknown, i) => {
    const fields = object(entry, `annotations[${i}]`);
    rejectUnknownFields(fields, ['quote', 'comment'], `annotations[${i}]`);
    return { quote: requiredString(fields, 'quote'), comment: requiredString(fields, 'comment') };
  });
}

/** The agent reports a new pull request; only the control plane sets its status. */
export function parseNewPullRequest(body: unknown): NewPullRequest {
  const fields = object(body);
  rejectUnknownFields(fields, ['url', 'title']);
  return { url: requiredString(fields, 'url'), title: requiredString(fields, 'title') };
}

const minOptions: Record<QuestionType, number> = { text: 0, checkbox: 1, radio: 2 };

export function parseNewQuestion(body: unknown): Omit<NewQuestion, 'id' | 'createdAt'> {
  const fields = object(body);
  const problem = requiredString(fields, 'problem');
  const type = oneOf<QuestionType>(fields, 'type', ['text', 'checkbox', 'radio']);
  const options = stringArray(fields, 'options');
  if (type === 'text' && options.length > 0) throw new ValidationError('a text question takes no options');
  const min = minOptions[type];
  if (options.length < min) {
    throw new ValidationError(`a ${type} question needs at least ${min} option${min === 1 ? '' : 's'}`);
  }
  if (new Set(options).size !== options.length) throw new ValidationError('options must be unique');
  return { problem, type, options };
}

export function parseFailure(body: unknown): string {
  return requiredString(object(body), 'reason');
}

const heartbeatPhases: readonly HeartbeatPhase[] = ['awaiting_work', 'setting_up', 'working'];
const maxActivityLength = 200;

/** The activity is display text derived from CLI output, so it is trimmed and shortened rather than rejected. */
export function parseHeartbeat(body: unknown): Omit<Heartbeat, 'at'> {
  const fields = object(body);
  rejectUnknownFields(fields, ['phase', 'activity']);
  const phase = oneOf(fields, 'phase', heartbeatPhases);
  const activity = fields.activity;
  if (activity !== undefined && typeof activity !== 'string') throw new ValidationError('activity must be a string');
  const shown = activity?.trim().slice(0, maxActivityLength);
  return { phase, ...(shown && { activity: shown }) };
}

/** One session's usage, added to the task totals. */
export function parseSessionMetrics(body: unknown): SessionMetrics {
  const fields = object(body);
  rejectUnknownFields(fields, ['durationMs', 'costUsd']);
  return { durationMs: nonNegativeNumber(fields, 'durationMs'), costUsd: nonNegativeNumber(fields, 'costUsd') };
}

function nonNegativeNumber(fields: Fields, key: string): number {
  const value = fields[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${key} must be a finite number >= 0`);
  }
  return value;
}

export function parseFollowUp(body: unknown): string {
  const fields = object(body);
  rejectUnknownFields(fields, ['message']);
  return requiredString(fields, 'message');
}

export function parseClarification(body: unknown): string {
  const fields = object(body);
  rejectUnknownFields(fields, ['note']);
  return requiredString(fields, 'note');
}

const maxFollowUpIds = 1000;

/** The follow-ups of the work the runner accepts. */
export function parseAcceptedWork(body: unknown): string[] {
  const fields = object(body);
  rejectUnknownFields(fields, ['followUpIds']);
  const ids = stringArray(fields, 'followUpIds');
  if (ids.length > maxFollowUpIds) throw new ValidationError(`followUpIds must list at most ${maxFollowUpIds} follow-ups`);
  return ids;
}

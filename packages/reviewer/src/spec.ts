import { parseSpecReview, type SpecReviewRequest } from '@factory/core';
import type { Role } from './claude.ts';
import { object, RequestError, string, strings } from './request.ts';

export function parseSpecReviewRequest(value: unknown): SpecReviewRequest {
  const { project, task, otherTasks } = object(value, 'request');
  const { title: projectTitle, description } = object(project, 'project');
  const fields = object(task, 'task');
  string(projectTitle, 'project.title');
  string(description, 'project.description');
  string(fields.title, 'task.title');
  string(fields.specification, 'task.specification');
  strings(fields.labels, 'task.labels');
  if (!Array.isArray(otherTasks)) throw new RequestError('otherTasks must be an array');
  otherTasks.forEach((other, i) => {
    const { title, status, labels, isDependency } = object(other, `otherTasks[${i}]`);
    string(title, `otherTasks[${i}].title`);
    string(status, `otherTasks[${i}].status`);
    strings(labels, `otherTasks[${i}].labels`);
    if (typeof isDependency !== 'boolean') throw new RequestError(`otherTasks[${i}].isDependency must be a boolean`);
  });
  return value as SpecReviewRequest;
}

/** The user message: the task to judge first, then its dependencies, the project and its other tasks for context. */
export function specPrompt({ project, task, otherTasks }: SpecReviewRequest): string {
  const dependencies = otherTasks.filter((other) => other.isDependency);
  const others = otherTasks.filter((other) => !other.isDependency);
  const repository = task.repoUrl
    ? `${task.repoUrl} (base branch: ${task.baseBranch ?? "the repository's default branch"})`
    : 'none; the agent can only deliver documents, no code changes';
  return [
    `# Task to review: ${task.title}`,
    '',
    `Repository: ${repository}`,
    `Labels: ${labels(task.labels)}`,
    `Autonomy mode: ${task.autonomyMode} (supervised agents may ask the engineer questions; autonomous ones may not)`,
    '',
    '## Specification',
    '',
    task.specification.trim() || '(empty)',
    '',
    '## Dependencies (the task starts only once all of them are done)',
    '',
    ...list(dependencies),
    '',
    `# Project: ${project.title}`,
    '',
    project.description.trim() || '(no description)',
    '',
    '## Other tasks of the project',
    '',
    ...list(others),
  ].join('\n');
}

const list = (tasks: SpecReviewRequest['otherTasks']): string[] =>
  tasks.length > 0 ? tasks.map((other) => `- [${other.status}] ${other.title} (labels: ${labels(other.labels)})`) : ['(none)'];

const labels = (values: readonly string[]): string => (values.length > 0 ? values.join(', ') : 'none');

/** Judges the text only, so it gets no tools. */
export const spec: Role = {
  systemPrompt: new URL('./prompts/spec.md', import.meta.url),
  // Mirrors SpecReview.
  schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['ready', 'needs_clarification'] },
      comment: { type: 'string' },
    },
    required: ['verdict', 'comment'],
    additionalProperties: false,
  },
  prompt: (request) => specPrompt(parseSpecReviewRequest(request)),
  parseAnswer: parseSpecReview,
};

import { parseInputReview, type Artifact, type Decision, type InputReviewRequest, type Question } from '@factory/core';
import type { Role } from './claude.ts';
import { object, RequestError, string, strings } from './request.ts';

export function parseInputReviewRequest(value: unknown): InputReviewRequest {
  const { project, task, openIds } = object(value, 'request');
  const projectFields = object(project, 'project');
  for (const field of ['title', 'description']) string(projectFields[field], `project.${field}`);
  const fields = object(task, 'task');
  for (const field of ['title', 'specification']) string(fields[field], `task.${field}`);
  for (const field of ['plan', 'questions', 'decisions', 'artifacts', 'pullRequests']) {
    if (!Array.isArray(fields[field])) throw new RequestError(`task.${field} must be an array`);
  }
  strings(openIds, 'openIds');
  if ((openIds as string[]).length === 0) throw new RequestError('openIds must name at least one item');
  return value as InputReviewRequest;
}

/** The user message: the open items to decide on, then the task as the agent reported it, then the project. */
export function inputPrompt({ project, task, openIds }: InputReviewRequest): string {
  const isOpen = (item: { id: string }) => openIds.includes(item.id);
  const open = [
    ...task.questions.filter(isOpen).map(openQuestion),
    ...task.decisions.filter(isOpen).map((decision) => `## ${decision.id}: decision awaiting approval\n\n${decisionText(decision)}`),
    ...task.artifacts.filter(isOpen).map((artifact) => `## ${artifact.id}: artifact awaiting approval\n\n${artifactText(artifact)}`),
  ];
  const settled = [
    ...task.questions.filter((question) => question.answer !== undefined).map(answeredQuestion),
    ...task.decisions.filter((decision) => !isOpen(decision)).map((decision) => `- ${decision.id}: ${decisionText(decision).replaceAll('\n', '\n  ')}`),
    ...task.artifacts.filter((artifact) => !isOpen(artifact)).map((artifact) => `- ${artifact.id}: ${artifact.title} (${artifact.kind})${approvalText(artifact).replaceAll('\n', '\n  ')}`),
  ];
  const repository = task.repoUrl
    ? `${task.repoUrl} (base branch: ${task.baseBranch ?? "the repository's default branch"})`
    : 'none; the agent only delivers documents';
  return [
    '# Open items to decide on',
    '',
    open.join('\n\n'),
    '',
    `# Task: ${task.title}`,
    '',
    `Repository: ${repository}`,
    '',
    '## Specification',
    '',
    task.specification.trim() || '(empty)',
    '',
    '## Plan',
    '',
    ...(task.plan.length > 0 ? task.plan.map((step) => `- [${step.status}] ${step.title}`) : ['(none)']),
    '',
    '## Pull requests',
    '',
    ...(task.pullRequests.length > 0 ? task.pullRequests.map((pr) => `- [${pr.status}] ${pr.title}: ${pr.url}`) : ['(none)']),
    '',
    '## Earlier questions, decisions and artifacts',
    '',
    ...(settled.length > 0 ? settled : ['(none)']),
    '',
    `# Project: ${project.title}`,
    '',
    project.description.trim() || '(no description)',
  ].join('\n');
}

function openQuestion(question: Question): string {
  const kind = { text: 'free text', radio: 'pick exactly one option', checkbox: 'pick any number of options' }[question.type];
  const options = question.options.length > 0 ? `\n\nOptions:\n${question.options.map((option) => `- ${option}`).join('\n')}` : '';
  return `## ${question.id}: question (${kind})\n\n${question.problem.trim()}${options}`;
}

const answeredQuestion = (question: Question): string =>
  `- ${question.id}: ${question.problem.trim().replaceAll('\n', '\n  ')}\n  Answer: ${(question.answer ?? []).join(', ')}`;

function decisionText(decision: Decision): string {
  const mark = (i: number) => (i === decision.chosen ? ' (chosen)' : '') + (i === decision.approval?.chosen ? ' (picked in review)' : '');
  const options = decision.options.map((option, i) => `${i + 1}. ${option}${mark(i)}`);
  return [decision.problem.trim(), ...options, `Reasoning: ${decision.reasoning.trim()}`].join('\n') + approvalText(decision);
}

const artifactText = (artifact: Artifact): string => `${artifact.title} (${artifact.kind})\n\n${artifact.content}`;

function approvalText(item: Decision | Artifact): string {
  const approval = item.approval;
  if (approval === undefined || approval.status === 'pending') return '';
  return `\nReview: ${approval.status}${approval.comment ? `, "${approval.comment}"` : ''}`;
}

/** Reads the repository and the task's pull requests for context with gh and git. */
export const input: Role = {
  systemPrompt: new URL('./prompts/input.md', import.meta.url),
  // Mirrors InputReview; the CLI's schema cannot tie fields to an action, so parseInputReview does.
  schema: {
    type: 'object',
    properties: {
      responses: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            action: { type: 'string', enum: ['answer', 'approve', 'request_changes', 'leave_to_human'] },
            answer: { type: 'array', items: { type: 'string' } },
            comment: { type: 'string' },
            rationale: { type: 'string' },
          },
          required: ['id', 'action', 'rationale'],
          additionalProperties: false,
        },
      },
    },
    required: ['responses'],
    additionalProperties: false,
  },
  prompt: (request) => inputPrompt(parseInputReviewRequest(request)),
  parseAnswer: parseInputReview,
  hasTools: true,
  requiredEnv: ['GITHUB_TOKEN'],
};

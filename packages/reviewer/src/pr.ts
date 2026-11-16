import { parsePrReview, type PrReviewRequest } from '@factory/core';
import type { Role } from './claude.ts';
import { object, string } from './request.ts';

export function parsePrReviewRequest(value: unknown): PrReviewRequest {
  const { task, pullRequest } = object(value, 'request');
  const taskFields = object(task, 'task');
  for (const field of ['title', 'specification']) string(taskFields[field], `task.${field}`);
  const pullRequestFields = object(pullRequest, 'pullRequest');
  for (const field of ['url', 'headSha']) string(pullRequestFields[field], `pullRequest.${field}`);
  return value as PrReviewRequest;
}

/** The user message: the pull request to read, then the task it was opened for. */
export function prPrompt({ task, pullRequest }: PrReviewRequest): string {
  return [
    `# Pull request to review: ${pullRequest.url}`,
    '',
    `Head commit: ${pullRequest.headSha}`,
    '',
    `# Task the pull request was opened for: ${task.title}`,
    '',
    task.specification.trim() || '(empty)',
  ].join('\n');
}

/** Reads the pull request itself with gh and git. */
export const pr: Role = {
  systemPrompt: new URL('./prompts/pr.md', import.meta.url),
  // Mirrors PrReview.
  schema: {
    type: 'object',
    properties: {
      risk: { type: 'string', enum: ['low', 'medium', 'high'] },
      comment: { type: 'string' },
    },
    required: ['risk', 'comment'],
    additionalProperties: false,
  },
  prompt: (request) => prPrompt(parsePrReviewRequest(request)),
  parseAnswer: parsePrReview,
  hasTools: true,
  // gh and git read it themselves.
  requiredEnv: ['GITHUB_TOKEN'],
};

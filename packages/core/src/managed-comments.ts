import type { Artifact, Decision, Question, Task } from './task.ts';

/*
 * What a managed task reports on its issue as comments. The provider posts
 * each key once per issue, so the list holds everything the task should have
 * said so far and posting it again is harmless. Keys start with the task id:
 * an issue imported again after its task was deleted belongs to a new task,
 * which reports its own items.
 *
 * Agents write decisions, questions, options, titles and clarifications, so
 * their text is untrusted; it goes in as plain text with mentions neutralised.
 * Artifact content and the failure reason are left out: the former can be
 * long and is reviewed in the factory, the latter can quote container output.
 */

export interface ManagedComment {
  key: string;
  /** Markdown. */
  body: string;
}

/** A zero-width space after every `@` keeps text from notifying anyone on the provider. */
export const neutralizeMentions = (text: string): string => text.replaceAll('@', '@​');

const inFactory = 'Reply in the factory; comments on this issue are not read.';

function clarificationComment(task: Task, note: string, digest: (text: string) => string): ManagedComment {
  return {
    key: `${task.id}:clarification:${digest(note)}`,
    body: `**Clarification needed:**\n\n${neutralizeMentions(note)}\n\nEdit the issue's title or description; the factory picks up the edit on its next pass.`,
  };
}

const optionList = (options: readonly string[], chosen?: number): string =>
  options.map((option, i) => `- ${neutralizeMentions(option)}${i === chosen ? ' (chosen)' : ''}`).join('\n');

function questionComment(task: Task, question: Question): ManagedComment {
  const options = question.options.length > 0 ? `\n\n${optionList(question.options)}` : '';
  return { key: `${task.id}:${question.id}`, body: `**Question:** ${neutralizeMentions(question.problem)}${options}\n\n${inFactory}` };
}

function decisionComment(task: Task, decision: Decision): ManagedComment {
  const options = decision.options.length > 0 ? `\n\n${optionList(decision.options, decision.chosen)}` : '';
  const body = `**Decision:** ${neutralizeMentions(decision.problem)}${options}\n\n${neutralizeMentions(decision.reasoning)}`;
  return { key: `${task.id}:${decision.id}`, body };
}

const artifactName = (artifact: Artifact): string => `${neutralizeMentions(artifact.title)} (${neutralizeMentions(artifact.kind)})`;

const artifactComment = (task: Task, artifact: Artifact): ManagedComment => ({
  key: `${task.id}:${artifact.id}`,
  body: `**Artifact:** ${artifactName(artifact)}`,
});

const approvalComment = (task: Task, item: { id: string }, name: string): ManagedComment => ({
  key: `${task.id}:${item.id}:approval`,
  body: `**Approval requested:** ${name}\n\n${inFactory}`,
});

const isPending = (item: Decision | Artifact): boolean => item.approval?.status === 'pending';

/**
 * The comments `task` should have on its issue, in a fixed order. `digest`
 * maps a clarification note to a short stable hash, so a new note gets a new
 * comment and the same one does not.
 */
export function managedComments(task: Task, digest: (text: string) => string): ManagedComment[] {
  const comments: ManagedComment[] = [];
  if (task.status === 'clarification_required' && task.clarification !== undefined) {
    comments.push(clarificationComment(task, task.clarification, digest));
  }
  comments.push(...task.questions.map((question) => questionComment(task, question)));
  for (const decision of task.decisions) {
    comments.push(decisionComment(task, decision));
    if (isPending(decision)) comments.push(approvalComment(task, decision, `decision "${neutralizeMentions(decision.problem)}"`));
  }
  for (const artifact of task.artifacts) {
    comments.push(artifactComment(task, artifact));
    if (isPending(artifact)) comments.push(approvalComment(task, artifact, `artifact ${artifactName(artifact)}`));
  }
  if (task.status === 'ready') {
    for (const pr of task.pullRequests.filter((candidate) => candidate.status === 'open')) {
      comments.push({ key: `${task.id}:${pr.url}`, body: `**Pull request to review:** ${neutralizeMentions(pr.title)}\n\n${pr.url}` });
    }
  }
  if (task.status === 'failed') {
    // Tasks that failed before `failedAt` existed fall back to their last update.
    comments.push({
      key: `${task.id}:failed:${task.failedAt ?? task.updatedAt}`,
      body: '**Failed:** the task failed. The factory shows the details.',
    });
  }
  return comments;
}

import type { AgentTaskView, FollowUp, Project } from '@factory/core';

export function taskPrompt(task: AgentTaskView, project: Project): string {
  return [
    `# Task: ${task.title}`,
    '',
    ...repositoryLines(task),
    ...(task.external ? [`Issue: ${task.external.url} (${task.external.key})`] : []),
    `Autonomy mode: ${task.autonomyMode}`,
    `Labels: ${task.labels.length > 0 ? task.labels.join(', ') : 'none'}`,
    '',
    `## Project: ${project.title}`,
    '',
    ...(project.description ? [project.description, ''] : []),
    '## Specification',
    '',
    task.specification,
  ].join('\n');
}

function repositoryLines(task: AgentTaskView): string[] {
  if (!task.repoUrl) {
    return ['Repository: none. The current directory is empty; deliver results with report_artifact, not pull requests.'];
  }
  return [
    `Repository: ${task.repoUrl} (cloned into the current directory)`,
    `Base branch: ${task.baseBranch ?? "the repository's default branch"}`,
  ];
}

const verdicts = { approved: 'approved', changes_requested: 'changes requested', pending: 'still pending' } as const;

/**
 * Resumes the session with what the engineer answered and reviewed among the
 * items `ids` and with the follow-ups that arrived since the last turn.
 */
export function resumePrompt(task: AgentTaskView, ids: ReadonlySet<string>, followUps: readonly FollowUp[] = []): string {
  const answers = task.questions
    .filter((q) => ids.has(q.id))
    .map((q) => `- ${q.id}: ${q.problem}\n  Answer: ${(q.answer ?? []).join(', ')}`);
  const reviewed = [
    ...task.decisions.map((d) => ({ ...d, label: `decision: ${d.problem}` })),
    ...task.artifacts.map((a) => ({ ...a, label: `artifact: ${a.title}` })),
  ].filter((item) => ids.has(item.id));
  const reviews = reviewed.map((item) => {
    const comment = item.approval?.comment ? `\n  Comment: ${item.approval.comment}` : '';
    const annotations = (item.approval?.annotations ?? []).map((a) => `\n  On "${a.quote}": ${a.comment}`).join('');
    const chosen = item.approval?.chosen;
    const override = chosen !== undefined && 'options' in item ? `\n  Go with option ${chosen + 1} instead of yours: ${item.options[chosen]}` : '';
    return `- ${item.id} (${item.label}): ${verdicts[item.approval?.status ?? 'pending']}${comment}${annotations}${override}`;
  });
  const hasChangeRequests = reviewed.some((item) => item.approval?.status === 'changes_requested');
  return [
    ...(answers.length > 0 ? ['The engineer answered your questions:', '', ...answers, ''] : []),
    ...(reviews.length > 0 ? ['The engineer reviewed your approval requests:', '', ...reviews, ''] : []),
    ...(hasChangeRequests
      ? ['Address every change request: revise the item and report it again, requesting approval again if it still needs sign-off.', '']
      : []),
    followUps.length > 0 ? followUpPrompt(followUps) : 'Continue the task.',
  ].join('\n');
}

/** The engineer's follow-up requests that arrived after the agent's last turn. */
export function followUpPrompt(followUps: readonly FollowUp[]): string {
  return [
    'The engineer sent follow-up requests:',
    '',
    ...followUps.map((f) => `- ${f.id}: ${f.message}`),
    '',
    'Address them.',
    '',
    'Report the plan again if it changes; push to the branches of existing pull requests where a follow-up concerns them',
    'and open new pull requests only if needed, reporting each new one. Then call report_ready (or report_failure).',
  ].join('\n');
}

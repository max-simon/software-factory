import { DomainError } from './errors.ts';
import type { TaskStatus } from './task.ts';

// Every status change goes through this table. Every status after `queued` can
// go back to it: the engineer restarts the task.
export const transitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  draft: ['queued', 'clarification_required'],
  // The specification needs clarifying before the task can be queued.
  clarification_required: ['draft', 'queued'],
  queued: ['in_progress', 'failed'],
  in_progress: ['input_required', 'ready', 'failed', 'queued'],
  // Done: a task left waiting on its pull requests is done once none of them is open any more.
  input_required: ['in_progress', 'done', 'failed', 'queued'],
  // Follow-ups move a ready task, or a failed one whose execution server still exists, back to work.
  // Input required: the PR review left a pull request open for the engineer.
  ready: ['in_progress', 'input_required', 'done', 'failed', 'queued'],
  done: ['queued'],
  failed: ['in_progress', 'queued'],
};

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!transitions[from].includes(to)) {
    throw new DomainError('invalid_transition', `cannot move task from ${from} to ${to}`);
  }
}

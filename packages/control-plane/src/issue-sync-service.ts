import { createHash, randomBytes } from 'node:crypto';
import {
  createTask,
  factoryLabel,
  nextRank,
  parseManagedLabels,
  returnToDraft,
  syncManagedContent,
  type ExternalIssue,
  type IssueProvider,
  type ManagedContent,
  type ManagedLabels,
  type ProjectRepository,
  type Task,
} from '@factory/core';
import { describe } from './hooks/hooks.ts';
import { redact } from './redact.ts';
import type { TaskStore } from './task-store.ts';

export interface IssueSyncDeps {
  tasks: Pick<TaskStore, 'findByExternalUrl' | 'insert' | 'update' | 'list' | 'now'>;
  projects: Pick<ProjectRepository, 'get'>;
  provider: IssueProvider;
  /** Secret values to strip from logged errors. */
  secrets: readonly string[];
  log?: (message: string) => void;
  newId?: () => string;
}

// Issues are written by people, so a minute is quick enough; GitHub's rate limit is per hour.
export const issueSyncIntervalMs = 60_000;

const emptyBodyKey = 'empty-body';
const emptyBodyComment =
  'This issue has no description, so the factory does not take it as a task. Describe what should be done; the factory picks it up on its next pass.';

const isEmpty = (text: string): boolean => text.trim() === '';

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, i) => item === b[i]);

const contentOf = (issue: ExternalIssue, parsed: ManagedLabels): ManagedContent => ({
  title: issue.title,
  specification: issue.body,
  labels: [...parsed.contentLabels],
  autonomyMode: parsed.autonomyMode,
  model: parsed.model,
});

const isTextChanged = (task: Task, content: ManagedContent): boolean =>
  task.title !== content.title || task.specification !== content.specification;

const isContentChanged = (task: Task, content: ManagedContent): boolean =>
  isTextChanged(task, content) ||
  !sameList(task.labels, content.labels) ||
  task.autonomyMode !== content.autonomyMode ||
  task.model !== content.model;

/**
 * Creates managed tasks from the provider's issues that carry the factory
 * label, and keeps their title, specification, labels and configuration in
 * step until they start. Issue text is untrusted: it goes into the task as
 * it is and never into the log.
 */
export class IssueSync {
  readonly #deps: IssueSyncDeps;
  readonly #log: (message: string) => void;
  readonly #newId: () => string;

  constructor(deps: IssueSyncDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? ((message) => console.error(message));
    this.#newId = deps.newId ?? (() => randomBytes(5).toString('hex'));
  }

  /** One pass over every labelled issue; one failing issue does not stop the others. */
  async sync(): Promise<void> {
    const withoutProject: string[] = [];
    for (const issue of await this.#deps.provider.listIssues(factoryLabel)) {
      try {
        await this.#sync(issue, withoutProject);
      } catch (error) {
        this.#log(`issue sync: ${issue.url}: ${redact(describe(error), this.#deps.secrets)}`);
      }
    }
    // One line per pass, not per issue: an issue waiting for its project label is no error.
    if (withoutProject.length > 0) {
      this.#log(`issue sync: skipped ${withoutProject.length} issues without a known project label: ${withoutProject.join(', ')}`);
    }
  }

  async #sync(issue: ExternalIssue, withoutProject: string[]): Promise<void> {
    const parsed = parseManagedLabels(issue.labels);
    if (!parsed.isManaged) return;
    const task = this.#deps.tasks.findByExternalUrl(issue.url);
    if (task) return this.#update(task, issue, parsed);
    return this.#import(issue, parsed, withoutProject);
  }

  async #update(task: Task, issue: ExternalIssue, parsed: ManagedLabels): Promise<void> {
    // Ensured on every pass: the provider posts a key once, so this only
    // recovers a comment whose first attempt failed after the task was saved.
    await this.#commentTaskId(issue, task);
    if (task.status !== 'draft' && task.status !== 'clarification_required') return;
    await this.#commentConflicts(issue, parsed);
    if (isEmpty(issue.body)) return this.#deps.provider.comment(issue.url, emptyBodyKey, emptyBodyComment);
    const content = contentOf(issue, parsed);
    if (!isContentChanged(task, content)) return;
    const isTextChange = isTextChanged(task, content);
    // Back to draft in the same change, so the spec review sees the new text.
    this.#deps.tasks.update(task.id, 'system', (current) => {
      const synced = syncManagedContent(current, content);
      return isTextChange && synced.status === 'clarification_required' ? returnToDraft(synced) : synced;
    });
  }

  async #import(issue: ExternalIssue, parsed: ManagedLabels, withoutProject: string[]): Promise<void> {
    if (!issue.isOpen) return;
    await this.#commentConflicts(issue, parsed);
    const { projectId } = parsed;
    if (projectId === undefined || this.#deps.projects.get(projectId) === undefined) {
      withoutProject.push(issue.url);
      return;
    }
    if (isEmpty(issue.body)) return this.#deps.provider.comment(issue.url, emptyBodyKey, emptyBodyComment);
    const { tasks } = this.#deps;
    const { provider, url, key } = issue;
    const task = createTask(
      { ...contentOf(issue, parsed), projectId, repoUrl: issue.repoUrl },
      { id: this.#newId(), now: tasks.now(), rank: nextRank(tasks.list()), external: { provider, url, key } },
    );
    tasks.insert(task, 'system');
    await this.#commentTaskId(issue, task);
  }

  #commentTaskId(issue: ExternalIssue, task: Task): Promise<void> {
    return this.#deps.provider.comment(issue.url, 'task-id', `The factory tracks this issue as task \`${task.id}\`.`);
  }

  /** Keyed by the conflicts, so the same ones are noted once and new ones again. */
  #commentConflicts(issue: ExternalIssue, parsed: ManagedLabels): Promise<void> {
    if (parsed.conflicts.length === 0) return Promise.resolve();
    const notes = parsed.conflicts.join('\n');
    const key = `config-conflict:${createHash('sha256').update(notes).digest('hex').slice(0, 16)}`;
    const body = `Some factory labels contradict each other; the defaults apply:\n\n${parsed.conflicts.map((note) => `- ${note}`).join('\n')}`;
    return this.#deps.provider.comment(issue.url, key, body);
  }
}

import { createHash, randomBytes } from 'node:crypto';
import {
  assertDeletable,
  createTask,
  factoryLabel,
  isEditable,
  nextRank,
  parseManagedLabels,
  returnToDraft,
  startLabel,
  startTask,
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
  tasks: Pick<TaskStore, 'findByExternalUrl' | 'insert' | 'update' | 'delete' | 'list' | 'now'>;
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
 * label, keeps their title, specification, labels and configuration in step
 * until they start, starts them on the start label, and deletes them when
 * their issue is closed or loses the factory label before they start. Issue
 * text is untrusted: it goes into the task as it is and never into the log.
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
    // A failed list throws before anything changes, so a provider that did not answer deletes nothing.
    const issues = await this.#deps.provider.listIssues(factoryLabel);
    const withoutProject: string[] = [];
    for (const issue of issues) {
      await this.#guard(issue.url, () => this.#sync(issue, withoutProject));
    }
    await this.#deleteUnlabelled(new Set(issues.map((issue) => issue.url)));
    // One line per pass, not per issue: an issue waiting for its project label is no error.
    if (withoutProject.length > 0) {
      this.#log(`issue sync: skipped ${withoutProject.length} issues without a known project label: ${withoutProject.join(', ')}`);
    }
  }

  async #guard(url: string, step: () => Promise<void> | void): Promise<void> {
    try {
      await step();
    } catch (error) {
      this.#log(`issue sync: ${url}: ${redact(describe(error), this.#deps.secrets)}`);
    }
  }

  /**
   * An unstarted managed task whose issue is missing from the list lost the
   * factory label, but only if the list covers the issue's repository: one
   * no longer configured is not looked at.
   */
  async #deleteUnlabelled(listed: ReadonlySet<string>): Promise<void> {
    for (const task of this.#deps.tasks.list()) {
      const url = task.external?.url;
      if (url === undefined || !isEditable(task.status) || listed.has(url) || !this.#deps.provider.covers(url)) continue;
      await this.#guard(url, () => this.#delete(task));
    }
  }

  /** As the engineer's delete: refused while an unstarted task depends on it, so a later pass tries again. */
  #delete(task: Task): void {
    assertDeletable(task.id, this.#deps.tasks.list());
    this.#deps.tasks.delete(task.id);
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
    // After start the issue no longer steers the task; a start label left by a failed removal goes now.
    if (!isEditable(task.status)) {
      if (parsed.wantsStart) await this.#removeStartLabel(issue);
      return;
    }
    if (!issue.isOpen) return this.#delete(task);
    await this.#commentConflicts(issue, parsed);
    // Nothing to vouch for yet: the start waits, label and all, until the issue has a description.
    if (isEmpty(issue.body)) return this.#deps.provider.comment(issue.url, emptyBodyKey, emptyBodyComment);
    this.#syncContent(task, contentOf(issue, parsed));
    if (!parsed.wantsStart) return;
    this.#deps.tasks.update(task.id, 'system', startTask);
    await this.#removeStartLabel(issue);
  }

  #syncContent(task: Task, content: ManagedContent): void {
    if (!isContentChanged(task, content)) return;
    const isTextChange = isTextChanged(task, content);
    // Back to draft in the same change, so the spec review sees the new text.
    this.#deps.tasks.update(task.id, 'system', (current) => {
      const synced = syncManagedContent(current, content);
      return isTextChange && synced.status === 'clarification_required' ? returnToDraft(synced) : synced;
    });
  }

  /** Removes the start label as written on the issue, since labels match case-insensitively. */
  #removeStartLabel(issue: ExternalIssue): Promise<void> {
    const remove = issue.labels.filter((label) => label.toLowerCase() === startLabel);
    return this.#deps.provider.changeLabels(issue.url, { add: [], remove });
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

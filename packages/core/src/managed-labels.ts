import { transitions } from './status.ts';
import type { AutonomyMode, TaskModel, TaskStatus } from './task.ts';

/*
 * Labels on a provider issue are the control channel of a managed task.
 * GitHub label names are case-insensitive, so every label in the `factory`
 * namespace is matched case-insensitively; a project id keeps the case it was
 * written in. Content labels are kept exactly as written.
 */

export const factoryLabel = 'factory';
export const startLabel = 'factory:start';
export const projectLabelPrefix = 'factory:project:';
export const statusLabelPrefix = 'factory:status:';
export const autonomyLabels: Readonly<Record<AutonomyMode, string>> = {
  autonomous: 'factory:autonomous',
  supervised: 'factory:supervised',
};
export const modelLabels: Readonly<Record<TaskModel, string>> = {
  opus: 'factory:model:opus',
  sonnet: 'factory:model:sonnet',
};

const defaultAutonomyMode: AutonomyMode = 'autonomous';
const defaultModel: TaskModel = 'opus';

export interface ManagedLabels {
  isManaged: boolean;
  /** Unset when no project label is present, or when several name different projects. */
  projectId?: string;
  wantsStart: boolean;
  autonomyMode: AutonomyMode;
  model: TaskModel;
  /** Labels outside the `factory` namespace, in first-seen order, each once. */
  contentLabels: readonly string[];
  /** Human-readable notes on contradictory labels; the default applies to each. */
  conflicts: readonly string[];
}

const isFactoryLabel = (label: string): boolean => label.toLowerCase().startsWith(factoryLabel);

const hasLabel = (labels: readonly string[], wanted: string): boolean =>
  labels.some((label) => label.toLowerCase() === wanted);

/** The one option whose label is present; the default when none or several are, noting the latter. */
function pickOption<T extends string>(
  labels: readonly string[],
  options: Readonly<Record<T, string>>,
  fallback: T,
  conflicts: string[],
): T {
  const present = (Object.keys(options) as T[]).filter((option) => hasLabel(labels, options[option]));
  if (present.length <= 1) return present[0] ?? fallback;
  conflicts.push(`${present.map((option) => options[option]).join(' and ')} are both set; using ${fallback}`);
  return fallback;
}

function pickProjectId(labels: readonly string[], conflicts: string[]): string | undefined {
  const ids = new Set(
    labels
      .filter((label) => label.toLowerCase().startsWith(projectLabelPrefix))
      .map((label) => label.slice(projectLabelPrefix.length))
      .filter((id) => id !== ''),
  );
  if (ids.size <= 1) return [...ids][0];
  conflicts.push(`several project labels are set (${[...ids].join(', ')}); no project is used`);
  return undefined;
}

/** Reads an issue's labels; unknown `factory*` labels are ignored. */
export function parseManagedLabels(labels: readonly string[]): ManagedLabels {
  const conflicts: string[] = [];
  const projectId = pickProjectId(labels, conflicts);
  const parsed: ManagedLabels = {
    isManaged: hasLabel(labels, factoryLabel),
    wantsStart: hasLabel(labels, startLabel),
    autonomyMode: pickOption(labels, autonomyLabels, defaultAutonomyMode, conflicts),
    model: pickOption(labels, modelLabels, defaultModel, conflicts),
    contentLabels: [...new Set(labels.filter((label) => !isFactoryLabel(label)))],
    conflicts,
  };
  return projectId === undefined ? parsed : { ...parsed, projectId };
}

/** `input_required` becomes `factory:status:input-required`. */
export const statusLabel = (status: TaskStatus): string => statusLabelPrefix + status.replaceAll('_', '-');

export interface LabelChanges {
  add: readonly string[];
  /** Labels as they are written on the issue, so the provider finds them. */
  remove: readonly string[];
}

/**
 * The changes that leave exactly one status label, the wanted one. Any other
 * `factory:status:*` label is removed, including ones a human set; labels
 * outside that prefix are never touched.
 */
export function statusLabelChanges(current: readonly string[], status: TaskStatus): LabelChanges {
  const wanted = statusLabel(status);
  const statusLabels = current.filter((label) => label.toLowerCase().startsWith(statusLabelPrefix));
  const kept = statusLabels.find((label) => label.toLowerCase() === wanted);
  return {
    add: kept === undefined ? [wanted] : [],
    remove: statusLabels.filter((label) => label !== kept),
  };
}

/**
 * What deleting a managed task removes from its issue, so the sync does not
 * import it again: the marker, the start command and every status label.
 * Project and config labels stay, so adding `factory` again restores the setup.
 */
export function deletionLabelChanges(): { add: string[]; remove: string[] } {
  const statuses = Object.keys(transitions) as TaskStatus[];
  return { add: [], remove: [factoryLabel, startLabel, ...statuses.map(statusLabel)] };
}

/** Scoped by task, so a task imported again from the same issue and deleted again gets its own comment. */
export const deletedCommentKey = (taskId: string): string => `${taskId}:task-deleted`;
export const deletedCommentBody =
  'The task for this issue was deleted in the factory, and its factory labels were removed. ' +
  `Add the \`${factoryLabel}\` label again to import this issue as a new task.`;

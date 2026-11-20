import { transitions } from './status.ts';
import type { AutonomyMode, TaskModel, TaskStatus } from './task.ts';

/*
 * Labels on a provider issue are the control channel of a managed task.
 * GitHub label names are case-insensitive, so every label in the `factory`
 * namespace is matched case-insensitively. Content labels are kept exactly as
 * written.
 */

export const factoryLabel = 'factory';
export const projectLabelPrefix = 'factory:project:';
export const autonomyLabels: Readonly<Record<AutonomyMode, string>> = {
  autonomous: 'factory:mode:autonomous',
  supervised: 'factory:mode:supervised',
};
export const modelLabels: Readonly<Record<TaskModel, string>> = {
  opus: 'factory:model:opus',
  sonnet: 'factory:model:sonnet',
};

const defaultAutonomyMode: AutonomyMode = 'autonomous';
const defaultModel: TaskModel = 'opus';

/** `input_required` becomes `factory:input-required`. */
export const statusLabel = (status: TaskStatus): string => `${factoryLabel}:${status.replaceAll('_', '-')}`;

const statusLabels: readonly string[] = (Object.keys(transitions) as TaskStatus[]).map(statusLabel);

/** The factory writes it; the project comes from the attachment that covers the issue's repository. */
export const projectLabel = (projectId: string): string => projectLabelPrefix + projectId;

export interface ManagedLabels {
  isManaged: boolean;
  /** A human starts a task by setting the status it moves to, `factory:queued`. */
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

/** Reads an issue's labels; unknown `factory*` labels are ignored. */
export function parseManagedLabels(labels: readonly string[]): ManagedLabels {
  const conflicts: string[] = [];
  return {
    isManaged: hasLabel(labels, factoryLabel),
    wantsStart: hasLabel(labels, statusLabel('queued')),
    autonomyMode: pickOption(labels, autonomyLabels, defaultAutonomyMode, conflicts),
    model: pickOption(labels, modelLabels, defaultModel, conflicts),
    contentLabels: [...new Set(labels.filter((label) => !isFactoryLabel(label)))],
    conflicts,
  };
}

export interface LabelChanges {
  add: readonly string[];
  /** Labels as they are written on the issue, so the provider finds them. */
  remove: readonly string[];
}

export const noLabelChanges: LabelChanges = { add: [], remove: [] };

/** Keeps exactly one of `current`'s labels that `isOfClass`, the wanted one, adding it if missing. */
function keepOnly(current: readonly string[], isOfClass: (lowered: string) => boolean, wanted: string): LabelChanges {
  const ofClass = current.filter((label) => isOfClass(label.toLowerCase()));
  const kept = ofClass.find((label) => label.toLowerCase() === wanted.toLowerCase());
  return { add: kept === undefined ? [wanted] : [], remove: ofClass.filter((label) => label !== kept) };
}

/**
 * The changes that leave exactly one status label, the wanted one. Any other
 * status label is removed, including one a human set; no other label is touched.
 */
export const statusLabelChanges = (current: readonly string[], status: TaskStatus): LabelChanges =>
  keepOnly(current, (label) => statusLabels.includes(label), statusLabel(status));

/** The changes that leave exactly one project label, the task's; one a human set or changed is corrected. */
export const projectLabelChanges = (current: readonly string[], projectId: string): LabelChanges =>
  keepOnly(current, (label) => label.startsWith(projectLabelPrefix), projectLabel(projectId));

export const mergeLabelChanges = (...changes: readonly LabelChanges[]): LabelChanges => ({
  add: changes.flatMap((change) => change.add),
  remove: changes.flatMap((change) => change.remove),
});

/**
 * What deleting a managed task removes from its issue, so the sync does not
 * import it again: the marker, every status label and the project label.
 * Config labels stay, so adding `factory` again restores the setup.
 */
export function deletionLabelChanges(projectId: string): { add: string[]; remove: string[] } {
  return { add: [], remove: [factoryLabel, ...statusLabels, projectLabel(projectId)] };
}

/** Scoped by task, so a task imported again from the same issue and deleted again gets its own comment. */
export const deletedCommentKey = (taskId: string): string => `${taskId}:task-deleted`;
export const deletedCommentBody =
  'The task for this issue was deleted in the factory, and its factory labels were removed. ' +
  `Add the \`${factoryLabel}\` label again to import this issue as a new task.`;

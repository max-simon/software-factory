import { DomainError } from './errors.ts';
import type { Task, TaskStatus } from './task.ts';

// A task waits in `queued` until every task it depends on is `done`; the
// dispatcher skips it meanwhile. Dependencies stay within one project and
// never form a cycle, which would hold its tasks queued forever.

type Node = Pick<Task, 'id' | 'projectId' | 'status' | 'dependsOn'>;

const unstartedStatuses: readonly TaskStatus[] = ['draft', 'clarification_required', 'queued'];

/** Until a task starts, its dependencies can still change and still hold it back. */
export const hasStarted = (status: TaskStatus): boolean => !unstartedStatuses.includes(status);

/**
 * Its dependencies that are not done yet. A deleted dependency counts as met:
 * deleting is refused while a task that has not started depends on it, so only
 * tasks that already ran, and may be restarted, refer to deleted ones.
 */
export function unmetDependencies<T extends Node>(task: Pick<Task, 'dependsOn'>, tasks: readonly T[]): T[] {
  return task.dependsOn.flatMap((id) => tasks.filter((other) => other.id === id && other.status !== 'done'));
}

export const isBlocked = (task: Pick<Task, 'dependsOn'>, tasks: readonly Node[]): boolean =>
  unmetDependencies(task, tasks).length > 0;

/** Tasks that have not started and depend on task `id`, so deleting it would hold them back forever. */
export const waitingDependents = <T extends Node>(id: string, tasks: readonly T[]): T[] =>
  tasks.filter((task) => !hasStarted(task.status) && task.dependsOn.includes(id));

/** Refuses to delete task `id` while a task that has not started depends on it; `tasks` are all tasks. */
export function assertDeletable(id: string, tasks: readonly Node[]): void {
  const waiting = waitingDependents(id, tasks);
  if (waiting.length === 0) return;
  const ids = waiting.map((task) => task.id).join(', ');
  throw new DomainError(
    'has_waiting_dependents',
    `task ${id} cannot be deleted: ${ids} depend on it and have not started; change their dependencies first`,
  );
}

/** Replaces the dependencies of a task that has not started; `tasks` are all tasks. */
export function setDependencies(task: Task, dependsOn: readonly string[], tasks: readonly Node[]): Task {
  if (hasStarted(task.status)) {
    throw new DomainError('not_editable', `task is ${task.status}, dependencies can change only until it starts`);
  }
  assertValidDependencies(task, dependsOn, tasks);
  return { ...task, dependsOn: [...dependsOn] };
}

/** `task` may be new and not among `tasks` yet. */
export function assertValidDependencies(task: Pick<Task, 'id' | 'projectId'>, dependsOn: readonly string[], tasks: readonly Node[]): void {
  if (new Set(dependsOn).size !== dependsOn.length) invalid('dependencies must not repeat');
  for (const id of dependsOn) {
    if (id === task.id) invalid('a task cannot depend on itself');
    const dependency = tasks.find((other) => other.id === id);
    if (!dependency) throw new DomainError('unknown_task', `there is no task ${id}`);
    if (dependency.projectId !== task.projectId) invalid(`task ${id} belongs to another project`);
  }
  const cycle = cycleThrough(task.id, dependsOn, tasks);
  if (cycle) invalid(`dependencies would form a cycle: ${cycle.join(' → ')}`);
}

/** The stored graph has no cycle, so a new one must run through the task whose dependencies change. */
function cycleThrough(id: string, dependsOn: readonly string[], tasks: readonly Node[]): string[] | undefined {
  const edges = new Map<string, readonly string[]>(tasks.map((task) => [task.id, task.dependsOn]));
  edges.set(id, dependsOn);
  const visited = new Set<string>();
  const walk = (path: string[]): string[] | undefined => {
    for (const next of edges.get(path.at(-1)!) ?? []) {
      if (next === id) return [...path, next];
      if (visited.has(next)) continue;
      visited.add(next);
      const cycle = walk([...path, next]);
      if (cycle) return cycle;
    }
    return undefined;
  };
  return walk([id]);
}

function invalid(message: string): never {
  throw new DomainError('invalid_dependencies', message);
}

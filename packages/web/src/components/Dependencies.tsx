import { hasStarted } from '@factory/core';
import { useState } from 'react';
import { api } from '../api.ts';
import { useAction, usePolling } from '../hooks.ts';
import { href, type TaskView } from '../model.ts';
import { ErrorText } from './ErrorText.tsx';
import { StatusLabel } from './Status.tsx';

/**
 * Checkboxes over the project's other tasks. Done tasks are offered only when
 * already chosen: depending on one changes nothing.
 */
export function DependencyPicker({
  candidates,
  selected,
  onChange,
}: {
  candidates: readonly TaskView[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const shown = candidates.filter((task) => task.status !== 'done' || selected.includes(task.id));
  if (shown.length === 0) return <p className="muted">No other open tasks in this project.</p>;
  const toggle = (id: string, isChecked: boolean) =>
    onChange(isChecked ? [...selected, id] : selected.filter((other) => other !== id));
  return (
    <ul className="plain dependency-picker">
      {shown.map((task) => (
        <li key={task.id}>
          <label className="check">
            <input type="checkbox" checked={selected.includes(task.id)} onChange={(e) => toggle(task.id, e.target.checked)} />
            <span>
              {task.title} <StatusLabel status={task.status} />
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

/** What the task waits for; editable until it starts. */
export function DependenciesSection({ task, onChange }: { task: TaskView; onChange: (task: TaskView) => void }) {
  const { data: projectTasks } = usePolling(() => api.listProjectTasks(task.projectId), `deps-${task.projectId}`);
  const [draft, setDraft] = useState<string[]>();
  const { isBusy, error, run } = useAction();
  const others = (projectTasks ?? []).filter((other) => other.id !== task.id);
  const isEditable = !hasStarted(task.status);

  const save = (dependsOn: string[]) =>
    void run(async () => {
      onChange(await api.editTask(task.id, { dependsOn }));
      setDraft(undefined);
    });

  return (
    <section className="box">
      <h2 className="section-title">Depends on</h2>
      {draft ? (
        <DependencyPicker candidates={others} selected={draft} onChange={setDraft} />
      ) : (
        <DependencyList ids={task.dependsOn} tasks={others} isLoaded={projectTasks !== undefined} />
      )}
      {isEditable && task.status === 'queued' && task.dependsOn.length > 0 && !draft && (
        <p className="muted">Starts once every task above is done.</p>
      )}
      <ErrorText message={error} />
      {isEditable && (
        <div className="actions">
          {draft ? (
            <>
              <button className="button" onClick={() => setDraft(undefined)}>
                Cancel
              </button>
              <button className="button primary" disabled={isBusy} onClick={() => save(draft)}>
                Save
              </button>
            </>
          ) : (
            <button className="button" disabled={projectTasks === undefined} onClick={() => setDraft(task.dependsOn)}>
              Edit dependencies
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function DependencyList({ ids, tasks, isLoaded }: { ids: readonly string[]; tasks: readonly TaskView[]; isLoaded: boolean }) {
  if (ids.length === 0) return <p className="muted">None: the task starts as soon as a worker is free.</p>;
  return (
    <ul className="plain">
      {ids.map((id) => {
        const dependency = tasks.find((other) => other.id === id);
        return (
          <li key={id}>
            {dependency ? (
              <>
                <a href={href.task(id)}>{dependency.title}</a> <StatusLabel status={dependency.status} />
              </>
            ) : (
              <span className="muted">
                <span className="mono">{id}</span> {isLoaded ? '(deleted)' : ''}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

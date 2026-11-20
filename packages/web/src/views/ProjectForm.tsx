import type { Project, TaskProviderAttachment } from '@factory/core';
import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { ErrorText } from '../components/ErrorText.tsx';
import { hasUnaddedTaskProvider, TaskProviders } from '../components/TaskProviders.tsx';
import { useAction, usePolling } from '../hooks.ts';
import { href } from '../model.ts';

type OnSaved = (project: Project) => void;

/** Refuses a form with an attachment typed in but not added, which saving would silently drop. */
function fields(form: FormData, taskProviders: TaskProviderAttachment[]) {
  if (hasUnaddedTaskProvider(form)) throw new Error('Add the task provider you entered, or clear its fields, before saving.');
  return {
    title: String(form.get('title')).trim(),
    description: String(form.get('description')),
    autoMerge: form.get('autoMerge') === 'on',
    taskProviders,
  };
}

export function NewProject({ onSaved }: { onSaved: OnSaved }) {
  const { isBusy, error, run } = useAction();
  const [taskProviders, setTaskProviders] = useState<TaskProviderAttachment[]>([]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(async () => {
      const created = await api.createProject(fields(form, taskProviders));
      onSaved(created);
      location.hash = href.project(created.id);
    });
  };
  return (
    <form className="task-form" onSubmit={submit}>
      <h1>New project</h1>
      <ProjectFields taskProviders={taskProviders} onTaskProvidersChange={setTaskProviders} />
      <ErrorText message={error} />
      <div className="actions">
        <button className="button primary" disabled={isBusy}>
          Create project
        </button>
        <a className="link" href={href.home}>
          Cancel
        </a>
      </div>
    </form>
  );
}

export function EditProject({ id, onSaved }: { id: string; onSaved: OnSaved }) {
  const { data: project, error: loadError } = usePolling(() => api.getProject(id), `edit-project-${id}`);
  if (!project) return <p className="muted">{loadError ? loadError.message : 'Loading…'}</p>;
  return <EditProjectForm project={project} onSaved={onSaved} />;
}

// Mounted once the project loaded, so the attachments start from it and polling never resets them.
function EditProjectForm({ project, onSaved }: { project: Project; onSaved: OnSaved }) {
  const { id } = project;
  const { isBusy, error, run } = useAction();
  const [taskProviders, setTaskProviders] = useState(project.taskProviders);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(async () => {
      onSaved(await api.editProject(id, fields(form, taskProviders)));
      location.hash = href.project(id);
    });
  };
  return (
    <form className="task-form" onSubmit={submit}>
      <h1>Edit project</h1>
      <ProjectFields project={project} taskProviders={taskProviders} onTaskProvidersChange={setTaskProviders} />
      <ErrorText message={error} />
      <div className="actions">
        <button className="button primary" disabled={isBusy}>
          Save
        </button>
        <a className="link" href={href.project(id)}>
          Cancel
        </a>
      </div>
    </form>
  );
}

// Uncontrolled but for the attachments, so polling never overwrites what the engineer is typing.
function ProjectFields({
  project,
  taskProviders,
  onTaskProvidersChange,
}: {
  project?: Project;
  taskProviders: TaskProviderAttachment[];
  onTaskProvidersChange: (next: TaskProviderAttachment[]) => void;
}) {
  return (
    <>
      <label className="field">
        <span>Title</span>
        <input name="title" defaultValue={project?.title} required autoFocus />
      </label>
      <label className="field">
        <span>Description</span>
        <textarea name="description" defaultValue={project?.description} rows={10} placeholder="Markdown" />
      </label>
      <label className="check">
        <input type="checkbox" name="autoMerge" defaultChecked={project?.autoMerge} />
        <span>
          Auto-merge
          <span className="hint">Every pull request gets a PR review; merge those it rates low risk without a human.</span>
        </span>
      </label>
      <TaskProviders value={taskProviders} onChange={onTaskProvidersChange} />
    </>
  );
}

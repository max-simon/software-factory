import type { Project } from '@factory/core';
import type { FormEvent } from 'react';
import { api } from '../api.ts';
import { ErrorText } from '../components/ErrorText.tsx';
import { useAction, usePolling } from '../hooks.ts';
import { href } from '../model.ts';

type OnSaved = (project: Project) => void;

const fields = (form: FormData) => ({
  title: String(form.get('title')).trim(),
  description: String(form.get('description')),
  autoMerge: form.get('autoMerge') === 'on',
});

export function NewProject({ onSaved }: { onSaved: OnSaved }) {
  const { isBusy, error, run } = useAction();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = fields(new FormData(event.currentTarget));
    void run(async () => {
      const created = await api.createProject(input);
      onSaved(created);
      location.hash = href.project(created.id);
    });
  };
  return (
    <form className="task-form" onSubmit={submit}>
      <h1>New project</h1>
      <ProjectFields />
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
  const { isBusy, error, run } = useAction();
  if (!project) return <p className="muted">{loadError ? loadError.message : 'Loading…'}</p>;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const edit = fields(new FormData(event.currentTarget));
    void run(async () => {
      onSaved(await api.editProject(id, edit));
      location.hash = href.project(id);
    });
  };
  return (
    <form className="task-form" onSubmit={submit}>
      <h1>Edit project</h1>
      <ProjectFields project={project} />
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

// Uncontrolled, so polling never overwrites what the engineer is typing.
function ProjectFields({ project }: { project?: Project }) {
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
    </>
  );
}

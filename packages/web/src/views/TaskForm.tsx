import { isEditable, type NewTask, type Project, type TaskAgent, type TaskModel } from '@factory/core';
import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { DependencyPicker } from '../components/Dependencies.tsx';
import { ErrorText } from '../components/ErrorText.tsx';
import { useAction, usePolling } from '../hooks.ts';
import { agentLabels, href, parseLabels, type TaskView } from '../model.ts';

const open = (task: TaskView) => {
  location.hash = href.task(task.id);
};

/** `project` is undefined until the project list has loaded. */
export function NewTask({ projectId, project }: { projectId: string; project: Project | undefined }) {
  const [repoUrl, setRepoUrl] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [isSupervised, setSupervised] = useState(false);
  const [model, setModel] = useState<TaskModel>('opus');
  const [agent, setAgent] = useState<TaskAgent>('claude');
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const { data: projectTasks } = usePolling(() => api.listProjectTasks(projectId), `new-task-${projectId}`);
  const { isBusy, error, run } = useAction();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const shouldStart = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'start';
    const common = commonFields(new FormData(event.currentTarget));
    const input: NewTask = {
      projectId,
      ...common,
      autonomyMode: isSupervised ? 'supervised' : 'autonomous',
      model,
      agent,
      ...(repoUrl.trim() && { repoUrl: repoUrl.trim() }),
      ...(repoUrl.trim() && baseBranch.trim() && { baseBranch: baseBranch.trim() }),
      ...(dependsOn.length > 0 && { dependsOn }),
    };
    void run(async () => {
      const created = await api.createTask(input);
      // Leave the form even if starting fails, so a retry cannot create the task twice.
      open(created);
      if (shouldStart) await api.startTask(created.id);
    });
  };

  return (
    <form className="task-form" onSubmit={submit}>
      <h1>New task</h1>
      {project && <p className="muted">in {project.title}</p>}
      <TitleAndSpecification />
      <label className="field">
        <span>Repository</span>
        <input
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          placeholder="https://github.com/owner/name — leave empty for tasks without code"
        />
      </label>
      {repoUrl.trim() && (
        <label className="field">
          <span>Base branch</span>
          <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="default branch" />
        </label>
      )}
      <LabelsField />
      <label className="field">
        <span>Model</span>
        <select value={model} onChange={(e) => setModel(e.target.value as TaskModel)}>
          <option value="opus">Opus</option>
          <option value="sonnet">Sonnet</option>
        </select>
      </label>
      <label className="field">
        <span>Agent</span>
        <select value={agent} onChange={(e) => setAgent(e.target.value as TaskAgent)}>
          {Object.entries(agentLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {projectTasks && projectTasks.length > 0 && (
        <div className="field">
          <span>Depends on</span>
          <span className="hint">Once started, the task waits in the queue until these are done.</span>
          <DependencyPicker candidates={projectTasks} selected={dependsOn} onChange={setDependsOn} />
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={isSupervised} onChange={(e) => setSupervised(e.target.checked)} />
        <span>
          Supervised
          <span className="hint">The agent may ask questions and request approval of decisions and artifacts.</span>
        </span>
      </label>
      <ErrorText message={error} />
      <div className="actions">
        <button className="button primary" name="intent" value="start" disabled={isBusy}>
          Create and start
        </button>
        <button className="button" name="intent" value="draft" disabled={isBusy}>
          Save draft
        </button>
        <a className="link" href={href.project(projectId)}>
          Cancel
        </a>
      </div>
    </form>
  );
}

export function EditTask({ id }: { id: string }) {
  const { data: task, error: loadError } = usePolling(() => api.getTask(id), `edit-${id}`);
  const { isBusy, error, run } = useAction();
  if (!task) return <p className="muted">{loadError ? loadError.message : 'Loading…'}</p>;
  if (!isEditable(task.status)) return <p className="muted">Only tasks that are not queued yet can be edited.</p>;
  if (task.external) {
    return <p className="muted">Title, specification and labels of this task come from {task.external.key}; change them there.</p>;
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const edit = commonFields(new FormData(event.currentTarget));
    void run(async () => open(await api.editTask(id, edit)));
  };

  return (
    <form className="task-form" onSubmit={submit}>
      <h1>Edit task</h1>
      <TitleAndSpecification task={task} />
      <LabelsField task={task} />
      <ErrorText message={error} />
      <div className="actions">
        <button className="button primary" disabled={isBusy}>
          Save
        </button>
        <a className="link" href={href.task(id)}>
          Cancel
        </a>
      </div>
    </form>
  );
}

// Uncontrolled, so polling the task never overwrites what the engineer is typing.
function TitleAndSpecification({ task }: { task?: TaskView }) {
  return (
    <>
      <label className="field">
        <span>Title</span>
        <input name="title" defaultValue={task?.title} required autoFocus />
      </label>
      <label className="field">
        <span>Specification</span>
        <textarea name="specification" defaultValue={task?.specification} required rows={14} placeholder="Markdown" />
      </label>
    </>
  );
}

function LabelsField({ task }: { task?: TaskView }) {
  return (
    <label className="field">
      <span>Labels</span>
      <input name="labels" defaultValue={task?.labels.join(', ')} placeholder="comma separated" />
    </label>
  );
}

function commonFields(form: FormData): { title: string; specification: string; labels: string[] } {
  return {
    title: String(form.get('title')).trim(),
    specification: String(form.get('specification')),
    labels: parseLabels(String(form.get('labels') ?? '')),
  };
}

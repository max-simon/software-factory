import {
  describeTaskProvider,
  hasTaskProvider,
  parseTaskProviderAttachment,
  taskProviderKinds,
  taskProviderTypes,
  type TaskProviderAttachment,
  type TaskProviderKind,
} from '@factory/core';
import { useState, type KeyboardEvent } from 'react';
import { ErrorText } from './ErrorText.tsx';

/** Form fields of the attachment being added carry this prefix, so the form can tell one was left unadded. */
export const draftFieldPrefix = 'taskProviderDraft:';

/** Whether the engineer typed an attachment into the form but did not add it. */
export const hasUnaddedTaskProvider = (form: FormData): boolean =>
  [...form.entries()].some(([name, value]) => name.startsWith(draftFieldPrefix) && String(value).trim() !== '');

/**
 * The project's task provider attachments, edited locally: the parent saves
 * the list with the rest of the project form.
 */
export function TaskProviders({
  value,
  onChange,
  projectId,
}: {
  value: readonly TaskProviderAttachment[];
  onChange: (next: TaskProviderAttachment[]) => void;
  /** Unset for a project not created yet. */
  projectId?: string;
}) {
  const [kind, setKind] = useState<TaskProviderKind>(taskProviderKinds[0]!);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const type = taskProviderTypes[kind];

  const add = () => {
    const trimmed = Object.fromEntries(type.fields.map(({ name }) => [name, (config[name] ?? '').trim()]));
    try {
      const attachment = parseTaskProviderAttachment({ provider: kind, ...trimmed });
      if (hasTaskProvider(value, attachment)) throw new Error(`${describeTaskProvider(attachment)} is already attached`);
      onChange([...value, attachment]);
      setConfig({});
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const selectKind = (selected: string) => {
    const next = taskProviderKinds.find((option) => option === selected);
    if (next === undefined) return;
    setKind(next);
    setConfig({});
    setError(undefined);
  };
  // Enter in a config field adds the attachment instead of saving the whole form.
  const addOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    add();
  };
  const projectLabel = `factory:project:${projectId ?? '<project id>'}`;

  return (
    <fieldset className="field task-providers">
      <legend>Task providers</legend>
      <span className="hint">
        Issues labelled <code>factory</code> and <code>{projectLabel}</code> in these sources become managed tasks of this project.
      </span>
      {value.length === 0 ? (
        <p className="muted task-providers-empty">None attached.</p>
      ) : (
        <ul className="plain token-list">
          {value.map((attachment, index) => (
            <li key={describeTaskProvider(attachment)}>
              <span className="token-name">{describeTaskProvider(attachment)}</span>
              <button
                type="button"
                className="button small danger"
                onClick={() => onChange(value.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="task-provider-add">
        <label className="field">
          <span>Provider</span>
          <select value={kind} onChange={(event) => selectKind(event.target.value)}>
            {taskProviderKinds.map((option) => (
              <option key={option} value={option}>
                {taskProviderTypes[option].title}
              </option>
            ))}
          </select>
        </label>
        {type.fields.map((field) => (
          <label key={field.name} className="field">
            <span>{field.label}</span>
            <input
              name={`${draftFieldPrefix}${field.name}`}
              value={config[field.name] ?? ''}
              placeholder={field.placeholder}
              onChange={(event) => setConfig({ ...config, [field.name]: event.target.value })}
              onKeyDown={addOnEnter}
            />
          </label>
        ))}
        <button type="button" className="button" onClick={add}>
          Add
        </button>
      </div>
      <ErrorText message={error} />
    </fieldset>
  );
}

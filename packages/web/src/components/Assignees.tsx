import { api } from '../api.ts';
import { useAction } from '../hooks.ts';
import { describeUser, type TaskView, type UserMap } from '../model.ts';
import { ErrorText } from './ErrorText.tsx';
import { UserName, useUsers } from './UserName.tsx';

/** Who works on the task; editable in every status. */
export function AssigneesSection({ task, onChange }: { task: TaskView; onChange: (task: TaskView) => void }) {
  const { users } = useUsers();
  const { isBusy, error, run } = useAction();
  const save = (assignees: string[]) => void run(async () => onChange(await api.setAssignees(task.id, assignees)));
  return (
    <section className="box">
      <h2 className="section-title">Assignees</h2>
      <AssigneeEditor assignees={task.assignees ?? []} users={users} isBusy={isBusy} error={error} onSave={save} />
    </section>
  );
}

/**
 * The assignees, each removable, and a picker for the active users not yet
 * assigned. A disabled user stays listed and removable: the control plane
 * keeps disabled users who were assigned before they were disabled.
 */
export function AssigneeEditor({
  assignees,
  users,
  isBusy,
  error,
  onSave,
}: {
  assignees: readonly string[];
  users: UserMap;
  isBusy: boolean;
  error: string | undefined;
  onSave: (assignees: string[]) => void;
}) {
  const candidates = [...users.values()].filter((user) => !user.disabled && !assignees.includes(user.id));
  return (
    <>
      {assignees.length === 0 ? (
        <p className="muted">Nobody is assigned.</p>
      ) : (
        <ul className="plain assignees">
          {assignees.map((id) => (
            <li key={id}>
              <UserName id={id} />
              {users.get(id)?.disabled && <span className="label">disabled</span>}
              <button
                className="link"
                disabled={isBusy}
                aria-label={`Remove ${describeUser(id, users).text}`}
                onClick={() => onSave(assignees.filter((other) => other !== id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {candidates.length > 0 && (
        <select
          className="assignee-picker"
          aria-label="Add assignee"
          value=""
          disabled={isBusy}
          onChange={(event) => onSave([...assignees, event.target.value])}
        >
          <option value="" disabled>
            Add assignee…
          </option>
          {candidates.map((user) => (
            <option key={user.id} value={user.id}>
              {user.displayName}
            </option>
          ))}
        </select>
      )}
      <ErrorText message={error} />
    </>
  );
}

/** The assignees as initials, for the board's cards; the full name shows on hover. */
export function AssigneeBadges({ assignees }: { assignees: readonly string[] | undefined }) {
  const { users } = useUsers();
  if (!assignees?.length) return null;
  return (
    <span className="assignee-badges">
      {assignees.map((id) => {
        const name = describeUser(id, users).text;
        return (
          <span key={id} className="assignee-badge" title={name}>
            {initials(name)}
          </span>
        );
      })}
    </span>
  );
}

const initials = (name: string): string => {
  const words = name.trim().split(/\s+/);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return letters.map((word) => (word ?? '').charAt(0)).join('').toUpperCase();
};

import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { toUserMap, type TaskView, type UserSummary } from '../model.ts';
import { Board } from '../views/Board.tsx';
import { AssigneeEditor } from './Assignees.tsx';
import { UsersProvider } from './UserName.tsx';

const user = (id: string, displayName: string, disabled = false): UserSummary => ({ id, username: id, displayName, disabled });
const users = toUserMap([user('u1', 'Ada Lovelace'), user('u2', 'Grace Hopper'), user('u3', 'Alan Turing', true)]);

const editor = (assignees: string[], overrides: { error?: string; onSave?: (ids: string[]) => void } = {}) => (
  <AssigneeEditor assignees={assignees} users={users} isBusy={false} error={overrides.error} onSave={overrides.onSave ?? (() => {})} />
);

const render = (node: ReactNode) => renderToStaticMarkup(<UsersProvider users={users}>{node}</UsersProvider>);

type Props = { children?: ReactNode; onClick?: () => void; onChange?: (event: unknown) => void; 'aria-label'?: string };

/** The host elements `AssigneeEditor` returns, without rendering, so their handlers can be called. */
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}

const rendered = (assignees: string[], onSave: (ids: string[]) => void) =>
  elements(AssigneeEditor({ assignees, users, isBusy: false, error: undefined, onSave }));

test('assignees show by display name, each with a remove control', () => {
  const html = render(editor(['u1', 'u2']));
  expect(html).toContain('title="u1 (u1)">Ada Lovelace</span>');
  expect(html).toContain('title="u2 (u2)">Grace Hopper</span>');
  expect(html).toContain('aria-label="Remove Ada Lovelace"');
  expect(html).toContain('aria-label="Remove Grace Hopper"');
});

test('a task without assignees says so', () => {
  expect(render(editor([]))).toContain('Nobody is assigned.');
});

test('the picker offers only active users not yet assigned', () => {
  const html = render(editor(['u1']));
  expect(html).toContain('<option value="u2">Grace Hopper</option>');
  expect(html).not.toContain('<option value="u1">');
  expect(html).not.toContain('<option value="u3">');
});

test('a disabled assignee is marked disabled and can still be removed', () => {
  const html = render(editor(['u3']));
  expect(html).toContain('>Alan Turing</span><span class="label">disabled</span>');
  expect(html).toContain('aria-label="Remove Alan Turing"');
});

test('picking a user adds it to the assignees', () => {
  const onSave = vi.fn();
  const picker = rendered(['u1'], onSave).find((element) => element.type === 'select');
  picker?.props.onChange?.({ target: { value: 'u2' } });
  expect(onSave).toHaveBeenCalledWith(['u1', 'u2']);
});

test('removing an assignee keeps the others', () => {
  const onSave = vi.fn();
  const remove = rendered(['u1', 'u2'], onSave).find((element) => element.props['aria-label'] === 'Remove Ada Lovelace');
  remove?.props.onClick?.();
  expect(onSave).toHaveBeenCalledWith(['u2']);
});

test('an error from the control plane shows next to the assignees', () => {
  const html = render(editor(['u1'], { error: 'user u3 is disabled' }));
  expect(html).toContain('<p class="error" role="alert">user u3 is disabled</p>');
});

const task = (overrides: Partial<TaskView>): TaskView => ({
  id: 't1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  projectId: 'p1',
  title: 'Task',
  specification: 's',
  labels: [],
  autonomyMode: 'autonomous',
  model: 'opus',
  agent: 'claude',
  status: 'draft',
  rank: 0,
  dependsOn: [],
  plan: [],
  decisions: [],
  artifacts: [],
  questions: [],
  pullRequests: [],
  followUps: [],
  isSpecUnderReview: false,
  isInputUnderReview: false,
  ...overrides,
});

test('a board card shows its assignees as initials with the full name on hover', () => {
  const html = render(<Board tasks={[task({ assignees: ['u1', 'u2'] })]} onMoved={() => {}} />);
  expect(html).toContain('<span class="assignee-badge" title="Ada Lovelace">AL</span>');
  expect(html).toContain('<span class="assignee-badge" title="Grace Hopper">GH</span>');
});

test('a board card without assignees shows no badges', () => {
  expect(render(<Board tasks={[task({})]} onMoved={() => {}} />)).not.toContain('assignee-badge');
});

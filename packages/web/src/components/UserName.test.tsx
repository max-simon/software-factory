import type { Project, TaskChange } from '@factory/core';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { describeChange, timeline, toUserMap, type TaskView, type UserSummary } from '../model.ts';
import { ProjectHeader } from '../views/ProjectOverview.tsx';
import { Header } from '../views/TaskDetail.tsx';
import { Changelog } from './Changelog.tsx';
import { Timeline } from './Timeline.tsx';
import { UserName, UsersProvider } from './UserName.tsx';

const at = '2026-01-01T00:00:00.000Z';
const ada = (displayName: string): UserSummary => ({ id: 'u1', username: 'ada', displayName, disabled: false });

const withUsers = (users: UserSummary[], node: ReactNode) =>
  renderToStaticMarkup(<UsersProvider users={toUserMap(users)}>{node}</UsersProvider>);

const task = (overrides: Partial<TaskView> = {}): TaskView => ({
  id: 't1',
  createdAt: at,
  createdBy: 'u1',
  updatedAt: at,
  projectId: 'p1',
  title: 'Task',
  specification: 's',
  labels: [],
  autonomyMode: 'supervised',
  model: 'opus',
  status: 'in_progress',
  rank: 0,
  dependsOn: [],
  plan: [],
  decisions: [
    { id: 'd1', createdAt: at, problem: 'Which?', options: ['a', 'b'], chosen: 0, reasoning: 'r', approval: { status: 'approved', reviewedBy: 'u1' } },
  ],
  artifacts: [],
  questions: [{ id: 'q1', createdAt: at, problem: 'Why?', type: 'text', options: [], answer: ['Because'], answeredBy: 'u1' }],
  pullRequests: [],
  followUps: [{ id: 'f1', createdAt: at, message: 'Also do this', authorId: 'u1' }],
  isSpecUnderReview: false,
  isInputUnderReview: false,
  ...overrides,
});

const project: Project = { id: 'p1', createdAt: at, createdBy: 'u1', updatedAt: at, title: 'P', description: '', autoMerge: false, taskProviders: [] };
const changes: TaskChange[] = [
  { at, actor: 'user', userId: 'u1', field: 'created' },
  { at, actor: 'user', userId: 'u1', field: 'title', from: 'A', to: 'B' },
];

/** Everything that names a person: changelog, timeline, task and project headers. */
const everything = (t: TaskView, p: Project, c: TaskChange[]) => (
  <>
    <Changelog changes={c} describe={describeChange} />
    <Timeline entries={timeline(t)} onOpenArtifact={() => {}} />
    <Header task={t} onChange={() => {}} />
    <ProjectHeader project={p} />
  </>
);

const count = (html: string, text: string) => html.split(text).length - 1;

test('a renamed user shows by the new name everywhere, with username and id on hover', () => {
  const before = withUsers([ada('Ada')], everything(task(), project, changes));
  const after = withUsers([ada('Ada Lovelace')], everything(task(), project, changes));
  const named = (name: string) => `<span class="user-name user-known" title="ada (u1)">${name}</span>`;
  // Two changes, an answer, an approval, a follow-up, the task and the project.
  expect(count(before, named('Ada'))).toBe(7);
  expect(count(after, named('Ada Lovelace'))).toBe(7);
  expect(after).not.toContain('>Ada<');
});

test('an id no user has shows as the id', () => {
  const html = withUsers([ada('Ada')], everything(task({ createdBy: 'gone' }), { ...project, createdBy: 'gone' }, [
    { at, actor: 'user', userId: 'gone', field: 'created' },
  ]));
  expect(count(html, 'title="Unknown user (gone)">gone</span>')).toBe(3);
  expect(withUsers([], <UserName id="u1" />)).toContain('>u1</span>');
});

test('entries from before users existed show as an unattributed engineer', () => {
  const legacy = task({
    createdBy: undefined,
    questions: [{ id: 'q1', createdAt: at, problem: 'Why?', type: 'text', options: [], answer: ['Because'] }],
    decisions: [{ id: 'd1', createdAt: at, problem: 'Which?', options: [], reasoning: 'r', approval: { status: 'approved' } }],
    followUps: [{ id: 'f1', createdAt: at, message: 'Also do this' }],
  });
  const { createdBy: _, ...legacyProject } = project;
  const html = withUsers([ada('Ada')], everything(legacy, legacyProject, [{ at, actor: 'user', field: 'created' }]));
  expect(count(html, '>engineer (unattributed)</span>')).toBe(6);
  expect(html).not.toContain('Ada');
});

test('the agent, reviewer and system keep their labels, and the reviewer’s input its mark', () => {
  const html = withUsers(
    [ada('Ada')],
    <>
      <Changelog
        changes={[
          { at, actor: 'agent', field: 'status', from: 'queued', to: 'in_progress' },
          { at, actor: 'reviewer', field: 'status', from: 'draft', to: 'queued' },
          { at, actor: 'system', field: 'status', from: 'in_progress', to: 'failed' },
        ] satisfies TaskChange[]}
        describe={describeChange}
      />
      <Timeline
        entries={timeline(
          task({
            questions: [{ id: 'q1', createdAt: at, problem: 'Why?', type: 'text', options: [], answer: ['Yes'], byReviewer: { rationale: 'Obvious.' } }],
            decisions: [{ id: 'd1', createdAt: at, problem: 'Which?', options: [], reasoning: 'r', approval: { status: 'approved', byReviewer: { rationale: 'Fine.' } } }],
            followUps: [],
          }),
        )}
        onOpenArtifact={() => {}}
      />
    </>,
  );
  expect(html).toContain('<span class="actor actor-agent">agent</span>');
  expect(html).toContain('<span class="actor actor-reviewer">reviewer</span>');
  expect(html).toContain('<span class="actor actor-system">system</span>');
  expect(html).toContain('by the reviewer: Obvious.');
  expect(html).toContain('by the reviewer: Fine.');
  expect(html).not.toContain('user-name');
});

test('a managed task the control plane imported shows as created by system, not as an engineer', () => {
  const external = { provider: 'github', url: 'https://github.com/o/r/issues/1', key: 'o/r#1' };
  const html = withUsers([ada('Ada')], <Header task={task({ createdBy: undefined, external })} onChange={() => {}} />);
  expect(html).toContain('created by system');
  expect(html).not.toContain('engineer (unattributed)');
});

test('a follow-up the system sent shows as by the system, not as an engineer', () => {
  const html = withUsers(
    [ada('Ada')],
    <Timeline
      entries={timeline(task({ questions: [], decisions: [], followUps: [{ id: 'f1', createdAt: at, message: 'Resolve it', bySystem: true }] }))}
      onOpenArtifact={() => {}}
    />,
  );
  expect(html).toContain('<span class="by-system">by the system</span>');
  expect(html).not.toContain('user-name');
});

import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import type { TaskView } from '../model.ts';
import { Board } from './Board.tsx';
import { OpenPullRequests } from './ProjectOverview.tsx';
import { Header, PullRequestList } from './TaskDetail.tsx';

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
  status: 'in_progress',
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
  execution: { id: 'e1', worker: { state: 'working', since: '2026-01-01T00:00:00.000Z' }, consoleUrl: 'https://console' },
  ...overrides,
});

const render = (t: TaskView) => renderToStaticMarkup(<Header task={t} onChange={() => {}} />);

test('an opencode task with a console offers to open it in OpenCode', () => {
  const html = render(task({ agent: 'opencode' }));
  expect(html).toContain('Open in OpenCode');
  expect(html).toContain('<span>OpenCode</span>');
});

test('a claude task has no OpenCode button even with a console url', () => {
  const html = render(task({ agent: 'claude' }));
  expect(html).not.toContain('Open in OpenCode');
  expect(html).toContain('<span>Claude CLI</span>');
});

const pr = (isUnderReview: boolean) => ({ url: 'https://github.com/o/r/pull/1', title: 'PR', status: 'open' as const, isUnderReview });
const specSpinner = 'aria-label="Reviewer is checking the specification"';
const prSpinner = 'aria-label="Reviewer is assessing this pull request"';

test('the task status shows a spinner only while the reviewer checks the specification', () => {
  expect(render(task({ isSpecUnderReview: true }))).toContain(specSpinner);
  expect(render(task({ isSpecUnderReview: false }))).not.toContain(specSpinner);
});

test('a board card shows a spinner only while the reviewer checks the specification', () => {
  const board = (t: TaskView) => renderToStaticMarkup(<Board tasks={[t]} onMoved={() => {}} />);
  expect(board(task({ isSpecUnderReview: true }))).toContain(specSpinner);
  expect(board(task({ isSpecUnderReview: false }))).not.toContain(specSpinner);
});

test('a pull request of the task shows a spinner only while the reviewer assesses it', () => {
  const list = (isUnderReview: boolean) => renderToStaticMarkup(<PullRequestList pullRequests={[pr(isUnderReview)]} />);
  expect(list(true)).toContain(prSpinner);
  expect(list(false)).not.toContain(prSpinner);
});

test('an open pull request in the project overview shows a spinner only while the reviewer assesses it', () => {
  const list = (isUnderReview: boolean) =>
    renderToStaticMarkup(<OpenPullRequests pullRequests={[{ pullRequest: { ...pr(isUnderReview), reviews: [] }, task: { id: 't1', title: 'Task' } }]} />);
  expect(list(true)).toContain(prSpinner);
  expect(list(false)).not.toContain(prSpinner);
});

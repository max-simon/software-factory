import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import type { SessionMetrics } from '@factory/core';
import type { TaskView } from '../model.ts';
import { Board } from './Board.tsx';
import { OpenPullRequests } from './ProjectOverview.tsx';
import { Consumption, Header, PullRequestList } from './TaskDetail.tsx';

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
  const board = (t: TaskView) => renderToStaticMarkup(<Board tasks={[t]} labels={[]} onMoved={() => {}} />);
  expect(board(task({ isSpecUnderReview: true }))).toContain(specSpinner);
  expect(board(task({ isSpecUnderReview: false }))).not.toContain(specSpinner);
});

test('a filtered board shows only the tasks that carry every filter label', () => {
  const tasks = [task({ id: 'a', title: 'Only ui', labels: ['ui'] }), task({ id: 'b', title: 'Ui and api', labels: ['ui', 'api'] })];
  const board = (labels: string[]) => renderToStaticMarkup(<Board tasks={tasks} labels={labels} onMoved={() => {}} />);
  expect(board(['ui'])).toContain('Only ui');
  expect(board(['ui', 'api'])).not.toContain('Only ui');
  expect(board(['ui', 'api'])).toContain('Ui and api');
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

test('pull requests show their state as an icon labelled with the review state', () => {
  const html = renderToStaticMarkup(<PullRequestList pullRequests={[{ ...pr(false), status: 'merged' }]} />);
  expect(html).toContain('aria-label="Merged without review"');
  const overview = renderToStaticMarkup(<OpenPullRequests pullRequests={[{ pullRequest: { ...pr(false), reviews: [] }, task: { id: 't1', title: 'Task' } }]} />);
  expect(overview).toContain('aria-label="Open · not reviewed"');
});

const consumption = (metrics: SessionMetrics) => renderToStaticMarkup(<Consumption metrics={metrics} />);

test('the consumption report shows time, estimated cost and tokens with their breakdown', () => {
  const html = consumption({
    durationMs: 723_000,
    costUsd: 1.2345,
    tokens: { inputTokens: 1_234, outputTokens: 56_000, cacheReadTokens: 1_250_000, cacheCreationTokens: 340_000 },
  });
  expect(html).toContain('12m 03s');
  expect(html).toContain('$1.23');
  expect(html).toContain('estimate at list prices');
  expect(html).toContain('1.6M');
  expect(html).toContain('1.2k input · 56k output · 1.2M cache read · 340k cache write');
});

test('the consumption report of a task measured before tokens were tracked shows them as not recorded', () => {
  const html = consumption({ durationMs: 1000, costUsd: 0.5 });
  expect(html).toContain('$0.50');
  expect(html).toContain('not recorded');
});

test('the task header leaves the consumption to its own section', () => {
  expect(render(task({ metrics: { durationMs: 723_000, costUsd: 1.2345 } }))).not.toContain('$1.23');
});

import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import type { TaskView } from '../model.ts';
import { Board } from '../views/Board.tsx';
import { Header } from '../views/TaskDetail.tsx';
import { IssueLink } from './IssueLink.tsx';

const external = { provider: 'github', url: 'https://github.com/acme/app/issues/12', key: 'acme/app#12' };
const issueLink = 'href="https://github.com/acme/app/issues/12" target="_blank" rel="noopener noreferrer"';

const task = (overrides: Partial<TaskView> = {}): TaskView => ({
  id: 't1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  projectId: 'p1',
  title: 'Task',
  specification: 's',
  labels: ['bug'],
  autonomyMode: 'autonomous',
  model: 'opus',
  shellEnabled: true,
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
const managed = (overrides: Partial<TaskView> = {}) => task({ external, ...overrides });

const header = (t: TaskView) => renderToStaticMarkup(<Header task={t} onChange={() => {}} />);
const board = (tasks: TaskView[], labels: string[] = []) => renderToStaticMarkup(<Board tasks={tasks} labels={labels} onMoved={() => {}} />);

test('the header of a managed task links to its issue by key', () => {
  expect(header(managed())).toContain(issueLink);
  expect(header(managed())).toContain('acme/app#12</a>');
});

test('the header of an ordinary task has no issue link', () => {
  expect(header(task())).not.toContain('issue-link');
});

test('a board card of a managed task links to its issue, outside the link to the task', () => {
  const html = board([managed()]);
  expect(html).toContain(issueLink);
  expect(html).toMatch(/<a class="card-title"[^>]*>Task<\/a>/);
  expect(board([task()])).not.toContain('issue-link');
});

test('an issue URL that is not http or https shows as plain text', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'not a url']) {
    const html = renderToStaticMarkup(<IssueLink external={{ ...external, url }} />);
    expect(html).not.toContain('<a');
    expect(html).not.toContain('href');
    expect(html).toContain('acme/app#12');
  }
});

test('a managed task offers no edit, but keeps its other actions and shows where to change it', () => {
  const html = header(managed());
  expect(html).not.toContain('>Edit</a>');
  expect(html).toContain('change them there');
  expect(html).toContain('>Start</button>');
  expect(html).toContain('>Delete</button>');
  expect(html).toContain('<span class="label">bug</span>');
  expect(header(managed({ status: 'in_progress' }))).toContain('>Cancel</button>');
  expect(header(managed({ status: 'failed' }))).toContain('>Restart</button>');
});

test('an ordinary editable task offers edit and no managed hint', () => {
  const html = header(task());
  expect(html).toContain('>Edit</a>');
  expect(html).not.toContain('change them there');
});

test('the label filter keeps the managed tasks that carry its labels', () => {
  const tasks = [managed({ id: 'a', title: 'Managed bug', labels: ['good first issue'] }), task({ id: 'b', title: 'Plain', labels: [] })];
  expect(board(tasks, ['good first issue'])).toContain('Managed bug');
  expect(board(tasks, ['good first issue'])).not.toContain('Plain');
});

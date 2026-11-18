import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  boardColumns,
  hasEveryLabel,
  labelsByUsage,
  heartbeatInfo,
  canSendFollowUp,
  describeChange,
  describeProjectChange,
  describeUser,
  mcpAddCommand,
  toUserMap,
  inputSummary,
  moveToSlot,
  openInput,
  openPullRequests,
  parseLabels,
  parseRoute,
  href,
  projectMetrics,
  pullRequestIndicator,
  relativeTime,
  repoName,
  reviewDecision,
  timeline,
  type TaskView,
} from './model.ts';

const task = (id: string, status: TaskView['status'], updatedAt: string, overrides: Partial<TaskView> = {}): TaskView => ({
  id,
  createdAt: updatedAt,
  updatedAt,
  projectId: 'p1',
  title: id,
  specification: 's',
  labels: [],
  autonomyMode: 'supervised',
  model: 'opus',
  agent: 'claude',
  status,
  rank: 0,
  plan: [],
  decisions: [],
  artifacts: [],
  questions: [],
  pullRequests: [],
  followUps: [],
  isSpecUnderReview: false,
  isInputUnderReview: false,
  dependsOn: [],
  ...overrides,
});

test('parseRoute maps hashes to views and falls back to home', () => {
  assert.deepEqual(parseRoute(''), { name: 'home' });
  assert.deepEqual(parseRoute('#/'), { name: 'home' });
  assert.deepEqual(parseRoute('#/projects/new'), { name: 'new-project' });
  assert.deepEqual(parseRoute('#/projects/p1'), { name: 'project', id: 'p1', labels: [] });
  assert.deepEqual(parseRoute('#/projects/p1?label=ui&label=a%2Cb&label=ui&label='), { name: 'project', id: 'p1', labels: ['ui', 'a,b'] });
  assert.deepEqual(parseRoute('#/projects/p1/edit'), { name: 'edit-project', id: 'p1' });
  assert.deepEqual(parseRoute('#/projects/p1/new-task'), { name: 'new-task', projectId: 'p1' });
  assert.deepEqual(parseRoute('#/tasks/ab12'), { name: 'task', id: 'ab12' });
  assert.deepEqual(parseRoute('#/tasks/ab12/edit'), { name: 'edit', id: 'ab12' });
  assert.deepEqual(parseRoute('#/nonsense'), { name: 'home' });
  assert.deepEqual(parseRoute('#/account'), { name: 'account' });
  assert.deepEqual(parseRoute('#/login'), { name: 'login', next: '#/' });
  assert.deepEqual(parseRoute('#/login?next=%23%2Ftasks%2Fab12'), { name: 'login', next: '#/tasks/ab12' });
});

test('a login returns only to a page of this app, never to the login itself', () => {
  for (const next of ['https://evil.example', 'javascript:alert(1)', '#/login', '#/login?next=%23%2Faccount', '']) {
    assert.deepEqual(parseRoute(`#/login?${new URLSearchParams({ next })}`), { name: 'login', next: '#/' }, next);
  }
});

test('href.login and parseRoute agree on where to return', () => {
  assert.equal(href.login(), '#/login');
  assert.equal(href.login('#/'), '#/login');
  for (const next of ['#/tasks/a%2Fb', '#/projects/p1/edit', '#/account']) {
    assert.deepEqual(parseRoute(href.login(next)), { name: 'login', next });
  }
  assert.deepEqual(parseRoute(href.account), { name: 'account' });
});

test('describeUser names a user by its current display name, an unknown id by itself, a missing one as unattributed', () => {
  const users = toUserMap([
    { id: 'u1', username: 'ada', displayName: 'Ada Lovelace', disabled: false },
    { id: 'u2', username: 'bob', displayName: 'Bob', disabled: true },
  ]);
  assert.deepEqual(describeUser('u1', users), { text: 'Ada Lovelace', title: 'ada (u1)', kind: 'known' });
  assert.deepEqual(describeUser('u2', users), { text: 'Bob', title: 'bob (u2) · disabled', kind: 'known' });
  assert.equal(describeUser('gone', users).text, 'gone');
  assert.equal(describeUser('gone', users).kind, 'unknown');
  assert.equal(describeUser(undefined, users).text, 'engineer (unattributed)');
});

test('mcpAddCommand adds the factory MCP server with the token as bearer', () => {
  assert.equal(
    mcpAddCommand('http://127.0.0.1:4700', 'fct_abc'),
    'claude mcp add --transport http factory http://127.0.0.1:4700/mcp --header "Authorization: Bearer fct_abc"',
  );
});

test('describeProjectChange says what a project change did', () => {
  const meta = { at: '2026-01-01T00:00:00Z', actor: 'user' as const, userId: 'u1' };
  assert.equal(describeProjectChange({ ...meta, field: 'created' }), 'Created the project');
  assert.equal(describeProjectChange({ ...meta, field: 'title', from: 'A', to: 'B' }), 'Renamed “A” → “B”');
  assert.equal(describeProjectChange({ ...meta, field: 'autoMerge', from: false, to: true }), 'Turned auto-merge on');
});

test('href and parseRoute agree, including ids that need encoding', () => {
  assert.deepEqual(parseRoute(href.project('a/b')), { name: 'project', id: 'a/b', labels: [] });
  assert.equal(href.project('p1', []), '#/projects/p1');
  assert.deepEqual(parseRoute(href.project('p1', ['ui', 'a b', 'x&y'])), { name: 'project', id: 'p1', labels: ['ui', 'a b', 'x&y'] });
  assert.deepEqual(parseRoute(href.newTask('p1')), { name: 'new-task', projectId: 'p1' });
  assert.deepEqual(parseRoute(href.editProject('p1')), { name: 'edit-project', id: 'p1' });
});

test('openPullRequests lists the open pull requests of every task in board order', () => {
  const pr = (n: number, status: 'open' | 'merged' | 'closed') => ({ url: `https://github.com/o/r/pull/${n}`, title: `PR ${n}`, status, isUnderReview: false });
  const listed = openPullRequests([
    task('a', 'in_progress', '2026-01-01T00:00:00Z', { pullRequests: [pr(1, 'merged'), pr(2, 'open')] }),
    task('b', 'done', '2026-01-01T00:00:00Z', { pullRequests: [pr(3, 'closed')] }),
    task('c', 'ready', '2026-01-01T00:00:00Z', { pullRequests: [pr(4, 'open'), pr(5, 'open')] }),
  ]);
  assert.deepEqual(
    listed.map(({ pullRequest, task }) => `${task.id}:${pullRequest.title}`),
    ['a:PR 2', 'c:PR 4', 'c:PR 5'],
  );
});

test('reviewDecision takes each reviewer’s latest decision, and a change request wins', () => {
  const review = (id: number, author: string, state: 'approved' | 'changes_requested' | 'commented') => ({
    id,
    author,
    state,
    body: '',
    url: `https://github.com/o/r/pull/1#pullrequestreview-${id}`,
    submittedAt: '2026-01-01T00:00:00Z',
  });
  assert.equal(reviewDecision({}), undefined);
  assert.equal(reviewDecision({ reviews: [review(1, 'a', 'commented')] }), undefined);
  assert.equal(reviewDecision({ reviews: [review(1, 'a', 'changes_requested'), review(2, 'a', 'approved')] }), 'approved');
  assert.equal(reviewDecision({ reviews: [review(1, 'a', 'approved'), review(2, 'a', 'commented')] }), 'approved');
  assert.equal(reviewDecision({ reviews: [review(1, 'a', 'approved'), review(2, 'b', 'changes_requested')] }), 'changes_requested');
});

test('pullRequestIndicator labels open pull requests by their review decision', () => {
  const review = (id: number, author: string, state: 'approved' | 'changes_requested' | 'commented') => ({
    id,
    author,
    state,
    body: '',
    url: `https://github.com/o/r/pull/1#pullrequestreview-${id}`,
    submittedAt: '2026-01-01T00:00:00Z',
  });
  const open = (...reviews: ReturnType<typeof review>[]) => pullRequestIndicator({ status: 'open', reviews });
  assert.deepEqual(pullRequestIndicator({ status: 'open' }), { state: 'open', review: 'none', label: 'Open · not reviewed' });
  assert.deepEqual(open(), { state: 'open', review: 'none', label: 'Open · not reviewed' });
  assert.deepEqual(open(review(1, 'a', 'approved')), { state: 'open', review: 'approved', label: 'Open · approved' });
  assert.deepEqual(open(review(1, 'a', 'approved'), review(2, 'b', 'changes_requested')), {
    state: 'open',
    review: 'changes_requested',
    label: 'Open · changes requested',
  });
  assert.deepEqual(open(review(1, 'a', 'commented'), review(2, 'b', 'commented')), { state: 'open', review: 'commented', label: 'Open · commented' });
  // A later comment does not undo the reviewer's approval.
  assert.equal(open(review(1, 'a', 'approved'), review(2, 'a', 'commented')).review, 'approved');
});

test('pullRequestIndicator flags merge conflicts of open pull requests only', () => {
  assert.deepEqual(pullRequestIndicator({ status: 'open', hasConflicts: true }), {
    state: 'open',
    review: 'none',
    label: 'Open · not reviewed · merge conflicts',
    hasConflicts: true,
  });
  assert.deepEqual(pullRequestIndicator({ status: 'open', hasConflicts: false }), { state: 'open', review: 'none', label: 'Open · not reviewed' });
  assert.deepEqual(pullRequestIndicator({ status: 'merged', hasConflicts: true }), { state: 'merged', review: 'none', label: 'Merged without review' });
});

test('pullRequestIndicator tells merged and closed pull requests with reviews from those without', () => {
  const reviews = [{ id: 1, author: 'a', state: 'commented' as const, body: '', url: 'u', submittedAt: '2026-01-01T00:00:00Z' }];
  assert.deepEqual(pullRequestIndicator({ status: 'merged', reviews }), { state: 'merged', review: 'commented', label: 'Merged after review' });
  assert.deepEqual(pullRequestIndicator({ status: 'merged', reviews: [] }), { state: 'merged', review: 'none', label: 'Merged without review' });
  assert.deepEqual(pullRequestIndicator({ status: 'merged' }), { state: 'merged', review: 'none', label: 'Merged without review' });
  assert.deepEqual(pullRequestIndicator({ status: 'closed' }), { state: 'closed', review: 'none', label: 'Closed' });
  assert.deepEqual(pullRequestIndicator({ status: 'closed', reviews: [{ ...reviews[0]!, state: 'changes_requested' }] }), {
    state: 'closed',
    review: 'changes_requested',
    label: 'Closed after review',
  });
});

test('projectMetrics counts tasks by status and sums cost, time, tokens and pull requests', () => {
  const pr = (n: number, status: 'open' | 'merged' | 'closed') => ({ url: `https://github.com/o/r/pull/${n}`, title: 't', status, isUnderReview: false });
  const metrics = projectMetrics([
    task('a', 'in_progress', '2026-01-01T00:00:00Z', { metrics: { durationMs: 1000, costUsd: 0.5 }, pullRequests: [pr(1, 'open')] }),
    task('b', 'done', '2026-01-01T00:00:00Z', { metrics: { durationMs: 2000, costUsd: 1.25, tokens: { inputTokens: 1, outputTokens: 20, cacheReadTokens: 300, cacheCreationTokens: 4000 } }, pullRequests: [pr(2, 'merged'), pr(3, 'closed')] }),
    task('c', 'input_required', '2026-01-01T00:00:00Z'),
    task('d', 'failed', '2026-01-01T00:00:00Z'),
    task('e', 'draft', '2026-01-01T00:00:00Z'),
    task('f', 'clarification_required', '2026-01-01T00:00:00Z'),
  ]);
  assert.deepEqual(metrics, {
    tasks: 6,
    needsInput: 2,
    done: 1,
    failed: 1,
    costUsd: 1.75,
    durationMs: 3000,
    tokens: 4321,
    openPullRequests: 1,
    mergedPullRequests: 1,
  });
  assert.deepEqual(projectMetrics([]).tasks, 0);
});

test('boardColumns lists every column in workflow order, ranked tasks by rank, finished ones newest first', () => {
  const columns = boardColumns([
    task('d', 'draft', '2026-01-01', { rank: 3 }),
    task('r1', 'in_progress', '2026-01-01', { rank: 1 }),
    task('q', 'queued', '2026-01-03', { rank: 0 }),
    task('i', 'input_required', '2026-01-02', { rank: 2 }),
    task('f', 'failed', '2026-01-04', { rank: 5 }),
    task('x', 'done', '2026-01-05', { rank: 4 }),
    task('c', 'clarification_required', '2026-01-01', { rank: 6 }),
  ]);
  assert.deepEqual(
    columns.map((c) => [c.key, c.isRanked, c.tasks.map((t) => t.id)]),
    [
      ['input', true, ['i', 'c']],
      ['planned', true, ['q', 'd']],
      ['running', true, ['r1']],
      ['ready', true, []],
      ['finished', false, ['x', 'f']],
    ],
  );
});

test('labelsByUsage lists labels most used first, alphabetically among equals', () => {
  const tasks = [task('t1', 'draft', '', { labels: ['b', 'a'] }), task('t2', 'draft', '', { labels: ['c', 'a'] }), task('t3', 'draft', '', { labels: ['c'] }), task('t4', 'draft', '')];
  assert.deepEqual(labelsByUsage(tasks), ['a', 'c', 'b']);
  assert.deepEqual(labelsByUsage([]), []);
});

test('hasEveryLabel requires all filter labels, and no filter matches every task', () => {
  const labelled = task('t1', 'draft', '', { labels: ['ui', 'api'] });
  assert.equal(hasEveryLabel(labelled, []), true);
  assert.equal(hasEveryLabel(labelled, ['ui']), true);
  assert.equal(hasEveryLabel(labelled, ['ui', 'api']), true);
  assert.equal(hasEveryLabel(labelled, ['ui', 'db']), false);
});

test('moveToSlot targets the task below the slot and skips moves that change nothing', () => {
  const column = ['a', 'b', 'c'].map((id) => task(id, 'draft', '2026-01-01'));
  assert.deepEqual(moveToSlot(column, 'c', 0), { before: 'a' });
  assert.deepEqual(moveToSlot(column, 'a', 2), { before: 'c' });
  assert.deepEqual(moveToSlot(column, 'a', 3), {});
  assert.equal(moveToSlot(column, 'b', 1), undefined);
  assert.equal(moveToSlot(column, 'b', 2), undefined);
  assert.equal(moveToSlot(column, 'missing', 0), undefined);
  assert.equal(moveToSlot(column, 'a', -1), undefined);
  assert.equal(moveToSlot(column, 'c', 4), undefined);
});

test('openInput and inputSummary count open questions and pending approvals only', () => {
  const t = task('t', 'input_required', '2026-01-01', {
    questions: [
      { id: 'q1', createdAt: '2026-01-01T00:00:00Z', problem: 'p', type: 'text', options: [] },
      { id: 'q2', createdAt: '2026-01-01T00:00:00Z', problem: 'p', type: 'text', options: [], answer: ['a'] },
    ],
    decisions: [{ id: 'd1', createdAt: '2026-01-01T00:00:00Z', problem: 'p', options: ['x'], chosen: 0, reasoning: 'r', approval: { status: 'pending' } }],
    artifacts: [
      { id: 'a1', createdAt: '2026-01-01T00:00:00Z', title: 't', kind: 'md', content: 'c', approval: { status: 'approved' } },
      { id: 'a2', createdAt: '2026-01-01T00:00:00Z', title: 't', kind: 'md', content: 'c', approval: { status: 'pending' } },
    ],
  });
  const open = openInput(t);
  assert.deepEqual(open.questions.map((q) => q.id), ['q1']);
  assert.deepEqual(open.approvals.map((a) => `${a.kind}:${a.item.id}`), ['decision:d1', 'artifact:a2']);
  assert.equal(inputSummary(t), '1 question · 2 approvals');
  assert.equal(inputSummary(task('u', 'in_progress', '2026-01-01')), '');
});

test('timeline interleaves settled items newest first and leaves out open ones', () => {
  const at = (minute: number) => `2026-01-01T10:${String(minute).padStart(2, '0')}:00Z`;
  const t = task('t', 'input_required', '2026-01-01', {
    questions: [
      { id: 'q1', createdAt: at(2), problem: 'p', type: 'text', options: [], answer: ['a'] },
      { id: 'q2', createdAt: at(5), problem: 'p', type: 'text', options: [] },
    ],
    decisions: [
      { id: 'd1', createdAt: at(1), problem: 'p', options: ['x'], chosen: 0, reasoning: 'r' },
      { id: 'd2', createdAt: at(4), problem: 'p', options: ['x'], chosen: 0, reasoning: 'r', approval: { status: 'pending' } },
    ],
    artifacts: [{ id: 'a1', createdAt: at(3), title: 't', kind: 'md', content: 'c', approval: { status: 'approved' } }],
  });
  assert.deepEqual(timeline(t).map((e) => `${e.kind}:${e.item.id}`), ['artifact:a1', 'question:q1', 'decision:d1']);
});

test('timeline includes every follow-up, delivered or not, among the other entries', () => {
  const at = (minute: number) => `2026-01-01T10:${String(minute).padStart(2, '0')}:00Z`;
  const t = task('t', 'in_progress', '2026-01-01', {
    decisions: [{ id: 'd1', createdAt: at(1), problem: 'p', options: ['x'], chosen: 0, reasoning: 'r' }],
    followUps: [
      { id: 'f1', createdAt: at(2), message: 'first', deliveredAt: at(3) },
      { id: 'f2', createdAt: at(4), message: 'second' },
    ],
  });
  assert.deepEqual(timeline(t).map((e) => `${e.kind}:${e.item.id}`), ['follow-up:f2', 'follow-up:f1', 'decision:d1']);
});

const busy = { state: 'working' as const, since: '2026-01-01T11:00:00Z' };

test('canSendFollowUp while the task runs and after a failure while its execution server exists', () => {
  for (const status of ['in_progress', 'input_required', 'ready'] as const) {
    assert.equal(canSendFollowUp(task('t', status, '2026-01-01', { execution: { id: 'c1', worker: busy } })), true, status);
  }
  assert.equal(canSendFollowUp(task('t', 'failed', '2026-01-01', { execution: { id: 'c1', worker: busy } })), true);
  assert.equal(canSendFollowUp(task('t', 'failed', '2026-01-01')), false);
  for (const status of ['draft', 'queued', 'done'] as const) {
    assert.equal(canSendFollowUp(task('t', status, '2026-01-01')), false, status);
  }
});

test('repoName, relativeTime and parseLabels', () => {
  assert.equal(repoName('https://github.com/acme/app.git'), 'acme/app');
  assert.equal(repoName('not a url'), 'not a url');
  const now = Date.parse('2026-01-01T12:00:00Z');
  assert.equal(relativeTime('2026-01-01T11:59:30Z', now), 'just now');
  assert.equal(relativeTime('2026-01-01T11:45:00Z', now), '15m ago');
  assert.equal(relativeTime('2026-01-01T09:00:00Z', now), '3h ago');
  assert.equal(relativeTime('2025-12-29T12:00:00Z', now), '3d ago');
  assert.deepEqual(parseLabels(' ui, api,, ui '), ['ui', 'api']);
});

test('heartbeatInfo shows the activity, or the phase, with time and age on hover', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const time = (date: Date) => date.toISOString().slice(11, 19);
  const working = task('a', 'in_progress', '2026-01-01T11:00:00Z', {
    execution: { id: 'c1', worker: busy, lastHeartbeat: { at: '2026-01-01T11:59:50Z', phase: 'working', activity: 'Running Bash: yarn test' } },
  });
  assert.deepEqual(heartbeatInfo(working, now, time), {
    text: 'Running Bash: yarn test',
    tooltip: 'Last heartbeat: 11:59:50 (10s ago)\nWorking: Running Bash: yarn test',
    isStale: false,
  });
  const settingUp = task('b', 'in_progress', '2026-01-01T11:00:00Z', {
    execution: { id: 'c1', worker: busy, lastHeartbeat: { at: '2026-01-01T11:59:15Z', phase: 'setting_up' } },
  });
  assert.deepEqual(heartbeatInfo(settingUp, now, time), {
    text: 'Setting up',
    tooltip: 'Last heartbeat: 11:59:15 (45s ago)\nSetting up',
    isStale: false,
  });
});

test('heartbeatInfo shows an idle worker and since when, never as stale', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const idle = task('a', 'input_required', '2026-01-01T11:00:00Z', {
    execution: { id: 'c1', worker: { state: 'idle', since: '2026-01-01T11:00:00Z' }, lastHeartbeat: { at: '2026-01-01T11:00:00Z', phase: 'awaiting_work' } },
  });
  assert.deepEqual(heartbeatInfo(idle, now, () => '11:00'), {
    text: 'Idle',
    tooltip: 'Idle since 11:00 (1h ago); new work notifies it.',
    isStale: false,
  });
});

test('heartbeatInfo shows a notified worker as starting until it beats, ignoring older heartbeats', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const notified = (since: string) =>
    task('a', 'in_progress', '2026-01-01T11:00:00Z', {
      execution: { id: 'c1', worker: { state: 'working', since }, lastHeartbeat: { at: '2026-01-01T11:00:00Z', phase: 'awaiting_work' } },
    });
  const fresh = heartbeatInfo(notified('2026-01-01T11:59:50Z'), now, () => '11:59')!;
  assert.deepEqual([fresh.text, fresh.isStale], ['Starting', false]);
  assert.match(fresh.tooltip, /^Started or notified 11:59 \(10s ago\), no heartbeat yet$/);
  const stuck = heartbeatInfo(notified('2026-01-01T11:59:00Z'), now)!;
  assert.deepEqual([stuck.text, stuck.isStale], ['Starting', true]);
});

test('heartbeatInfo marks heartbeats older than 45s as stale', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const at = (iso: string) => task('a', 'in_progress', iso, { execution: { id: 'c1', worker: busy, lastHeartbeat: { at: iso, phase: 'working' } } });
  assert.equal(heartbeatInfo(at('2026-01-01T11:59:14Z'), now)!.isStale, true);
  const old = heartbeatInfo(at('2026-01-01T11:50:00Z'), now, () => '11:50')!;
  assert.match(old.tooltip, /^Last heartbeat: 11:50 \(10m ago\)\nWorking\nNo heartbeat for a while/);
});

test('heartbeatInfo is absent while the task has no execution server', () => {
  for (const status of ['queued', 'done', 'failed'] as const) {
    assert.equal(heartbeatInfo(task('a', status, '2026-01-01T11:00:00Z')), undefined, status);
  }
});

test('describeChange words each changelog entry on one line', () => {
  const meta = { at: '2026-01-01T00:00:00Z', actor: 'user' } as const;
  assert.equal(describeChange({ ...meta, field: 'created' }), 'Created the task');
  assert.equal(describeChange({ ...meta, field: 'title', from: 'a', to: 'b' }), 'Renamed “a” → “b”');
  assert.equal(describeChange({ ...meta, field: 'specification', from: 'a', to: 'b' }), 'Edited the specification');
  assert.equal(describeChange({ ...meta, field: 'labels', from: ['ui', 'old'], to: ['ui', 'new'] }), 'Labels +new −old');
  assert.equal(describeChange({ ...meta, field: 'labels', from: ['a', 'b'], to: ['b', 'a'] }), 'Labels reordered');
  assert.equal(describeChange({ ...meta, field: 'dependsOn', from: [], to: ['t1'] }), 'Changed the dependencies');
  assert.equal(describeChange({ ...meta, field: 'assignees', from: [], to: ['u1'] }), 'Changed the assignees');
  assert.equal(
    describeChange({ ...meta, field: 'status', from: 'draft', to: 'clarification_required' }),
    'Draft → Needs clarification',
  );
});

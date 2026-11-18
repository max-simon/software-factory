import type {
  Artifact,
  Decision,
  FollowUp,
  HeartbeatPhase,
  ProjectChange,
  PullRequest,
  PullRequestStatus,
  PullRequestView,
  Question,
  Task,
  TaskAgent,
  TaskChange,
  TaskStatus,
  TaskView,
  TokenUsage,
} from '@factory/core';

export type { TaskView };

export type Route =
  | { name: 'home' }
  | { name: 'new-project' }
  | { name: 'project'; id: string }
  | { name: 'edit-project'; id: string }
  | { name: 'new-task'; projectId: string }
  | { name: 'task'; id: string }
  | { name: 'edit'; id: string }
  /** `next` is the hash to return to after signing in. */
  | { name: 'login'; next: string }
  | { name: 'account' };

/** Where a login returns to: a hash of this app other than the login itself, else home. */
function loginNext(value: string | null): string {
  return value?.startsWith('#/') && parseRoute(value.split('?')[0]!).name !== 'login' ? value : href.home;
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const queryAt = raw.indexOf('?');
  const path = queryAt === -1 ? raw : raw.slice(0, queryAt);
  const [first, id, action] = path.split('/').map(decodeURIComponent);
  if (first === 'login') {
    return { name: 'login', next: loginNext(new URLSearchParams(queryAt === -1 ? '' : raw.slice(queryAt + 1)).get('next')) };
  }
  if (first === 'account') return { name: 'account' };
  if (first === 'projects' && id === 'new') return { name: 'new-project' };
  if (first === 'projects' && id) {
    if (action === 'edit') return { name: 'edit-project', id };
    if (action === 'new-task') return { name: 'new-task', projectId: id };
    return { name: 'project', id };
  }
  if (first === 'tasks' && id) return action === 'edit' ? { name: 'edit', id } : { name: 'task', id };
  return { name: 'home' };
}

const projectPath = (id: string) => `#/projects/${encodeURIComponent(id)}`;

export const href = {
  home: '#/',
  newProject: '#/projects/new',
  project: projectPath,
  editProject: (id: string) => `${projectPath(id)}/edit`,
  newTask: (projectId: string) => `${projectPath(projectId)}/new-task`,
  task: (id: string) => `#/tasks/${encodeURIComponent(id)}`,
  edit: (id: string) => `#/tasks/${encodeURIComponent(id)}/edit`,
  account: '#/account',
  /** The login page, returning to `next` afterwards; home when it is left out. */
  login: (next?: string) => (next && next !== '#/' && next !== '#' ? `#/login?${new URLSearchParams({ next })}` : '#/login'),
};

const statusLabels: Record<TaskStatus, string> = {
  draft: 'Draft',
  clarification_required: 'Needs clarification',
  queued: 'Queued',
  in_progress: 'In progress',
  input_required: 'Needs input',
  ready: 'Ready',
  done: 'Done',
  failed: 'Failed',
};

export const statusLabel = (status: TaskStatus): string => statusLabels[status];

export const agentLabels: Record<TaskAgent, string> = { claude: 'Claude CLI', opencode: 'OpenCode' };

export type ReviewItem = { kind: 'decision'; item: Decision } | { kind: 'artifact'; item: Artifact };

export interface OpenInput {
  questions: Question[];
  approvals: ReviewItem[];
}

export function openInput(task: Pick<Task, 'questions' | 'decisions' | 'artifacts'>): OpenInput {
  const isPending = (item: Decision | Artifact) => item.approval?.status === 'pending';
  return {
    questions: task.questions.filter((q) => q.answer === undefined),
    approvals: [
      ...task.decisions.filter(isPending).map((item) => ({ kind: 'decision' as const, item })),
      ...task.artifacts.filter(isPending).map((item) => ({ kind: 'artifact' as const, item })),
    ],
  };
}

export type TimelineEntry = ReviewItem | { kind: 'question'; item: Question } | { kind: 'follow-up'; item: FollowUp };

/**
 * Settled questions, decisions and artifacts plus every follow-up, newest first;
 * open questions and approvals belong to the input section.
 */
export function timeline(task: Pick<Task, 'questions' | 'decisions' | 'artifacts' | 'followUps'>): TimelineEntry[] {
  const isSettled = (item: Decision | Artifact) => item.approval?.status !== 'pending';
  const entries: TimelineEntry[] = [
    ...task.questions.filter((item) => item.answer !== undefined).map((item) => ({ kind: 'question' as const, item })),
    ...task.decisions.filter(isSettled).map((item) => ({ kind: 'decision' as const, item })),
    ...task.artifacts.filter(isSettled).map((item) => ({ kind: 'artifact' as const, item })),
    ...task.followUps.map((item) => ({ kind: 'follow-up' as const, item })),
  ];
  return entries.sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt));
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** "2 questions · 1 approval", or an empty string when nothing is open. */
export function inputSummary(task: Pick<Task, 'questions' | 'decisions' | 'artifacts'>): string {
  const { questions, approvals } = openInput(task);
  return [
    questions.length > 0 ? plural(questions.length, 'question') : '',
    approvals.length > 0 ? plural(approvals.length, 'approval') : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export type ColumnKey = 'input' | 'planned' | 'running' | 'ready' | 'finished';

export interface BoardColumn {
  key: ColumnKey;
  title: string;
  /** Ranked columns are ordered by the engineer; finished tasks are not. */
  isRanked: boolean;
  tasks: TaskView[];
}

const columns: ReadonlyArray<{ key: ColumnKey; title: string; statuses: readonly TaskStatus[] }> = [
  { key: 'input', title: 'Requires input', statuses: ['clarification_required', 'input_required'] },
  { key: 'planned', title: 'Planned', statuses: ['draft', 'queued'] },
  { key: 'running', title: 'In progress', statuses: ['in_progress'] },
  { key: 'ready', title: 'Waiting for merge', statuses: ['ready'] },
  { key: 'finished', title: 'Done', statuses: ['done', 'failed'] },
];

/** Every column in workflow order; tasks by rank, finished tasks newest first. */
export function boardColumns(tasks: readonly TaskView[]): BoardColumn[] {
  return columns.map(({ key, title, statuses }) => {
    const isRanked = key !== 'finished';
    const inColumn = tasks.filter((t) => statuses.includes(t.status));
    const sorted = isRanked
      ? inColumn.sort((a, b) => a.rank - b.rank)
      : inColumn.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { key, title, isRanked, tasks: sorted };
  });
}

/**
 * The move that puts task `id` at `slot` of its column (0 = top, length = bottom),
 * or undefined when it would stay where it is. Without `before` it goes to the bottom.
 */
export function moveToSlot(column: readonly TaskView[], id: string, slot: number): { before?: string } | undefined {
  const from = column.findIndex((t) => t.id === id);
  const isOutside = slot < 0 || slot > column.length;
  if (from === -1 || isOutside || slot === from || slot === from + 1) return undefined;
  const before = column[slot]?.id;
  return before === undefined ? {} : { before };
}

export interface ProjectMetrics {
  tasks: number;
  needsInput: number;
  done: number;
  failed: number;
  /** Summed over every task; tasks without a report count as zero. */
  costUsd: number;
  durationMs: number;
  /** Tasks measured before tokens were tracked count only their later tokens. */
  tokens: number;
  openPullRequests: number;
  mergedPullRequests: number;
}

export function projectMetrics(tasks: readonly TaskView[]): ProjectMetrics {
  const count = (status: TaskStatus) => tasks.filter((t) => t.status === status).length;
  const pullRequests = tasks.flatMap((t) => t.pullRequests);
  return {
    tasks: tasks.length,
    needsInput: count('clarification_required') + count('input_required'),
    done: count('done'),
    failed: count('failed'),
    costUsd: tasks.reduce((sum, t) => sum + (t.metrics?.costUsd ?? 0), 0),
    durationMs: tasks.reduce((sum, t) => sum + (t.metrics?.durationMs ?? 0), 0),
    tokens: tasks.reduce((sum, t) => sum + (t.metrics?.tokens ? totalTokens(t.metrics.tokens) : 0), 0),
    openPullRequests: pullRequests.filter((pr) => pr.status === 'open').length,
    mergedPullRequests: pullRequests.filter((pr) => pr.status === 'merged').length,
  };
}

export interface OpenPullRequest {
  pullRequest: PullRequestView;
  task: Pick<TaskView, 'id' | 'title'>;
}

export const totalTokens = (usage: TokenUsage): number =>
  usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;

/** Every open pull request of the tasks, in their board order. */
export function openPullRequests(tasks: readonly TaskView[]): OpenPullRequest[] {
  return tasks.flatMap((task) =>
    task.pullRequests.filter((pr) => pr.status === 'open').map((pullRequest) => ({ pullRequest, task: { id: task.id, title: task.title } })),
  );
}

export type ReviewDecision = 'approved' | 'changes_requested';

/**
 * Like GitHub: each reviewer's latest approval or change request counts, and
 * one request for changes outweighs any approvals. Comments decide nothing.
 */
export function reviewDecision(pr: Pick<PullRequest, 'reviews'>): ReviewDecision | undefined {
  const latest = new Map<string, ReviewDecision>();
  for (const review of pr.reviews ?? []) if (review.state !== 'commented') latest.set(review.author, review.state);
  const decisions = [...latest.values()];
  if (decisions.includes('changes_requested')) return 'changes_requested';
  return decisions.includes('approved') ? 'approved' : undefined;
}

export type PullRequestReviewMark = 'none' | ReviewDecision | 'commented';

export interface PullRequestIndicator {
  state: PullRequestStatus;
  /** `none` until a review is submitted; `commented` while the reviews decide nothing. */
  review: PullRequestReviewMark;
  /** The full state in words, for the hover title and screen readers. */
  label: string;
  /** Set only on an open pull request that conflicts with its base branch. */
  hasConflicts?: true;
}

const openLabels: Record<PullRequestReviewMark, string> = {
  none: 'Open · not reviewed',
  approved: 'Open · approved',
  changes_requested: 'Open · changes requested',
  commented: 'Open · commented',
};

/** Where a pull request stands and how far its review got, for its state icon. */
export function pullRequestIndicator(pr: Pick<PullRequest, 'status' | 'reviews' | 'hasConflicts'>): PullRequestIndicator {
  const review: PullRequestReviewMark = (pr.reviews ?? []).length === 0 ? 'none' : (reviewDecision(pr) ?? 'commented');
  const isReviewed = review !== 'none';
  const labels: Record<PullRequestStatus, string> = {
    open: openLabels[review],
    merged: isReviewed ? 'Merged after review' : 'Merged without review',
    closed: isReviewed ? 'Closed after review' : 'Closed',
  };
  // A merged or closed pull request may still read as conflicting; it no longer matters.
  if (pr.status === 'open' && pr.hasConflicts === true) {
    return { state: pr.status, review, label: `${labels.open} · merge conflicts`, hasConflicts: true };
  }
  return { state: pr.status, review, label: labels[pr.status] };
}

/** "owner/name" of a repository URL, or the URL itself when it has another shape. */
export function repoName(url: string): string {
  const segments = URL.canParse(url) ? new URL(url).pathname.split('/').filter(Boolean) : [];
  return segments.length === 2 ? `${segments[0]}/${segments[1]!.replace(/\.git$/, '')}` : url;
}

/** "#7" for a GitHub pull request URL. */
export function pullRequestNumber(url: string): string {
  const match = /\/pull\/(\d+)/.exec(url);
  return match ? `#${match[1]}` : url;
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const heartbeatPhaseLabels: Record<HeartbeatPhase, string> = {
  awaiting_work: 'Waiting for work',
  setting_up: 'Setting up',
  working: 'Working',
};

// Runners beat every 15s; three missed beats mean the execution server is
// stuck or gone rather than briefly slow. A notified one reports within seconds.
export const staleHeartbeatMs = 45_000;

export interface HeartbeatInfo {
  /** The CLI activity, or the phase when there is none. */
  text: string;
  /** For the hover title: when the last heartbeat came and what it said. */
  tooltip: string;
  isStale: boolean;
}

/**
 * What the execution server is doing: idle, starting, or what its last
 * heartbeat says. Undefined while the task has no execution server.
 */
export function heartbeatInfo(
  task: Pick<TaskView, 'execution'>,
  now: number = Date.now(),
  formatTime: (date: Date) => string = (date) => date.toLocaleTimeString(),
): HeartbeatInfo | undefined {
  if (!task.execution) return undefined;
  const { worker, lastHeartbeat } = task.execution;
  if (worker.state === 'idle') {
    const tooltip = `Idle since ${formatTime(new Date(worker.since))} (${ago(worker.since, now)}); new work notifies it.`;
    return { text: 'Idle', tooltip, isStale: false };
  }
  // A heartbeat from before the last notification says nothing about this one.
  const heartbeat = lastHeartbeat && lastHeartbeat.at >= worker.since ? lastHeartbeat : undefined;
  if (!heartbeat) {
    const isStale = now - Date.parse(worker.since) > staleHeartbeatMs;
    const tooltip = [
      `Started or notified ${formatTime(new Date(worker.since))} (${ago(worker.since, now)}), no heartbeat yet`,
      ...(isStale ? ['No heartbeat for a while: the execution server may be stuck or gone.'] : []),
    ];
    return { text: 'Starting', tooltip: tooltip.join('\n'), isStale };
  }
  const phase = heartbeatPhaseLabels[heartbeat.phase];
  const isStale = now - Date.parse(heartbeat.at) > staleHeartbeatMs;
  const lines = [
    `Last heartbeat: ${formatTime(new Date(heartbeat.at))} (${ago(heartbeat.at, now)})`,
    heartbeat.activity ? `${phase}: ${heartbeat.activity}` : phase,
    ...(isStale ? ['No heartbeat for a while: the execution server may be stuck or gone.'] : []),
  ];
  return { text: heartbeat.activity ?? phase, tooltip: lines.join('\n'), isStale };
}

// Seconds matter while judging whether a runner is alive; later, coarser is clearer.
function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return seconds < 120 ? `${seconds}s ago` : relativeTime(iso, now);
}

export const parseLabels = (text: string): string[] => [
  ...new Set(
    text
      .split(',')
      .map((label) => label.trim())
      .filter(Boolean),
  ),
];

/**
 * Whether the engineer can send a follow-up: while the task runs, and after a
 * failure as long as its execution server exists. The server may still have
 * exited; the control plane then rejects the follow-up.
 */
export const canSendFollowUp = (task: Pick<TaskView, 'status' | 'execution'>): boolean =>
  ['in_progress', 'input_required', 'ready'].includes(task.status) ||
  (task.status === 'failed' && task.execution !== undefined);

const quoted = (text: string): string => `“${text}”`;

/** One line on what a changelog entry changed; the specification is too long to show inline. */
export function describeChange(change: TaskChange): string {
  switch (change.field) {
    case 'created':
      return 'Created the task';
    case 'title':
      return `Renamed ${quoted(change.from)} → ${quoted(change.to)}`;
    case 'specification':
      return 'Edited the specification';
    case 'labels': {
      const added = change.to.filter((label) => !change.from.includes(label)).map((label) => `+${label}`);
      const removed = change.from.filter((label) => !change.to.includes(label)).map((label) => `−${label}`);
      // Labels only reordered show as such rather than as an empty line.
      return `Labels ${[...added, ...removed].join(' ') || 'reordered'}`;
    }
    case 'dependsOn':
      return 'Changed the dependencies';
    case 'status':
      return `${statusLabel(change.from)} → ${statusLabel(change.to)}`;
  }
}

/** A user as `GET /users` lists it; others reference it by `id` only. */
export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
  disabled: boolean;
}

/** The signed-in user, as `GET /auth/me` returns it. */
export interface CurrentUser {
  id: string;
  username: string;
  displayName: string;
}

export type UserMap = ReadonlyMap<string, UserSummary>;

export const toUserMap = (users: readonly UserSummary[]): UserMap => new Map(users.map((user) => [user.id, user]));

/** For what an engineer did before users existed, which no record attributes to anyone. */
export const unattributedLabel = 'engineer (unattributed)';

export interface PersonLabel {
  text: string;
  /** For the hover title. */
  title: string;
  kind: 'known' | 'unknown' | 'unattributed';
}

/**
 * Names the user with id `userId` by its current display name; an id no user
 * has (anymore) shows as itself, and a missing id as an unattributed engineer.
 */
export function describeUser(userId: string | undefined, users: UserMap): PersonLabel {
  if (userId === undefined) return { text: unattributedLabel, title: 'Recorded before users existed', kind: 'unattributed' };
  const user = users.get(userId);
  if (!user) return { text: userId, title: `Unknown user (${userId})`, kind: 'unknown' };
  return { text: user.displayName, title: `${user.username} (${user.id})${user.disabled ? ' · disabled' : ''}`, kind: 'known' };
}

/** The command that adds the factory's MCP server to Claude Code with a personal access token. */
export const mcpAddCommand = (origin: string, token: string): string =>
  `claude mcp add --transport http factory ${origin}/mcp --header "Authorization: Bearer ${token}"`;

/** One line on what a project changelog entry changed; the description is too long to show inline. */
export function describeProjectChange(change: ProjectChange): string {
  switch (change.field) {
    case 'created':
      return 'Created the project';
    case 'title':
      return `Renamed ${quoted(change.from)} → ${quoted(change.to)}`;
    case 'description':
      return 'Edited the description';
    case 'autoMerge':
      return change.to ? 'Turned auto-merge on' : 'Turned auto-merge off';
  }
}

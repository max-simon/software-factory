import type { ActivityEntry, NewProject, NewTask, Project, ProjectChange, ProjectEdit, Review, TaskChange, TaskEdit } from '@factory/core';
import { href, parseRoute, type CurrentUser, type TaskView, type UserSummary } from './model.ts';

export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const loginPath = '/auth/login';

/**
 * Sends the browser to the login page, which returns to the current page
 * afterwards. Already on the login page, it stays there rather than nesting.
 */
export function redirectToLogin(target: Pick<Location, 'hash'> = location): void {
  if (parseRoute(target.hash).name === 'login') return;
  target.hash = href.login(target.hash);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'unreachable', 'The control plane is unreachable.');
  }
  // A failed login is the login form's to report; any other 401 means the session ended.
  if (response.status === 401 && path !== loginPath) redirectToLogin();
  const payload: unknown = await response.json().catch(() => undefined);
  if (response.ok) return payload as T;
  const error = (payload as { error?: { code?: string; message?: string } } | undefined)?.error;
  throw new ApiError(response.status, error?.code ?? 'unexpected', error?.message ?? `HTTP ${response.status}`);
}

/** A personal access token as the API lists it; the token itself is shown only on creation. */
export interface AccessTokenView {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
}

/** How to sign in to the agent's web console of a running task. */
export interface AgentConsoleAccess {
  url: string;
  username: string;
  password: string;
}

const project = (id: string) => `/projects/${encodeURIComponent(id)}`;
const task = (id: string) => `/tasks/${encodeURIComponent(id)}`;

export const api = {
  login: (username: string, password: string) => call<CurrentUser>('POST', loginPath, { username, password }),
  logout: () => call<void>('POST', '/auth/logout'),
  me: () => call<CurrentUser>('GET', '/auth/me'),
  changeDisplayName: (displayName: string) => call<CurrentUser>('PATCH', '/auth/me', { displayName }),
  changePassword: (currentPassword: string, newPassword: string) =>
    call<void>('POST', '/auth/password', { currentPassword, newPassword }),
  listTokens: () => call<AccessTokenView[]>('GET', '/auth/tokens'),
  createToken: (input: { name: string; expiresInDays?: number }) =>
    call<AccessTokenView & { token: string }>('POST', '/auth/tokens', input),
  revokeToken: (id: string) => call<void>('DELETE', `/auth/tokens/${encodeURIComponent(id)}`),
  listUsers: () => call<UserSummary[]>('GET', '/users'),
  listProjects: () => call<Project[]>('GET', '/projects'),
  getProject: (id: string) => call<Project>('GET', project(id)),
  createProject: (input: NewProject) => call<Project>('POST', '/projects', input),
  editProject: (id: string, edit: ProjectEdit) => call<Project>('PATCH', project(id), edit),
  listProjectChanges: (id: string) => call<ProjectChange[]>('GET', `${project(id)}/changes`),
  listProjectTasks: (id: string) => call<TaskView[]>('GET', `${project(id)}/tasks`),
  getTask: (id: string) => call<TaskView>('GET', task(id)),
  createTask: (input: NewTask) => call<TaskView>('POST', '/tasks', input),
  editTask: (id: string, edit: TaskEdit) => call<TaskView>('PATCH', task(id), edit),
  moveTask: (id: string, move: { before?: string }) => call<TaskView[]>('POST', `${task(id)}/move`, move),
  startTask: (id: string) => call<TaskView>('POST', `${task(id)}/start`),
  requestClarification: (id: string, note: string) => call<TaskView>('POST', `${task(id)}/clarification`, { note }),
  returnToDraft: (id: string) => call<TaskView>('DELETE', `${task(id)}/clarification`),
  listChanges: (id: string) => call<TaskChange[]>('GET', `${task(id)}/changes`),
  listActivity: (id: string) => call<ActivityEntry[]>('GET', `${task(id)}/activity`),
  cancelTask: (id: string) => call<TaskView>('POST', `${task(id)}/cancel`),
  restartTask: (id: string) => call<TaskView>('POST', `${task(id)}/restart`),
  deleteTask: (id: string) => call<void>('DELETE', task(id)),
  answer: (id: string, questionId: string, answer: string[]) =>
    call<TaskView>('POST', `${task(id)}/questions/${encodeURIComponent(questionId)}/answer`, { answer }),
  review: (id: string, itemId: string, review: Review) =>
    call<TaskView>('POST', `${task(id)}/items/${encodeURIComponent(itemId)}/review`, review),
  sendFollowUp: (id: string, message: string) => call<TaskView>('POST', `${task(id)}/follow-ups`, { message }),
  agentConsole: (id: string) => call<AgentConsoleAccess>('GET', `${task(id)}/agent-console`),
};

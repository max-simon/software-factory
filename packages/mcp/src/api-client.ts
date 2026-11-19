import type { NewProject, NewTask, Project, TaskEdit, TaskView } from '@factory/core';

export class ApiError extends Error {
  override name = 'ApiError';
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class ConnectionError extends Error {
  override name = 'ConnectionError';
}

/** A user as `GET /users` lists it; tasks reference users by `id` only. */
export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
  disabled: boolean;
}

export interface ApiClient {
  createProject: (project: NewProject) => Promise<Project>;
  listProjects: () => Promise<Project[]>;
  createTask: (task: NewTask) => Promise<TaskView>;
  listTasks: () => Promise<TaskView[]>;
  getTask: (id: string) => Promise<TaskView>;
  startTask: (id: string) => Promise<TaskView>;
  editTask: (id: string, edit: TaskEdit) => Promise<TaskView>;
  requestClarification: (id: string, note: string) => Promise<TaskView>;
  cancelTask: (id: string) => Promise<TaskView>;
  restartTask: (id: string) => Promise<TaskView>;
  deleteTask: (id: string) => Promise<void>;
  listUsers: () => Promise<UserSummary[]>;
}

/** `headers` go on every request, e.g. the credentials of the caller the client acts for. */
export function createApiClient(baseUrl: string, headers: Record<string, string> = {}): ApiClient {
  const base = baseUrl.replace(/\/+$/, '');

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await send(method, path, body);
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw toApiError(response, payload);
    return payload as T;
  }

  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      return await fetch(base + path, {
        method,
        headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new ConnectionError(`cannot reach the control plane at ${base}: ${describeCause(error)}`);
    }
  }

  const taskPath = (id: string) => `/tasks/${encodeURIComponent(id)}`;

  return {
    createProject: (project) => request('POST', '/projects', project),
    listProjects: () => request('GET', '/projects'),
    createTask: (task) => request('POST', '/tasks', task),
    listTasks: () => request('GET', '/tasks'),
    getTask: (id) => request('GET', taskPath(id)),
    startTask: (id) => request('POST', `${taskPath(id)}/start`),
    editTask: (id, edit) => request('PATCH', taskPath(id), edit),
    requestClarification: (id, note) => request('POST', `${taskPath(id)}/clarification`, { note }),
    cancelTask: (id) => request('POST', `${taskPath(id)}/cancel`),
    restartTask: (id) => request('POST', `${taskPath(id)}/restart`),
    deleteTask: async (id) => {
      await request('DELETE', taskPath(id));
    },
    listUsers: () => request('GET', '/users'),
  };
}

function describeCause(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error) return cause.message;
  return error instanceof Error ? error.message : String(error);
}

function toApiError(response: Response, payload: unknown): ApiError {
  const detail = (payload as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
  const code = typeof detail?.code === 'string' ? detail.code : 'unknown';
  const message = typeof detail?.message === 'string' ? detail.message : `HTTP ${response.status} ${response.statusText}`;
  return new ApiError(response.status, code, message);
}

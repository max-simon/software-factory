import type { NewProject, NewTask, Project, ProjectEdit, Review, TaskChange, TaskEdit } from '@factory/core';
import type { TaskView } from './model.ts';

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
  const payload: unknown = await response.json().catch(() => undefined);
  if (response.ok) return payload as T;
  const error = (payload as { error?: { code?: string; message?: string } } | undefined)?.error;
  throw new ApiError(response.status, error?.code ?? 'unexpected', error?.message ?? `HTTP ${response.status}`);
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
  listProjects: () => call<Project[]>('GET', '/projects'),
  getProject: (id: string) => call<Project>('GET', project(id)),
  createProject: (input: NewProject) => call<Project>('POST', '/projects', input),
  editProject: (id: string, edit: ProjectEdit) => call<Project>('PATCH', project(id), edit),
  listProjectTasks: (id: string) => call<TaskView[]>('GET', `${project(id)}/tasks`),
  getTask: (id: string) => call<TaskView>('GET', task(id)),
  createTask: (input: NewTask) => call<TaskView>('POST', '/tasks', input),
  editTask: (id: string, edit: TaskEdit) => call<TaskView>('PATCH', task(id), edit),
  moveTask: (id: string, move: { before?: string }) => call<TaskView[]>('POST', `${task(id)}/move`, move),
  startTask: (id: string) => call<TaskView>('POST', `${task(id)}/start`),
  requestClarification: (id: string, note: string) => call<TaskView>('POST', `${task(id)}/clarification`, { note }),
  returnToDraft: (id: string) => call<TaskView>('DELETE', `${task(id)}/clarification`),
  listChanges: (id: string) => call<TaskChange[]>('GET', `${task(id)}/changes`),
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

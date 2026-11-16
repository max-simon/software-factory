import type {
  AgentTaskView,
  Heartbeat,
  NewArtifact,
  NewDecision,
  NewPullRequest,
  PlanStep,
  Project,
  ProjectTaskSummary,
  Question,
  QuestionType,
  SessionMetrics,
  Work,
} from '@factory/core';

export interface QuestionRequest {
  problem: string;
  type: QuestionType;
  options: string[];
}

export interface AgentClient {
  getTask(): Promise<AgentTaskView>;
  reportPlan(plan: PlanStep[]): Promise<AgentTaskView>;
  /** The control plane assigns id and timestamp. */
  reportDecision(decision: Omit<NewDecision, 'id' | 'createdAt'>): Promise<AgentTaskView>;
  reportArtifact(artifact: Omit<NewArtifact, 'id' | 'createdAt'>): Promise<AgentTaskView>;
  reportPullRequest(pullRequest: NewPullRequest): Promise<AgentTaskView>;
  askQuestion(question: QuestionRequest): Promise<{ task: AgentTaskView; question: Question }>;
  /** Adds one session's usage to the task totals. */
  reportMetrics(metrics: SessionMetrics): Promise<AgentTaskView>;
  reportReady(): Promise<AgentTaskView>;
  reportFailure(reason: string): Promise<AgentTaskView>;
  /** Sent by the runner, never by the agent; the control plane stamps the time. */
  sendHeartbeat(heartbeat: Omit<Heartbeat, 'at'>): Promise<void>;
  /** A heartbeat asking for work; undefined means none, and the runner stops. */
  requestWork(): Promise<Work | undefined>;
  /** Takes the work handed out, with its follow-ups `followUpIds`. */
  acceptWork(followUpIds: readonly string[]): Promise<AgentTaskView>;
  /** The project of the calling task. */
  getProject(): Promise<Project>;
  /** The other tasks in the project, in rank order. */
  listProjectTasks(): Promise<ProjectTaskSummary[]>;
  getProjectTask(id: string): Promise<AgentTaskView>;
}

export class AgentApiError extends Error {
  override name = 'AgentApiError';
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createAgentClient(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): AgentClient {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetchImpl(new URL(path, baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await readJson(response);
    if (!response.ok) throw toApiError(response.status, payload);
    return payload as T;
  };
  const taskOf = async (method: string, path: string, body?: unknown) =>
    (await call<{ task: AgentTaskView }>(method, path, body)).task;

  return {
    getTask: () => taskOf('GET', '/agent/task'),
    reportPlan: (plan) => taskOf('PUT', '/agent/plan', { plan }),
    reportDecision: (decision) => taskOf('POST', '/agent/decisions', decision),
    reportArtifact: (artifact) => taskOf('POST', '/agent/artifacts', artifact),
    reportPullRequest: (pullRequest) => taskOf('POST', '/agent/pull-requests', pullRequest),
    askQuestion: (question) => call('POST', '/agent/questions', question),
    reportMetrics: (metrics) => taskOf('POST', '/agent/metrics', metrics),
    reportReady: () => taskOf('POST', '/agent/ready'),
    reportFailure: (reason) => taskOf('POST', '/agent/failure', { reason }),
    sendHeartbeat: async (heartbeat) => void (await call('POST', '/agent/heartbeat', heartbeat)),
    requestWork: async () => (await call<{ work?: Work }>('POST', '/agent/heartbeat', { phase: 'awaiting_work' })).work,
    acceptWork: (followUpIds) => taskOf('POST', '/agent/work/accept', { followUpIds }),
    getProject: async () => (await call<{ project: Project }>('GET', '/agent/project')).project,
    listProjectTasks: async () => (await call<{ tasks: ProjectTaskSummary[] }>('GET', '/agent/project/tasks')).tasks,
    getProjectTask: async (id) =>
      (await call<{ task: AgentTaskView }>('GET', `/agent/project/tasks/${encodeURIComponent(id)}`)).task,
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toApiError(status: number, payload: unknown): AgentApiError {
  const error = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (typeof error?.code === 'string' && typeof error.message === 'string') {
    return new AgentApiError(status, error.code, error.message);
  }
  return new AgentApiError(status, 'unexpected_response', `HTTP ${status}: ${String(payload).slice(0, 200)}`);
}

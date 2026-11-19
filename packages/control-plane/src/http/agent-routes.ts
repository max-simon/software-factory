import type { IncomingHttpHeaders } from 'node:http';
import { toAgentTaskView, toProjectTaskSummary, type Task } from '@factory/core';
import type { AgentService } from '../agent-service.ts';
import type { ProjectService } from '../project-service.ts';
import { NotFoundError, type TaskStore } from '../task-store.ts';
import { UnauthorizedError, type Request, type Response, type Route } from './server.ts';
import {
  parseArtifact,
  parseDecision,
  parseFailure,
  parseAcceptedWork,
  parseActivity,
  parseHeartbeat,
  parseNewQuestion,
  parsePlan,
  parseNewPullRequest,
  parseSessionMetrics,
  parseUsageLimit,
} from './validation.ts';

const bearerToken = /^Bearer ([0-9a-f]{64})$/;

const respond = (task: Task): Response => ({ status: 200, body: { task: toAgentTaskView(task) } });

export function agentRoutes(tasks: TaskStore, agent: AgentService, projects: ProjectService): Route[] {
  // The token is the only credential and identifies the task, so every route resolves it first.
  const authenticate = (headers: IncomingHttpHeaders): Task => {
    const token = bearerToken.exec(headers.authorization ?? '')?.[1];
    const task = token === undefined ? undefined : agent.findByAgentToken(token);
    if (!task) throw new UnauthorizedError('missing or invalid agent token');
    return task;
  };

  const route = (method: Route['method'], path: string, run: (task: Task, body: unknown) => Task): Route => ({
    method,
    path,
    handle: ({ headers, body }: Request) => respond(run(authenticate(headers), body)),
  });

  return [
    route('GET', '/agent/task', (task) => task),
    {
      method: 'GET',
      path: '/agent/project',
      handle: ({ headers }) => ({ status: 200, body: { project: projects.get(authenticate(headers).projectId) } }),
    },
    {
      method: 'GET',
      path: '/agent/project/tasks',
      handle: ({ headers }) => {
        const caller = authenticate(headers);
        const others = tasks.listByProject(caller.projectId).filter(({ id }) => id !== caller.id);
        return { status: 200, body: { tasks: others.map(toProjectTaskSummary) } };
      },
    },
    {
      method: 'GET',
      path: '/agent/project/tasks/:id',
      handle: ({ headers, params }) => {
        const caller = authenticate(headers);
        const task = tasks.get(params.id!);
        // Same error as an unknown id, so an agent cannot probe for tasks of other projects.
        if (task.projectId !== caller.projectId) throw new NotFoundError(`task ${params.id} not found`);
        return { status: 200, body: { task: toAgentTaskView(task) } };
      },
    },
    route('PUT', '/agent/plan', ({ id }, body) => agent.replacePlan(id, parsePlan(body))),
    route('POST', '/agent/decisions', ({ id }, body) => agent.addDecision(id, parseDecision(body))),
    route('POST', '/agent/artifacts', ({ id }, body) => agent.addArtifact(id, parseArtifact(body))),
    route('POST', '/agent/pull-requests', ({ id }, body) => agent.addPullRequest(id, parseNewPullRequest(body))),
    {
      method: 'POST',
      path: '/agent/questions',
      handle: ({ headers, body }) => {
        const { id } = authenticate(headers);
        const { task, question } = agent.askQuestion(id, parseNewQuestion(body));
        return { status: 201, body: { task: toAgentTaskView(task), question } };
      },
    },
    {
      // Sent every few seconds by a working runner, so it answers without the
      // task. A runner awaiting work gets it in the answer, or no work, which
      // tells it to stop.
      method: 'POST',
      path: '/agent/heartbeat',
      handle: ({ headers, body }) => {
        const task = authenticate(headers);
        const heartbeat = parseHeartbeat(body);
        if (heartbeat.phase !== 'awaiting_work') {
          agent.recordHeartbeat(task, heartbeat);
          return { status: 204 };
        }
        const work = agent.requestWork(task);
        return { status: 200, body: work === undefined ? {} : { work } };
      },
    },
    {
      // Batched by the runner every few seconds while the agent works; kept in memory for the engineer only.
      method: 'POST',
      path: '/agent/activity',
      handle: ({ headers, body }) => {
        const { id } = authenticate(headers);
        agent.recordActivity(id, parseActivity(body));
        return { status: 204 };
      },
    },
    route('POST', '/agent/work/accept', ({ id }, body) => agent.acceptWork(id, parseAcceptedWork(body))),
    route('POST', '/agent/metrics', ({ id }, body) => agent.addSessionMetrics(id, parseSessionMetrics(body))),
    route('POST', '/agent/ready', ({ id }) => agent.markReady(id)),
    route('POST', '/agent/failure', ({ id }, body) => agent.markFailed(id, parseFailure(body))),
    route('POST', '/agent/usage-limit', ({ id }, body) => agent.recordUsageLimit(id, parseUsageLimit(body))),
  ];
}

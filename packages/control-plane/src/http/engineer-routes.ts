import { toTaskView, type Principal, type ReviewState, type Task, type TaskAgent } from '@factory/core';
import type { ProjectService } from '../project-service.ts';
import type { TaskService } from '../task-service.ts';
import type { TaskStore } from '../task-store.ts';
import type { Route } from './server.ts';
import {
  parseAnswer,
  parseAssignees,
  parseClarification,
  parseFollowUp,
  parseMove,
  parseNewProject,
  parseNewTask,
  parseProjectEdit,
  parseReview,
  parseTaskEdit,
  ValidationError,
} from './validation.ts';

/**
 * Who acts on an engineer route. The server's guard sets it for every route
 * that is not public, so a missing one is a bug: nothing may be recorded without its user.
 */
function principalOf(principal: Principal | undefined): Principal {
  if (principal === undefined) throw new Error('engineer route reached without a principal');
  return principal;
}

/**
 * `unavailableAgent` says why tasks of an agent cannot run, e.g. a missing
 * credential, or undefined when they can; tasks for it are refused.
 * `reviews` tells which spec and pull request reviews run right now.
 */
export function engineerRoutes(
  tasks: TaskStore,
  service: TaskService,
  projects: ProjectService,
  unavailableAgent: (agent: TaskAgent) => string | undefined = () => undefined,
  reviews?: ReviewState,
): Route[] {
  const view = (task: Task) => toTaskView(task, reviews);
  return [
    {
      method: 'POST',
      path: '/projects',
      handle: ({ body, principal }) => ({ status: 201, body: projects.create(parseNewProject(body), principalOf(principal)) }),
    },
    { method: 'GET', path: '/projects', handle: () => ({ status: 200, body: projects.list() }) },
    { method: 'GET', path: '/projects/:id', handle: ({ params }) => ({ status: 200, body: projects.get(params.id!) }) },
    {
      method: 'PATCH',
      path: '/projects/:id',
      handle: ({ params, body, principal }) => ({
        status: 200,
        body: projects.edit(params.id!, parseProjectEdit(body), principalOf(principal)),
      }),
    },
    { method: 'GET', path: '/projects/:id/changes', handle: ({ params }) => ({ status: 200, body: projects.changes(params.id!) }) },
    {
      method: 'GET',
      path: '/projects/:id/tasks',
      handle: ({ params }) => {
        const { id } = projects.get(params.id!);
        return { status: 200, body: tasks.listByProject(id).map(view) };
      },
    },
    {
      method: 'POST',
      path: '/tasks',
      handle: ({ body, principal }) => {
        const input = parseNewTask(body);
        // Projects are never deleted, so a project that exists now still exists once the task is saved.
        projects.get(input.projectId);
        // Checked on creation only, since the agent never changes; claude is createTask's default.
        const unavailable = unavailableAgent(input.agent ?? 'claude');
        if (unavailable !== undefined) throw new ValidationError(unavailable);
        return { status: 201, body: view(service.create(input, principalOf(principal))) };
      },
    },
    { method: 'GET', path: '/tasks', handle: () => ({ status: 200, body: tasks.list().map(view) }) },
    { method: 'GET', path: '/tasks/:id', handle: ({ params }) => ({ status: 200, body: view(tasks.get(params.id!)) }) },
    {
      method: 'PATCH',
      path: '/tasks/:id',
      handle: ({ params, body, principal }) => ({
        status: 200,
        body: view(service.edit(params.id!, parseTaskEdit(body), principalOf(principal))),
      }),
    },
    {
      method: 'PUT',
      path: '/tasks/:id/assignees',
      handle: ({ params, body, principal }) => ({
        status: 200,
        body: view(service.setAssignees(params.id!, parseAssignees(body), principalOf(principal))),
      }),
    },
    {
      method: 'POST',
      path: '/tasks/:id/move',
      handle: ({ params, body }) => ({ status: 200, body: service.move(params.id!, parseMove(body)).map(view) }),
    },
    {
      method: 'POST',
      path: '/tasks/:id/start',
      handle: ({ params, principal }) => ({ status: 200, body: view(service.start(params.id!, principalOf(principal))) }),
    },
    {
      method: 'POST',
      path: '/tasks/:id/clarification',
      handle: ({ params, body, principal }) => ({
        status: 200,
        body: view(service.requestClarification(params.id!, parseClarification(body), principalOf(principal))),
      }),
    },
    {
      method: 'DELETE',
      path: '/tasks/:id/clarification',
      handle: ({ params, principal }) => ({ status: 200, body: view(service.returnToDraft(params.id!, principalOf(principal))) }),
    },
    { method: 'GET', path: '/tasks/:id/changes', handle: ({ params }) => ({ status: 200, body: tasks.changes(params.id!) }) },
    { method: 'GET', path: '/tasks/:id/activity', handle: ({ params }) => ({ status: 200, body: service.activity(params.id!) }) },
    {
      method: 'POST',
      path: '/tasks/:id/cancel',
      handle: async ({ params, principal }) => ({ status: 200, body: view(await service.cancel(params.id!, principalOf(principal))) }),
    },
    {
      method: 'POST',
      path: '/tasks/:id/restart',
      handle: async ({ params, principal }) => ({ status: 200, body: view(await service.restart(params.id!, principalOf(principal))) }),
    },
    {
      method: 'DELETE',
      path: '/tasks/:id',
      handle: async ({ params }) => {
        await service.delete(params.id!);
        return { status: 204 };
      },
    },
    {
      method: 'POST',
      path: '/tasks/:id/questions/:questionId/answer',
      handle: ({ params, body, principal }) => ({
        status: 200,
        body: view(service.answer(params.id!, params.questionId!, parseAnswer(body), principalOf(principal))),
      }),
    },
    {
      method: 'POST',
      path: '/tasks/:id/items/:itemId/review',
      handle: ({ params, body, principal }) => ({
        status: 200,
        body: view(service.review(params.id!, params.itemId!, parseReview(body), principalOf(principal))),
      }),
    },
    {
      method: 'POST',
      path: '/tasks/:id/follow-ups',
      handle: async ({ params, body, principal }) => ({
        status: 200,
        body: view(service.addFollowUp(params.id!, parseFollowUp(body), principalOf(principal))),
      }),
    },
    { method: 'GET', path: '/tasks/:id/agent-console', handle: ({ params }) => ({ status: 200, body: service.agentConsole(params.id!) }) },
  ];
}

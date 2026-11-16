import type { NewTask, TaskEdit, TaskView } from '@factory/core';
import { ApiError, type ApiClient } from './api-client.ts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const toJson = (value: unknown): string => JSON.stringify(value, null, 2);

const text = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }] });

// API errors go back to the caller as tool errors so the model can correct its
// input (for example a malformed repo URL) instead of the request failing.
async function relay<T>(action: () => Promise<T>): Promise<CallToolResult> {
  try {
    return text(toJson(await action()));
  } catch (error) {
    const message = error instanceof ApiError ? `${error.code}: ${error.message}` : String(error);
    return { ...text(message), isError: true };
  }
}

/** Enough to pick a task from the list; `get_task` returns everything else. */
function summarize(task: TaskView) {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    status: task.status,
    model: task.model,
    agent: task.agent,
    ...(task.repoUrl !== undefined && { repoUrl: task.repoUrl }),
    ...(task.dependsOn.length > 0 && { dependsOn: task.dependsOn }),
    updatedAt: task.updatedAt,
    pullRequests: task.pullRequests.map((pullRequest) => pullRequest.url),
  };
}

/** `saved` says what happened before, so a retry starts the task instead of creating or changing it again. */
async function startSaved(client: ApiClient, id: string, saved?: string): Promise<TaskView> {
  try {
    return await client.startTask(id);
  } catch (error) {
    if (!(error instanceof ApiError) || saved === undefined) throw error;
    throw new ApiError(error.status, error.code, `task ${id} ${saved} but not started: ${error.message}`);
  }
}

async function createTask(client: ApiClient, fields: Partial<NewTask>, start: boolean): Promise<TaskView> {
  const { projectId, title, specification } = fields;
  if (projectId === undefined || title === undefined || specification === undefined) {
    throw new ApiError(400, 'invalid_request', 'a new task needs projectId, title and specification; pass id to change an existing task');
  }
  const created = await client.createTask({ ...fields, projectId, title, specification });
  return start ? startSaved(client, created.id, 'was created as a draft') : created;
}

/** The API refuses fields that only creation sets, so they are passed on rather than dropped. */
async function changeTask(client: ApiClient, id: string, edit: TaskEdit, start: boolean): Promise<TaskView> {
  const hasEdit = Object.keys(edit).length > 0;
  const changed = hasEdit ? await client.editTask(id, edit) : undefined;
  if (start) return startSaved(client, id, hasEdit ? 'was changed' : undefined);
  return changed ?? client.getTask(id);
}

export function registerTools(server: McpServer, client: ApiClient): void {
  server.registerTool(
    'create_project',
    {
      description: 'Create a factory project. Every task belongs to exactly one project.',
      inputSchema: {
        title: z.string().min(1),
        description: z.string().optional().describe('What the project is about, in markdown'),
        autoMerge: z.boolean().optional().describe('Merge pull requests the PR review rates low risk without a human; off by default'),
      },
    },
    (project) => relay(() => client.createProject(project)),
  );
  server.registerTool(
    'list_projects',
    { description: 'List factory projects with id, title and description.', inputSchema: {} },
    () => relay(() => client.listProjects()),
  );
  server.registerTool(
    'set_task',
    {
      description:
        'Create a factory task, or change one by passing its id. A new task is a draft; start: true queues it for an agent. A queued task starts only once every task in dependsOn is done, so a whole chain can be queued at once. Title, specification and labels can change until the task is queued, dependsOn until it starts; projectId, repoUrl, baseBranch, autonomyMode, model and agent are set on creation only.',
      inputSchema: {
        id: z.string().min(1).optional().describe('The task to change; omit to create one'),
        projectId: z.string().min(1).optional().describe('Required to create: the project the task belongs to; see list_projects'),
        title: z.string().min(1).optional().describe('Required to create'),
        specification: z.string().min(1).optional().describe('Required to create: what the agent should do, in markdown'),
        repoUrl: z.string().min(1).optional().describe('Repository to work in; omit for tasks without code changes'),
        baseBranch: z.string().min(1).optional().describe('Defaults to the repository default branch'),
        labels: z.array(z.string().min(1)).optional(),
        autonomyMode: z.enum(['autonomous', 'supervised']).optional().describe('Defaults to autonomous'),
        model: z.enum(['opus', 'sonnet']).optional().describe('Defaults to opus'),
        agent: z
          .enum(['claude', 'opencode'])
          .optional()
          .describe('The coding agent that works on the task. Defaults to claude; opencode needs ANTHROPIC_API_KEY on the control plane'),
        dependsOn: z
          .array(z.string().min(1))
          .optional()
          .describe('Ids of tasks in the same project that must be done before this one starts, the complete list; see list_tasks'),
        start: z.boolean().optional().describe('Queue the task once it is saved. Defaults to false.'),
      },
    },
    ({ id, start = false, ...fields }) =>
      relay(() => (id === undefined ? createTask(client, fields, start) : changeTask(client, id, fields, start))),
  );
  server.registerTool(
    'list_tasks',
    {
      description: 'List factory tasks with id, project id, title, status, model, agent, repo and pull request URLs.',
      inputSchema: {
        projectId: z.string().min(1).optional().describe('Only tasks of this project'),
        status: z
          .enum(['draft', 'clarification_required', 'queued', 'in_progress', 'input_required', 'ready', 'done', 'failed'])
          .optional()
          .describe('Only tasks with this status'),
      },
    },
    ({ projectId, status }) =>
      relay(async () => {
        const tasks = await client.listTasks();
        return tasks
          .filter((task) => projectId === undefined || task.projectId === projectId)
          .filter((task) => status === undefined || task.status === status)
          .map(summarize);
      }),
  );
  server.registerTool(
    'get_task',
    {
      description: 'Fetch a task with its specification, plan, decisions, artifacts, questions and pull requests.',
      inputSchema: { id: z.string().min(1) },
    },
    ({ id }) => relay(() => client.getTask(id)),
  );
  server.registerTool(
    'request_clarification',
    {
      description:
        'Hold a draft task in clarification_required until the engineer settles what is unclear about its specification. The engineer edits it, then queues it or moves it back to draft.',
      inputSchema: {
        id: z.string().min(1),
        note: z.string().min(1).describe('What is unclear or missing in the specification, in markdown'),
      },
    },
    ({ id, note }) => relay(() => client.requestClarification(id, note)),
  );
  server.registerTool(
    'cancel_task',
    {
      description:
        'Cancel a queued or running task: its execution server is stopped and the task fails with reason "Cancelled by the engineer".',
      inputSchema: { id: z.string().min(1) },
      annotations: { destructiveHint: true },
    },
    ({ id }) => relay(() => client.cancelTask(id)),
  );
  server.registerTool(
    'restart_task',
    {
      description:
        'Restart a task that has started: its execution server is stopped, its plan, decisions, artifacts, questions, pull requests and follow-ups are cleared, and it is queued again. Pull requests the old run opened stay open on GitHub.',
      inputSchema: { id: z.string().min(1) },
      annotations: { destructiveHint: true },
    },
    ({ id }) => relay(() => client.restartTask(id)),
  );
  server.registerTool(
    'delete_task',
    {
      description: 'Delete a task in any status for good, stopping its execution server first.',
      inputSchema: { id: z.string().min(1) },
      annotations: { destructiveHint: true },
    },
    ({ id }) =>
      relay(async () => {
        await client.deleteTask(id);
        return { deleted: id };
      }),
  );
}

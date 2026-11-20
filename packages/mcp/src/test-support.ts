import type { TaskView } from '@factory/core';
import { ApiError, type ApiClient, type UserSummary } from './api-client.ts';
import type { NewProject, NewTask, Project, TaskEdit } from '@factory/core';

export function sampleTask(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: 't1',
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
    projectId: 'p1',
    title: 'Add a greeting',
    specification: 'Print hello.',
    labels: [],
    autonomyMode: 'autonomous',
    model: 'opus',
    status: 'draft',
    rank: 0,
    plan: [],
    decisions: [],
    artifacts: [],
    questions: [],
    pullRequests: [],
    followUps: [],
    dependsOn: [],
    isSpecUnderReview: false,
    isInputUnderReview: false,
    ...overrides,
  };
}

export interface FakeTaskClient extends ApiClient {
  projects: Project[];
  tasks: TaskView[];
  created: NewTask[];
  edited: Array<{ id: string; edit: TaskEdit }>;
  users: UserSummary[];
  /** Makes `startTask` fail, as the API does for a task that cannot be queued. */
  failStart?: ApiError;
}

/** An in-memory stand-in for the engineer API with the same not-found error. */
export function fakeTaskClient(tasks: TaskView[] = []): FakeTaskClient {
  const find = (id: string): TaskView => {
    const task = fake.tasks.find((candidate) => candidate.id === id);
    if (!task) throw new ApiError(404, 'not_found', `task ${id} not found`);
    return task;
  };
  const fake: FakeTaskClient = {
    projects: [],
    tasks,
    createProject: async (input: NewProject) => {
      const project: Project = {
        id: `p${fake.projects.length + 1}`,
        createdAt: '2026-11-12T00:00:00.000Z',
        updatedAt: '2026-11-12T00:00:00.000Z',
        title: input.title,
        description: input.description ?? '',
        autoMerge: input.autoMerge ?? false,
        taskProviders: input.taskProviders ?? [],
      };
      fake.projects.push(project);
      return project;
    },
    listProjects: async () => fake.projects,
    created: [],
    createTask: async (input) => {
      fake.created.push(input);
      const task = sampleTask({
        id: `t${fake.tasks.length + 1}`,
        ...input,
        labels: input.labels ?? [],
        dependsOn: input.dependsOn ?? [],
      });
      fake.tasks.push(task);
      return task;
    },
    startTask: async (id) => {
      if (fake.failStart) throw fake.failStart;
      const task = find(id);
      task.status = 'queued';
      return task;
    },
    edited: [],
    editTask: async (id, edit) => {
      fake.edited.push({ id, edit });
      return Object.assign(find(id), edit);
    },
    users: [],
    listUsers: async () => fake.users,
    requestClarification: async (id, note) => {
      const task = find(id);
      task.status = 'clarification_required';
      task.clarification = note;
      return task;
    },
    cancelTask: async (id) => {
      const task = find(id);
      task.status = 'failed';
      task.failureReason = 'Cancelled by the engineer';
      task.failedAt = '2026-11-12T00:00:00.000Z';
      return task;
    },
    restartTask: async (id) => {
      const task = find(id);
      task.status = 'queued';
      return task;
    },
    deleteTask: async (id) => {
      find(id);
      fake.tasks = fake.tasks.filter((task) => task.id !== id);
    },
    listTasks: async () => fake.tasks,
    getTask: async (id) => find(id),
  };
  return fake;
}

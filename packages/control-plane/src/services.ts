import { ActivityFeed } from './activity-feed.ts';
import { AgentService } from './agent-service.ts';
import { LifecycleService } from './lifecycle-service.ts';
import { TaskService, type TaskServiceDeps } from './task-service.ts';
import { TaskStore, type TaskStoreDeps } from './task-store.ts';

/** The task store and the services by who acts: the engineer, the agent and its runner, the control plane itself. */
export interface Services {
  tasks: TaskStore;
  service: TaskService;
  agent: AgentService;
  lifecycle: LifecycleService;
}

export function createServices(deps: TaskStoreDeps & Omit<TaskServiceDeps, 'tasks' | 'activity'>): Services {
  const tasks = new TaskStore(deps);
  // The agent writes it, the engineer reads it.
  const activity = new ActivityFeed();
  return {
    tasks,
    service: new TaskService({ ...deps, tasks, activity }),
    agent: new AgentService(tasks, activity),
    lifecycle: new LifecycleService(tasks),
  };
}

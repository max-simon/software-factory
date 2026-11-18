import { readFileSync } from 'node:fs';
import { pendingWork, type Approval, type Heartbeat, type Project, type AgentTaskView, type Question, type SessionMetrics, type TaskStatus } from '@factory/core';
import { AgentApiError, type AgentClient } from './agent-client.ts';

export function sampleTask(overrides: Partial<AgentTaskView> = {}): AgentTaskView {
  return {
    id: 't1',
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
    projectId: 'p1',
    title: 'Add a greeting',
    specification: 'Print hello.',
    labels: ['demo'],
    autonomyMode: 'supervised',
    model: 'opus',
    agent: 'claude',
    repoUrl: 'https://github.com/o/r',
    status: 'in_progress',
    rank: 0,
    plan: [],
    decisions: [],
    artifacts: [],
    questions: [],
    pullRequests: [],
    followUps: [],
    dependsOn: [],
    ...overrides,
  };
}

export function sampleProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
    title: 'Greeter',
    description: 'Friendly command-line tools.',
    autoMerge: false,
    ...overrides,
  };
}

export interface FakeAgentClient extends AgentClient {
  task: AgentTaskView;
  project: Project;
  /** The other tasks in the project, in rank order. */
  otherTasks: AgentTaskView[];
  /** Changing calls and task reads; project reads are left out as they change nothing. */
  calls: string[];
  /** Kept apart from `calls`: heartbeats run alongside everything else. */
  heartbeats: Array<Omit<Heartbeat, 'at'>>;
  /** Every activity batch, in order. */
  activity: string[][];
  /** Every reported delta, in order. */
  metrics: SessionMetrics[];
}

/** The time the fake stamps on reported items. */
export const sampleNow = '2026-11-12T00:00:00.000Z';

/**
 * In-memory agent API with just enough of the domain rules for executor tests;
 * handing out work follows the core's rules. Reports are stamped `sampleNow`
 * until work is accepted: each acceptance moves the clock on, so input
 * reported after it counts as new.
 */
export function fakeAgentClient(task: AgentTaskView = sampleTask()): FakeAgentClient {
  let now = Date.parse(sampleNow);
  const stamp = () => new Date(now).toISOString();
  // The control plane keeps this on the task's execution, which agents do not see.
  let workAcceptedAt: string | undefined;
  const withExecution = () => ({
    ...fake.task,
    execution: { id: 'c1', tokenHash: 'h', worker: { state: 'working' as const, since: sampleNow }, ...(workAcceptedAt && { workAcceptedAt }) },
  });
  const fake: FakeAgentClient = {
    task,
    project: sampleProject(),
    otherTasks: [],
    calls: [],
    heartbeats: [],
    activity: [],
    metrics: [],
    getTask: async () => record('getTask', {}),
    reportPlan: async (plan) => record('reportPlan', { plan }),
    reportDecision: async ({ requestApproval, ...decision }) => {
      const id = `d${fake.task.decisions.length + 1}`;
      const added = { ...decision, id, createdAt: stamp(), ...(requestApproval && { approval: { status: 'pending' as const } }) };
      return record('reportDecision', { ...awaiting(requestApproval), decisions: [...fake.task.decisions, added] });
    },
    reportArtifact: async ({ requestApproval, ...artifact }) => {
      const id = `a${fake.task.artifacts.length + 1}`;
      const added = { ...artifact, id, createdAt: stamp(), ...(requestApproval && { approval: { status: 'pending' as const } }) };
      return record('reportArtifact', { ...awaiting(requestApproval), artifacts: [...fake.task.artifacts, added] });
    },
    reportPullRequest: async (pr) =>
      record('reportPullRequest', { pullRequests: [...fake.task.pullRequests, { ...pr, status: 'open' }] }),
    askQuestion: async (request) => {
      if (fake.task.autonomyMode !== 'supervised') {
        throw new AgentApiError(409, 'questions_not_allowed', 'decide yourself and report the decision');
      }
      const question: Question = { id: `q${fake.task.questions.length + 1}`, createdAt: stamp(), ...request };
      const task = record('askQuestion', { status: 'input_required', questions: [...fake.task.questions, question] });
      return { task, question };
    },
    reportMetrics: async (delta) => {
      fake.metrics.push(delta);
      return record('reportMetrics', {});
    },
    reportReady: async () => record('reportReady', { status: 'ready' }),
    reportFailure: async (failureReason) => record('reportFailure', { status: 'failed', failureReason }),
    sendHeartbeat: async (heartbeat) => {
      fake.heartbeats.push({ ...heartbeat });
    },
    sendActivity: async (entries) => {
      fake.activity.push([...entries]);
    },
    // Like the control plane: no work idles the worker and fails a task still in progress.
    requestWork: async () => {
      const work = pendingWork(withExecution());
      const isLost = work === undefined && fake.task.status === 'in_progress';
      const failure = 'the agent ended its turn without reporting ready, failure or a question';
      record('requestWork', isLost ? { status: 'failed', failureReason: failure } : {});
      return work;
    },
    acceptWork: async (ids) => {
      now += 1000;
      const accepted = stamp();
      now += 1000;
      const followUps = fake.task.followUps.map((f) =>
        ids.includes(f.id) && f.deliveredAt === undefined ? { ...f, deliveredAt: accepted } : f,
      );
      workAcceptedAt = accepted;
      return record('acceptWork', { followUps });
    },
    getProject: async () => fake.project,
    listProjectTasks: async () =>
      fake.otherTasks.map(({ id, title, status, labels, repoUrl, baseBranch, pullRequests, updatedAt }) => ({
        id,
        title,
        status,
        labels,
        repoUrl,
        baseBranch,
        pullRequests,
        updatedAt,
      })),
    getProjectTask: async (id) => {
      const task = fake.otherTasks.find((t) => t.id === id);
      if (!task) throw new AgentApiError(404, 'not_found', `task ${id} not found`);
      return task;
    },
  };
  const awaiting = (requestApproval?: boolean): Partial<AgentTaskView> => {
    if (!requestApproval) return {};
    if (fake.task.autonomyMode !== 'supervised') {
      throw new AgentApiError(409, 'approvals_not_allowed', 'report without requesting approval and proceed');
    }
    return { status: 'input_required' };
  };
  const record = (call: string, change: Partial<AgentTaskView>): AgentTaskView => {
    fake.calls.push(call);
    fake.task = { ...fake.task, ...change };
    return fake.task;
  };
  return fake;
}

export function answerAll(fake: FakeAgentClient, answer: string[], status: TaskStatus = 'in_progress'): void {
  fake.task = { ...fake.task, status, questions: fake.task.questions.map((q) => ({ ...q, answer: q.answer ?? answer })) };
}

export function reviewAll(fake: FakeAgentClient, approval: Approval, status: TaskStatus = 'in_progress'): void {
  const review = <T extends { approval?: Approval }>(item: T): T =>
    item.approval?.status === 'pending' ? { ...item, approval } : item;
  fake.task = { ...fake.task, status, decisions: fake.task.decisions.map(review), artifacts: fake.task.artifacts.map(review) };
}

/** Real stream-json output of claude 2.1.322, from `fixtures/`. */
export const claudeFixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** What the control plane does on a follow-up: a ready or failed task goes back to in_progress. */
export function sendFollowUp(fake: FakeAgentClient, message: string): void {
  const followUps = [...fake.task.followUps, { id: `f${fake.task.followUps.length + 1}`, createdAt: sampleNow, message }];
  const isResumed = fake.task.status === 'ready' || fake.task.status === 'failed';
  fake.task = { ...fake.task, followUps, ...(isResumed && { status: 'in_progress' as const, failureReason: undefined }) };
}

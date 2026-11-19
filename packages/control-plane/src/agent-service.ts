import {
  acceptWork,
  addArtifact,
  addDecision,
  addPullRequest,
  addSessionMetrics,
  askQuestion,
  markFailed,
  markReady,
  pendingWork,
  recordHeartbeat,
  releaseWorker,
  replacePlan,
  type Heartbeat,
  type NewArtifact,
  type NewDecision,
  type NewPullRequest,
  type NewQuestion,
  type PlanStep,
  type Question,
  type SessionMetrics,
  type Task,
  type Work,
} from '@factory/core';
import type { ActivityFeed } from './activity-feed.ts';
import { hashAgentToken } from './agent-token.ts';
import type { TaskStore } from './task-store.ts';

/** What the agent reports; the service assigns id and timestamp. */
type Reported<T> = Omit<T, 'id' | 'createdAt'>;

/**
 * What the agent API does for the callers inside an execution server: the
 * agent reports its work, the runner beats and asks for work. Both hold the
 * task's token.
 */
export class AgentService {
  readonly #tasks: TaskStore;
  readonly #activity: ActivityFeed;

  constructor(tasks: TaskStore, activity: ActivityFeed) {
    this.#tasks = tasks;
    this.#activity = activity;
  }

  findByAgentToken(token: string): Task | undefined {
    return this.#tasks.findByTokenHash(hashAgentToken(token));
  }

  replacePlan(id: string, plan: PlanStep[]): Task {
    return this.#tasks.update(id, 'agent', (task) => replacePlan(task, plan));
  }

  addDecision(id: string, decision: Reported<NewDecision>): Task {
    return this.#tasks.update(id, 'agent', (task) =>
      addDecision(task, { ...decision, id: this.#tasks.newItemId('d'), createdAt: this.#tasks.now() }),
    );
  }

  addArtifact(id: string, artifact: Reported<NewArtifact>): Task {
    return this.#tasks.update(id, 'agent', (task) =>
      addArtifact(task, { ...artifact, id: this.#tasks.newItemId('a'), createdAt: this.#tasks.now() }),
    );
  }

  addPullRequest(id: string, pullRequest: NewPullRequest): Task {
    return this.#tasks.update(id, 'agent', (task) => addPullRequest(task, pullRequest));
  }

  askQuestion(id: string, question: Reported<NewQuestion>): { task: Task; question: Question } {
    const task = this.#tasks.update(id, 'agent', (current) =>
      askQuestion(current, { ...question, id: this.#tasks.newItemId('q'), createdAt: this.#tasks.now() }),
    );
    return { task, question: task.questions.at(-1)! };
  }

  addSessionMetrics(id: string, delta: SessionMetrics): Task {
    return this.#tasks.update(id, 'agent', (task) => addSessionMetrics(task, delta));
  }

  markReady(id: string): Task {
    return this.#tasks.update(id, 'agent', markReady);
  }

  markFailed(id: string, reason: string): Task {
    return this.#tasks.update(id, 'agent', (task) => markFailed(task, reason, this.#tasks.now()));
  }

  /**
   * Takes the task the caller just loaded instead of an id: heartbeats are the
   * most frequent request, and the agent API has loaded the task to authenticate.
   */
  recordHeartbeat(task: Task, heartbeat: Omit<Heartbeat, 'at'>): void {
    const { execution } = recordHeartbeat(task, { ...heartbeat, at: this.#tasks.now() });
    this.#tasks.saveHeartbeat(task.id, execution!.lastHeartbeat!);
  }

  /** Adds what the runner saw the agent do since its last report to the current turn. */
  recordActivity(id: string, texts: readonly string[]): void {
    const at = this.#tasks.now();
    this.#activity.append(id, texts.map((text) => ({ at, text })));
  }

  /**
   * Answers a runner that asks for work. With none pending its worker goes
   * idle, and a task still in progress fails: its agent ended the turn without
   * an outcome. Synchronous from load to save, so no follow-up slips in between.
   */
  requestWork(task: Task): Work | undefined {
    this.recordHeartbeat(task, { phase: 'awaiting_work' });
    const work = pendingWork(task);
    if (work === undefined) {
      const reason = 'the agent ended its turn without reporting ready, failure or a question';
      this.#tasks.update(task.id, 'agent', (current) => releaseWorker(current, reason, this.#tasks.now()));
    }
    return work;
  }

  /** Accepted work starts a turn, so the activity of the previous one is dropped. */
  acceptWork(id: string, followUpIds: readonly string[]): Task {
    const task = this.#tasks.update(id, 'agent', (current) => acceptWork(current, followUpIds, this.#tasks.now()));
    this.#activity.startTurn(id);
    return task;
  }
}

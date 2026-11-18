import type { TaskChange } from './changelog.ts';
import type { Project } from './project.ts';
import type { InputReview, InputReviewRequest, PrReview, PrReviewRequest, SpecReview, SpecReviewRequest } from './review.ts';
import type { AgentConsole, Heartbeat, PullRequest, Task, TaskAgent, TaskModel, TaskStatus } from './task.ts';
import type { Credentials, ExternalIdentity, User } from './user.ts';

export interface TaskRepository {
  /** Writes the task and appends `changes` to its changelog in one transaction. */
  insert(task: Task, changes?: readonly TaskChange[]): void;
  get(id: string): Task | undefined;
  /** All tasks, or only those in one of `statuses`, in rank order. */
  list(statuses?: readonly TaskStatus[]): Task[];
  /** Writes the task and appends `changes` to its changelog in one transaction. */
  save(task: Task, changes?: readonly TaskChange[]): void;
  /** The task's changelog, oldest first; empty for an unknown task. */
  listChanges(id: string): TaskChange[];
  /** Writes only `lastHeartbeat`: heartbeats are frequent and must not rewrite the whole task. */
  saveHeartbeat(id: string, heartbeat: Heartbeat): void;
  /** Removes the task with its changelog; does nothing when the task does not exist. */
  delete(id: string): void;
  findByTokenHash(tokenHash: string): Task | undefined;
}

export interface ProjectRepository {
  insert(project: Project): void;
  get(id: string): Project | undefined;
  /** Oldest first. */
  list(): Project[];
  save(project: Project): void;
}

export interface ExecutionSpec {
  taskId: string;
  repoUrl?: string;
  baseBranch?: string;
  model: TaskModel;
  agent: TaskAgent;
  controlPlaneUrl: string;
  /** Plain agent token; never stored. */
  token: string;
}

/** The port opencode serves its API and web console on inside the execution server. */
export const agentConsolePort = 4096;

/** The port the runner listens on for nudges inside the execution server. */
export const doorbellPort = 4097;

export interface StartedExecution {
  executionId: string;
  /** Only for agents that have a web console (opencode). */
  agentConsole?: AgentConsole;
}

/**
 * Runs execution servers. One keeps its disk until removed, so its agent
 * session survives whatever the runtime does with it in between. Whether an
 * idle execution server keeps running or is suspended is the runtime's choice.
 */
export interface ExecutionRuntime {
  /** Creates and starts the execution server. */
  start(spec: ExecutionSpec): Promise<StartedExecution>;
  /**
   * Tells the execution server that work waits, resuming it if the runtime
   * suspended it; its runner then asks for the work. Harmless to repeat.
   * Returns the agent console's address when it may have changed; `agent` is
   * the one the execution server was started with.
   */
  notify(executionId: string, agent: TaskAgent): Promise<{ agentConsoleUrl?: string }>;
  /** Restarts a hung or silent execution server, keeping its disk; its runner then asks for work. */
  restart(executionId: string, agent: TaskAgent): Promise<{ agentConsoleUrl?: string }>;
  remove(executionId: string): Promise<void>;
  /** Ids of every execution server this runtime started that still exists, running or stopped. */
  listExecutions(): Promise<string[]>;
}

/** Reads a pull request's current title and status from its host. */
export interface PullRequestReader {
  read(url: string): Promise<PullRequest>;
}

/** Comments on an open pull request and merges it on its host. */
export interface PullRequestWriter {
  /** The commit the pull request's head points to now. */
  readHead(url: string): Promise<string>;
  /** A conversation comment, which the factory never reads back. */
  comment(url: string, body: string): Promise<void>;
  /** Merges only while the pull request's head is still `headSha`, so commits pushed since are never merged unseen. */
  merge(url: string, headSha: string): Promise<void>;
}

/**
 * Reviews a draft task's specification before it may start, the input a
 * supervised agent asks for, and a pull request before it is merged. One request, one answer each; how and where
 * the reviewer runs is the adapter's choice.
 */
export interface Reviewer {
  /** Whether a draft task fits its project and is defined well enough for a coding agent. */
  reviewSpec(request: SpecReviewRequest): Promise<SpecReview>;
  /** Which open questions and approval requests it can settle itself, and how; the rest stay with the engineer. */
  reviewInput(request: InputReviewRequest): Promise<InputReview>;
  /** How risky it is to merge a pull request without a human review. */
  reviewPr(request: PrReviewRequest): Promise<PrReview>;
}

/**
 * Stores users and the external identities linked to them. Usernames are
 * unique; callers look them up normalised (`normalizeUsername`).
 */
export interface UserRepository {
  /** Throws a `DomainError` `duplicate_username` when the username is taken. */
  insert(user: User): void;
  /** Writes the user; throws `duplicate_username` when its new username is taken by another user. */
  update(user: User): void;
  get(id: string): User | undefined;
  getByUsername(username: string): User | undefined;
  /** Oldest first, disabled users included. */
  list(): User[];
  /** Links a provider's subject to a user; a `(provider, subject)` pair maps to exactly one user. */
  linkIdentity(identity: ExternalIdentity): void;
  findIdentity(provider: string, subject: string): ExternalIdentity | undefined;
}

/**
 * Checks credentials against one identity source. Resolves the user id for
 * valid credentials of an active user, `undefined` otherwise, without telling
 * which part was wrong. An adapter ignores credential kinds it does not handle.
 */
export interface Authenticator {
  authenticate(credentials: Credentials): Promise<string | undefined>;
}

/** One-way password hashing; the hash string encodes whatever the verifier needs (salt, parameters). */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

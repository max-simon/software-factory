export type TaskStatus =
  | 'draft'
  | 'clarification_required'
  | 'queued'
  | 'in_progress'
  | 'input_required'
  | 'ready'
  | 'done'
  | 'failed';

export type AutonomyMode = 'autonomous' | 'supervised';

/** Claude model alias the execution server runs the agent with. */
export type TaskModel = 'opus' | 'sonnet';

/** The coding agent the execution server runs. */
export type TaskAgent = 'claude' | 'opencode';

export type PlanStepStatus = 'pending' | 'in_progress' | 'done';

export interface PlanStep {
  title: string;
  status: PlanStepStatus;
  nextStep?: string;
}

export type ReviewVerdict = 'approved' | 'changes_requested';

/** A review comment on a passage of an artifact, identified by the quoted text. */
export interface Annotation {
  quote: string;
  comment: string;
}

/** Why the input reviewer gave an answer or review itself instead of leaving it to the engineer; for the engineer, not the agent. */
export interface ReviewerNote {
  rationale: string;
}

/** Set only when the agent asked for approval; supervised tasks only. */
export interface Approval {
  status: 'pending' | ReviewVerdict;
  /** The overall comment, for the agent. */
  comment?: string;
  annotations?: Annotation[];
  /** Approved decisions only: the reviewer's pick, 0-based into `options`, when it differs from the agent's `chosen`. */
  chosen?: number;
  /** Set when the input reviewer reviewed it; unset for the engineer's reviews. */
  byReviewer?: ReviewerNote;
}

export interface Decision {
  id: string;
  /** When the agent reported it; stamped by the control plane. */
  createdAt: string;
  problem: string;
  /** Ordered; empty when the decision is reported as text in `reasoning` only. */
  options: string[];
  /** 0-based index into `options`; set exactly when `options` is not empty. */
  chosen?: number;
  reasoning: string;
  approval?: Approval;
}

export interface Artifact {
  id: string;
  /** When the agent reported it; stamped by the control plane. */
  createdAt: string;
  title: string;
  kind: string;
  content: string;
  approval?: Approval;
}

export type QuestionType = 'text' | 'checkbox' | 'radio';

export interface Question {
  id: string;
  /** When the agent asked it; stamped by the control plane. */
  createdAt: string;
  problem: string;
  type: QuestionType;
  options: string[];
  /** One element for `text` and `radio`, any number for `checkbox`. */
  answer?: string[];
  /** Set when the input reviewer answered it; unset for the engineer's answers. */
  byReviewer?: ReviewerNote;
}

/** GitHub's state of a pull request, as the control plane last read it. */
export type PullRequestStatus = 'open' | 'merged' | 'closed';

export interface PullRequest {
  url: string;
  title: string;
  /** `open` when reported; the control plane updates it while it watches the pull requests. */
  status: PullRequestStatus;
  /** The commit its head pointed to when the control plane last read it; unset until the first read. */
  headSha?: string;
  /** Submitted reviews, oldest first, as the control plane last read them; unset until the first read. */
  reviews?: PullRequestReview[];
}

/** Submitted states only: pending drafts are invisible to others, dismissed reviews no longer count. */
export type PullRequestReviewState = 'approved' | 'changes_requested' | 'commented';

export interface PullRequestReview {
  /** The host's id of the review. */
  id: number;
  state: PullRequestReviewState;
  /** Login of the reviewer. */
  author: string;
  /** Empty when the review has only inline comments, or none. */
  body: string;
  /** Where to see the review in the browser. */
  url: string;
  submittedAt: string;
}

/**
 * What the execution server is doing, as its runner process sees it; the agent
 * is not involved. `awaiting_work` asks the control plane for work: the reply
 * carries it, or tells the runner to wait idle for a nudge.
 */
export type HeartbeatPhase = 'awaiting_work' | 'setting_up' | 'working';

export interface Heartbeat {
  /** When the control plane received it; stamped by the control plane. */
  at: string;
  phase: HeartbeatPhase;
  /** Short text derived from the agent's output, e.g. "Running Bash: yarn test". */
  activity?: string;
}

/** Summed over every agent session of the task; unset until the first report. */
export interface SessionMetrics {
  durationMs: number;
  costUsd: number;
}

/** Where an engineer reaches the agent's own web console, and its password. */
export interface AgentConsole {
  url: string;
  password: string;
}

/**
 * The execution server of a started task, as the control plane tracks it:
 * how its runner authenticates, whether it works, what it last said. None of
 * it is the task's content; it goes with the execution server.
 */
export interface Execution {
  /** The runtime's id of the execution server. */
  id: string;
  /** SHA-256 of the agent token, which identifies the task to the agent API. */
  tokenHash: string;
  worker: Worker;
  /** When the runner last accepted work; unset until it accepted the task itself. */
  workAcceptedAt?: string;
  /** Latest sign of life from the runner; each heartbeat replaces it. */
  lastHeartbeat?: Heartbeat;
  /** Only for agents that have a web console (opencode). */
  console?: AgentConsole;
}

/**
 * `working`: started or notified of work, expected to send heartbeats. `idle`:
 * its runner found no work and waits to be notified; whether the runtime keeps
 * it running or suspends it meanwhile is none of the control plane's concern.
 */
export type WorkerState = 'working' | 'idle';

export interface Worker {
  state: WorkerState;
  /** When it entered the state; stamped by the control plane. */
  since: string;
}

/** A message from the engineer for the agent of a started task. */
export interface FollowUp {
  id: string;
  /** When it was sent; stamped by the control plane. */
  createdAt: string;
  message: string;
  /** Set once the runner accepted it for the agent session. */
  deliveredAt?: string;
}

export interface Task {
  id: string;
  createdAt: string;
  updatedAt: string;
  projectId: string;
  title: string;
  specification: string;
  labels: string[];
  autonomyMode: AutonomyMode;
  /** Model the agent runs with; tasks stored before models existed read as `opus`. */
  model: TaskModel;
  /** Agent the execution server runs; tasks stored before agents were chosen per task read as `claude`. */
  agent: TaskAgent;
  /** Unset for tasks that only produce plan, decisions and artifacts. */
  repoUrl?: string;
  /** Unset means the repository's default branch; only set with `repoUrl`. */
  baseBranch?: string;
  status: TaskStatus;
  /** What is unclear about the specification; set exactly while the task is `clarification_required`. */
  clarification?: string;
  /** Position on the board, lowest first; queued tasks are dispatched in this order. */
  rank: number;
  /**
   * Ids of tasks in the same project that must be done before this one starts;
   * tasks stored before dependencies existed read as `[]`.
   */
  dependsOn: string[];
  plan: PlanStep[];
  decisions: Decision[];
  artifacts: Artifact[];
  questions: Question[];
  pullRequests: PullRequest[];
  /** Tasks stored before follow-ups existed read as `[]`. */
  followUps: FollowUp[];
  failureReason?: string;
  metrics?: SessionMetrics;
  /** Set with the execution server, removed with it. */
  execution?: Execution;
}

/**
 * What the control plane hands a runner that asks for work. A runner without
 * an agent session starts one with the task; otherwise it resumes the session
 * with the follow-ups and the answered or reviewed items `inputIds`.
 */
export interface Work {
  followUps: FollowUp[];
  inputIds: string[];
}

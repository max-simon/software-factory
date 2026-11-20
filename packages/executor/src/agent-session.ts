// The port between the runner and the coding agent that works on the task.
// The runner decides what to prompt and when; an adapter only runs one turn of
// one long-lived session and says how it ended.

import type { TokenUsage } from '@factory/core';

export interface SessionTurn {
  prompt: string;
  sessionId: string;
  /** False for the first turn, which creates the session `sessionId`; true for every later one. */
  isResume: boolean;
}

export interface TurnOutcome {
  /** Set when the turn failed; becomes the task's failure reason, so it carries the cause. */
  failure?: string;
  /** Set, with `failure`, when the turn failed because the agent's account hit a usage limit. */
  usageLimit?: UsageLimitHit;
  /** The session's running cost total after this turn; unset when the agent reported none. */
  totalCostUsd?: number;
  /** The session's running token totals after this turn; unset when the agent reported none. */
  totalTokens?: TokenUsage;
}

export interface UsageLimitHit {
  /** When the limit resets, as an ISO timestamp; unset when the agent did not say. */
  resetsAt?: string;
}

export interface AgentSession {
  /** Runs one turn to its end. `onActivity` hears what the agent is doing meanwhile. */
  runTurn(turn: SessionTurn, onActivity?: (activity: string) => void): Promise<TurnOutcome>;
}

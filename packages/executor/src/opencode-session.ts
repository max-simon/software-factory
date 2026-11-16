import type { TaskModel } from '@factory/core';
import type { AgentSession, SessionTurn, TurnOutcome } from './agent-session.ts';
import { isIdle, type IdleMessage, type ModelRef, type OpencodeApi } from './opencode-api.ts';
import { activityOfEvent } from './opencode-status.ts';

export interface OpencodeSessionSettings {
  /** The agent in the server config that carries the orchestrator prompt. */
  agent: string;
  model: TaskModel;
  /** The cloned repository; the agent works there. */
  cwd: string;
}

export interface OpencodeSessionDeps {
  api: OpencodeApi;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

// opencode needs exact model ids where the claude CLI takes aliases.
const models: Record<TaskModel, ModelRef> = {
  opus: { providerID: 'anthropic', id: 'claude-opus-5-5' },
  sonnet: { providerID: 'anthropic', id: 'claude-sonnet-5-5' },
};

const recheckMs = 1_000;
const resubscribeMs = 5_000;

/** Runs each turn as one prompt to a long-lived `opencode serve` session. */
export function createOpencodeSession(deps: OpencodeSessionDeps, settings: OpencodeSessionSettings): AgentSession {
  return { runTurn: (turn, onActivity) => runTurn(deps, settings, turn, onActivity) };
}

async function runTurn(
  deps: OpencodeSessionDeps,
  settings: OpencodeSessionSettings,
  turn: SessionTurn,
  onActivity?: (activity: string) => void,
): Promise<TurnOutcome> {
  const { api } = deps;
  const stopWatching = onActivity ? watchActivity(deps, onActivity) : () => {};
  try {
    if (!turn.isResume) {
      await api.createSession({ id: turn.sessionId, agent: settings.agent, model: models[settings.model], directory: settings.cwd });
    }
    const { admittedAt } = await api.prompt(turn.sessionId, turn.prompt);
    const end = await waitForEnd(deps, turn.sessionId, admittedAt);
    const failure = failureOf(end);
    return { ...(failure !== undefined && { failure }), totalCostUsd: await api.cost(turn.sessionId) };
  } catch (error) {
    return { failure: `opencode session failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    stopWatching();
  }
}

// `wait` may return before the prompt's execution started, so the turn is over
// only once the session records an idle message newer than the prompt.
async function waitForEnd(deps: OpencodeSessionDeps, sessionId: string, admittedAt: number): Promise<IdleMessage> {
  for (;;) {
    await deps.api.waitIdle(sessionId);
    const latest = await deps.api.latestMessage(sessionId);
    if (isIdle(latest) && latest.time.created >= admittedAt) return latest;
    await deps.sleep(recheckMs);
  }
}

function failureOf(end: IdleMessage): string | undefined {
  switch (end.outcome) {
    case 'succeeded':
      return undefined;
    case 'interrupted':
      return 'opencode turn was interrupted';
    case 'failed':
      return `opencode turn failed${end.error ? `: ${end.error.type}: ${end.error.message}` : ''}`;
  }
}

/** Streams activity until the returned function is called; a broken stream is opened again. */
function watchActivity(deps: OpencodeSessionDeps, onActivity: (activity: string) => void): () => void {
  const controller = new AbortController();
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        for await (const event of deps.api.events(controller.signal)) {
          const activity = activityOfEvent(event);
          if (activity !== undefined) onActivity(activity);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        deps.log(`opencode event stream failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await deps.sleep(resubscribeMs);
    }
  })();
  return () => controller.abort();
}

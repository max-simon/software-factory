import type { TaskModel } from '@factory/core';
import type { AgentSession, SessionTurn, TurnOutcome } from './agent-session.ts';
import { activityOfLine } from './claude-status.ts';
import type { BridgeConfig } from './config.ts';
import type { RunCommand } from './run-command.ts';

export interface ClaudeSessionSettings {
  mcpConfigPath: string;
  systemPrompt: string;
  /** Passed to the CLI as a model alias. */
  model: TaskModel;
  /** The cloned repository; the agent works there. */
  cwd: string;
}

// All assumptions about the claude CLI live here.
export function claudeArgs(settings: ClaudeSessionSettings, turn: SessionTurn): string[] {
  return [
    // The prompt is positional and must precede the variadic --mcp-config.
    '-p',
    turn.prompt,
    turn.isResume ? '--resume' : '--session-id',
    turn.sessionId,
    '--model',
    settings.model,
    '--mcp-config',
    settings.mcpConfigPath,
    '--strict-mcp-config',
    '--dangerously-skip-permissions',
    '--output-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    settings.systemPrompt,
  ];
}

export function mcpConfig(bridgePath: string, bridge: BridgeConfig): object {
  return {
    mcpServers: {
      factory: {
        command: process.execPath,
        args: [bridgePath],
        env: { FACTORY_CONTROL_PLANE_URL: bridge.controlPlaneUrl, FACTORY_TASK_TOKEN: bridge.taskToken },
      },
    },
  };
}

/** Runs each turn as one `claude -p` process; its output goes to the execution server's log. */
export function createClaudeSession(run: RunCommand, settings: ClaudeSessionSettings): AgentSession {
  return { runTurn: (turn, onActivity) => runTurn(run, settings, turn, onActivity) };
}

async function runTurn(
  run: RunCommand,
  settings: ClaudeSessionSettings,
  turn: SessionTurn,
  onActivity?: (activity: string) => void,
): Promise<TurnOutcome> {
  const onStdoutLine = onActivity && ((line: string) => {
    const activity = activityOfLine(line);
    if (activity !== undefined) onActivity(activity);
  });
  const options = { cwd: settings.cwd, teeOutput: true, ...(onStdoutLine && { onStdoutLine }) };
  const result = await run('claude', claudeArgs(settings, turn), options);
  const totalCostUsd = parseTotalCostUsd(result.stdout);
  const failure = result.code === 0 ? undefined : failureOf(result.code, sessionError(result.stdout, result.stderr));
  return {
    ...(failure !== undefined && { failure }),
    ...(totalCostUsd !== undefined && { totalCostUsd }),
  };
}

function failureOf(exitCode: number, error: string | undefined): string {
  return `claude session exited with code ${exitCode}${error ? `: ${error}` : ''}`;
}

// `total_cost_usd` is a running total over every turn of the session, and a turn
// prints one result event per background subagent completion: the last one counts.
export function parseTotalCostUsd(stdout: string): number | undefined {
  const cost = lastResultEvent(stdout)?.total_cost_usd;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

// The execution server's log is gone once the task fails, so the failure
// reason must carry the cause. stream-json ends with a `result` event that
// states it.
export function sessionError(stdout: string, stderr: string): string | undefined {
  for (const line of stdout.trim().split('\n').reverse()) {
    const event = parseEvent(line);
    if (event?.type === 'result' && typeof event.result === 'string' && event.result) return event.result;
  }
  return stderr.trim().split('\n').slice(-5).join('\n') || undefined;
}

function lastResultEvent(stdout: string): StreamEvent | undefined {
  return stdout
    .trim()
    .split('\n')
    .map(parseEvent)
    .findLast((event) => event?.type === 'result');
}

interface StreamEvent {
  type?: unknown;
  result?: unknown;
  total_cost_usd?: unknown;
}

function parseEvent(line: string): StreamEvent | undefined {
  try {
    return JSON.parse(line) as StreamEvent;
  } catch {
    // The captured tail may start mid-line.
    return undefined;
  }
}

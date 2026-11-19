import type { TaskModel, TokenUsage } from '@factory/core';
import type { AgentSession, SessionTurn, TurnOutcome, UsageLimitHit } from './agent-session.ts';
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
  // Watched on the stream rather than in the captured tail, which a long turn may have cut it from.
  let rateLimit: RateLimitState | undefined;
  const onStdoutLine = (line: string) => {
    rateLimit = rateLimitOfLine(line) ?? rateLimit;
    if (!onActivity) return;
    const activity = activityOfLine(line);
    if (activity !== undefined) onActivity(activity);
  };
  const result = await run('claude', claudeArgs(settings, turn), { cwd: settings.cwd, teeOutput: true, onStdoutLine });
  const totalCostUsd = parseTotalCostUsd(result.stdout);
  const totalTokens = parseTotalTokens(result.stdout);
  const isError = result.code !== 0 || lastResultEvent(result.stdout)?.is_error === true;
  const usageLimit = isError && rateLimit?.isRejected ? usageLimitOf(rateLimit) : undefined;
  const failure = result.code !== 0 || usageLimit ? failureOf(result.code, sessionError(result.stdout, result.stderr)) : undefined;
  return {
    ...(failure !== undefined && { failure }),
    ...(usageLimit !== undefined && { usageLimit }),
    ...(totalCostUsd !== undefined && { totalCostUsd }),
    ...(totalTokens !== undefined && { totalTokens }),
  };
}

/** What the latest `rate_limit_event` said: whether requests are refused, and when the limit resets. */
export interface RateLimitState {
  isRejected: boolean;
  resetsAt?: string;
}

/**
 * The CLI prints a `rate_limit_event` whenever the account's limit status
 * changes: `rate_limit_info.status` is `allowed`, `allowed_warning` or
 * `rejected`, and `resetsAt` is when the limit resets, in Unix seconds. A
 * turn that ends in an error after a `rejected` one hit the limit.
 */
export function rateLimitOfLine(line: string): RateLimitState | undefined {
  // Cheap test first: every line of the stream passes through here.
  if (!line.includes('"rate_limit_event"')) return undefined;
  const event = parseEvent(line);
  const info = event?.type === 'rate_limit_event' ? event.rate_limit_info : undefined;
  if (typeof info !== 'object' || info === null) return undefined;
  const status = Reflect.get(info, 'status');
  if (typeof status !== 'string') return undefined;
  const resetsAt = timestampOf(Reflect.get(info, 'resetsAt'));
  return { isRejected: status === 'rejected', ...(resetsAt !== undefined && { resetsAt }) };
}

// Unix seconds, up to the largest time a Date holds.
function timestampOf(seconds: unknown): string | undefined {
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds * 1000 > 8.64e15) return undefined;
  return new Date(seconds * 1000).toISOString();
}

const usageLimitOf = ({ resetsAt }: RateLimitState): UsageLimitHit => (resetsAt === undefined ? {} : { resetsAt });

function failureOf(exitCode: number, error: string | undefined): string {
  return `claude session exited with code ${exitCode}${error ? `: ${error}` : ''}`;
}

// `total_cost_usd` is a running total over every turn of the session, and a turn
// prints one result event per background subagent completion: the last one counts.
export function parseTotalCostUsd(stdout: string): number | undefined {
  const cost = lastResultEvent(stdout)?.total_cost_usd;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

// `modelUsage` holds running totals per model, like `total_cost_usd`. A malformed
// model entry is skipped: it loses that model's count, never the turn.
export function parseTotalTokens(stdout: string): TokenUsage | undefined {
  const modelUsage = lastResultEvent(stdout)?.modelUsage;
  if (typeof modelUsage !== 'object' || modelUsage === null || Array.isArray(modelUsage)) return undefined;
  const usages = Object.values(modelUsage).map(parseModelUsage).filter((usage) => usage !== undefined);
  if (usages.length === 0) return undefined;
  return {
    inputTokens: sum(usages.map((u) => u.inputTokens)),
    outputTokens: sum(usages.map((u) => u.outputTokens)),
    cacheReadTokens: sum(usages.map((u) => u.cacheReadTokens)),
    cacheCreationTokens: sum(usages.map((u) => u.cacheCreationTokens)),
  };
}

function parseModelUsage(entry: unknown): TokenUsage | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const inputTokens = countOf(Reflect.get(entry, 'inputTokens'));
  const outputTokens = countOf(Reflect.get(entry, 'outputTokens'));
  const cacheReadTokens = countOf(Reflect.get(entry, 'cacheReadInputTokens'));
  const cacheCreationTokens = countOf(Reflect.get(entry, 'cacheCreationInputTokens'));
  if (inputTokens === undefined || outputTokens === undefined || cacheReadTokens === undefined || cacheCreationTokens === undefined) {
    return undefined;
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
}

const countOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

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
  is_error?: unknown;
  rate_limit_info?: unknown;
  total_cost_usd?: unknown;
  modelUsage?: unknown;
}

function parseEvent(line: string): StreamEvent | undefined {
  try {
    return JSON.parse(line) as StreamEvent;
  } catch {
    // The captured tail may start mid-line.
    return undefined;
  }
}

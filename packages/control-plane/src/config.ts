import type { TaskAgent, TaskModel } from '@factory/core';

export interface Config {
  port: number;
  dbPath: string;
  image: string;
  /** Image of the reviewer that reviews task specifications and pull requests. */
  reviewerImage: string;
  reviewerModel: TaskModel;
  /** Execution servers that may be working at the same time. */
  maxRunning: number;
  gitUserName: string;
  gitUserEmail: string;
  /** Hours a failed task keeps its idle execution server for a follow-up. */
  followUpWindowHours: number;
  /** Hours a browser session may go unused before it ends. */
  sessionIdleHours: number;
  /** Days a browser session lasts at most, however active. */
  sessionMaxDays: number;
  /** Names of the Anthropic credentials that are set. */
  credentials: AnthropicCredential[];
  /** The one credential forwarded to each agent; an agent without one cannot run. */
  agentCredentials: Partial<Record<TaskAgent, AnthropicCredential>>;
}

/** An API key bills usage credits; an OAuth token from `claude setup-token` uses a Claude subscription. */
export type AnthropicCredential = 'ANTHROPIC_API_KEY' | 'CLAUDE_CODE_OAUTH_TOKEN';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

// The secrets are checked but deliberately not copied into Config: they are
// forwarded to execution servers by name, so their values never pass through
// our code.
const anthropicCredentials: readonly AnthropicCredential[] = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * The credentials each agent works with, preferred first; only the first one
 * set is forwarded. The claude CLI silently prefers the API key when both are
 * set, which would bill credits although a subscription token was meant.
 * Anthropic allows subscription sign-in for its own clients only.
 */
const usableCredentials: Record<TaskAgent, readonly AnthropicCredential[]> = {
  claude: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  opencode: ['ANTHROPIC_API_KEY'],
};

/** Why tasks of `agent` cannot run with these credentials, or undefined when they can. */
export function unavailableAgent(agentCredentials: Config['agentCredentials'], agent: TaskAgent): string | undefined {
  if (agentCredentials[agent] !== undefined) return undefined;
  return `agent ${agent} needs ${usableCredentials[agent].join(' or ')}, which is not set`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ['GITHUB_TOKEN', 'FACTORY_GIT_USER_NAME', 'FACTORY_GIT_USER_EMAIL'].filter((name) => !env[name]?.trim());
  const credentials = anthropicCredentials.filter((name) => env[name]?.trim());
  if (credentials.length === 0) missing.unshift(anthropicCredentials.join(' or '));
  if (missing.length > 0) throw new ConfigError(`missing environment variables: ${missing.join(', ')}`);
  const agentCredentials: Config['agentCredentials'] = {};
  for (const [agent, usable] of Object.entries(usableCredentials) as Array<[TaskAgent, readonly AnthropicCredential[]]>) {
    const credential = usable.find((name) => credentials.includes(name));
    if (credential) agentCredentials[agent] = credential;
  }

  const port = Number(env.FACTORY_PORT ?? '4700');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`FACTORY_PORT must be a port number, got "${env.FACTORY_PORT}"`);
  }
  const maxRunning = Number(env.FACTORY_MAX_RUNNING ?? '2');
  if (!Number.isInteger(maxRunning) || maxRunning < 1) {
    throw new ConfigError(`FACTORY_MAX_RUNNING must be a positive integer, got "${env.FACTORY_MAX_RUNNING}"`);
  }
  const followUpWindowHours = Number(env.FACTORY_FOLLOW_UP_WINDOW_HOURS?.trim() || '24');
  if (!(Number.isFinite(followUpWindowHours) && followUpWindowHours >= 0)) {
    throw new ConfigError(
      `FACTORY_FOLLOW_UP_WINDOW_HOURS must be a non-negative number, got "${env.FACTORY_FOLLOW_UP_WINDOW_HOURS}"`,
    );
  }
  const sessionIdleHours = positiveNumber(env, 'FACTORY_SESSION_IDLE_HOURS', 12);
  const sessionMaxDays = positiveNumber(env, 'FACTORY_SESSION_MAX_DAYS', 7);
  const reviewerModel = env.FACTORY_REVIEWER_MODEL?.trim() || 'sonnet';
  if (reviewerModel !== 'opus' && reviewerModel !== 'sonnet') {
    throw new ConfigError(`FACTORY_REVIEWER_MODEL must be opus or sonnet, got "${env.FACTORY_REVIEWER_MODEL}"`);
  }
  return {
    port,
    dbPath: env.FACTORY_DB ?? 'factory.db',
    image: env.FACTORY_IMAGE ?? 'factory-executor:latest',
    reviewerImage: env.FACTORY_REVIEWER_IMAGE ?? 'factory-reviewer:latest',
    reviewerModel,
    maxRunning,
    gitUserName: env.FACTORY_GIT_USER_NAME!,
    gitUserEmail: env.FACTORY_GIT_USER_EMAIL!,
    followUpWindowHours,
    sessionIdleHours,
    sessionMaxDays,
    credentials,
    agentCredentials,
  };
}

function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]?.trim() || fallback);
  if (!(Number.isFinite(value) && value > 0)) throw new ConfigError(`${name} must be a positive number, got "${env[name]}"`);
  return value;
}

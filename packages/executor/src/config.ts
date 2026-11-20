import type { TaskModel } from '@factory/core';

export interface BridgeConfig {
  controlPlaneUrl: string;
  taskToken: string;
}

export interface RunnerConfig extends BridgeConfig {
  taskId: string;
  repoUrl?: string;
  baseBranch?: string;
  model: TaskModel;
  gitUserName: string;
  gitUserEmail: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const bridgeVariables = ['FACTORY_CONTROL_PLANE_URL', 'FACTORY_TASK_TOKEN'] as const;

// The secrets are only checked: the agent and gh read them from the inherited
// environment, so their values never pass through our code.
const runnerVariables = [...bridgeVariables, 'FACTORY_TASK_ID', 'GIT_USER_NAME', 'GIT_USER_EMAIL', 'GITHUB_TOKEN'] as const;

/** Either one authenticates the agent: an API key, or a subscription token from `claude setup-token`. */
const anthropicCredentials = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

export function loadBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  assertPresent(env, bridgeVariables);
  return { controlPlaneUrl: env.FACTORY_CONTROL_PLANE_URL!, taskToken: env.FACTORY_TASK_TOKEN! };
}

export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const missing = missingVariables(env, runnerVariables);
  if (missingVariables(env, anthropicCredentials).length === anthropicCredentials.length) {
    missing.push(anthropicCredentials.join(' or '));
  }
  if (missing.length > 0) throw new ConfigError(`missing environment variables: ${missing.join(', ')}`);
  return {
    ...loadBridgeConfig(env),
    taskId: env.FACTORY_TASK_ID!,
    ...(env.FACTORY_REPO_URL?.trim() ? { repoUrl: env.FACTORY_REPO_URL } : {}),
    ...(env.FACTORY_BASE_BRANCH?.trim() ? { baseBranch: env.FACTORY_BASE_BRANCH } : {}),
    model: parseModel(env.FACTORY_MODEL),
    gitUserName: env.GIT_USER_NAME!,
    gitUserEmail: env.GIT_USER_EMAIL!,
  };
}

const models: readonly TaskModel[] = ['opus', 'sonnet'];

/** Unset or empty means `opus`, the default for tasks. */
function parseModel(value: string | undefined): TaskModel {
  const model = value?.trim() || 'opus';
  if (!models.includes(model as TaskModel)) {
    throw new ConfigError(`FACTORY_MODEL must be one of ${models.join(', ')}, got ${JSON.stringify(value)}`);
  }
  return model as TaskModel;
}

function missingVariables(env: NodeJS.ProcessEnv, names: readonly string[]): string[] {
  return names.filter((name) => !env[name]?.trim());
}

function assertPresent(env: NodeJS.ProcessEnv, names: readonly string[]): void {
  const missing = missingVariables(env, names);
  if (missing.length > 0) throw new ConfigError(`missing environment variables: ${missing.join(', ')}`);
}

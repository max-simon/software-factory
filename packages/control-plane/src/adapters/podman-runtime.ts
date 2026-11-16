import { randomBytes } from 'node:crypto';
import { agentConsolePort, doorbellPort, type AgentConsole, type ExecutionRuntime, type ExecutionSpec, type StartedExecution, type TaskAgent } from '@factory/core';
import { runCommand as defaultRunCommand, type RunCommand } from './run-command.ts';

export interface PodmanRuntimeOptions {
  image: string;
  gitUserName: string;
  gitUserEmail: string;
  /** Name of the Anthropic credential forwarded from podman's environment, per agent. */
  agentCredentials: Partial<Record<TaskAgent, string>>;
  runCommand?: RunCommand;
  fetchFn?: typeof fetch;
}

// A nudge is a single local request; a runner that does not answer in time is hung.
const nudgeTimeoutMs = 10_000;

/** Only opencode serves a web console. */
const hasConsole = (agent: TaskAgent): boolean => agent === 'opencode';

/** Marks the containers this runtime starts, so they can be listed. */
const taskLabel = 'factory.task';

export class PodmanRuntime implements ExecutionRuntime {
  readonly #options: PodmanRuntimeOptions;
  readonly #run: RunCommand;
  readonly #fetch: typeof fetch;

  constructor(options: PodmanRuntimeOptions) {
    this.#options = options;
    this.#run = options.runCommand ?? defaultRunCommand;
    this.#fetch = options.fetchFn ?? fetch;
  }

  async start(spec: ExecutionSpec): Promise<StartedExecution> {
    // Checked when the task was created; the configuration may have changed since.
    const credential = this.#options.agentCredentials[spec.agent];
    if (credential === undefined) throw new Error(`no Anthropic credential is set for agent ${spec.agent}`);
    const plain: Record<string, string | undefined> = {
      FACTORY_TASK_ID: spec.taskId,
      FACTORY_REPO_URL: spec.repoUrl,
      FACTORY_BASE_BRANCH: spec.baseBranch,
      FACTORY_MODEL: spec.model,
      FACTORY_CONTROL_PLANE_URL: spec.controlPlaneUrl,
      GIT_USER_NAME: this.#options.gitUserName,
      GIT_USER_EMAIL: this.#options.gitUserEmail,
      FACTORY_AGENT: spec.agent,
    };
    const plainArgs = Object.entries(plain).flatMap(([key, value]) => (value ? ['--env', `${key}=${value}`] : []));
    // Secrets are passed by name only: podman copies them from its own
    // environment, so their values never appear on a command line.
    const secrets: Record<string, string> = { FACTORY_TASK_TOKEN: spec.token };
    // The doorbell and opencode's web console are published on free ports of
    // the host's loopback only; the console's password is new for every container.
    const consolePassword = hasConsole(spec.agent) ? randomBytes(24).toString('base64url') : undefined;
    if (consolePassword) secrets.FACTORY_OPENCODE_PASSWORD = consolePassword;
    const secretArgs = [credential, 'GITHUB_TOKEN', ...Object.keys(secrets)].flatMap((key) => ['--env', key]);
    const publishArgs = [doorbellPort, ...(consolePassword ? [agentConsolePort] : [])].flatMap((port) => ['--publish', `127.0.0.1::${port}`]);
    // --replace: a control-plane crash between `run` and saving the container id
    // leaves an orphan whose token was never stored; it can never report.
    const name = `factory-task-${spec.taskId}`;
    const labelArgs = ['--label', `${taskLabel}=${spec.taskId}`];
    const args = ['run', '-d', '--replace', '--name', name, ...labelArgs, ...plainArgs, ...secretArgs, ...publishArgs, this.#options.image];
    try {
      const containerId = (await this.#podman(args, { ...process.env, ...secrets })).stdout.trim();
      if (!consolePassword) return { executionId: containerId };
      return { executionId: containerId, agentConsole: await this.#agentConsole(containerId, consolePassword) };
    } catch (error) {
      // `run` can fail after the container was created; the caller never
      // learns its id, so clean it up by name here.
      await this.#run('podman', ['rm', '-f', '--ignore', name]);
      throw error;
    }
  }

  async #agentConsole(containerId: string, password: string): Promise<AgentConsole> {
    return { url: await this.#loopbackUrl(containerId, agentConsolePort, 'the agent console'), password };
  }

  async #loopbackUrl(containerId: string, port: number, purpose: string): Promise<string> {
    const { stdout } = await this.#podman(['port', containerId, `${port}/tcp`]);
    const hostPort = /^127\.0\.0\.1:(\d+)$/m.exec(stdout)?.[1];
    if (!hostPort) throw new Error(`podman port gave no loopback port for ${purpose}: ${stdout.trim()}`);
    return `http://127.0.0.1:${hostPort}`;
  }

  // Idle containers keep running. One that stopped anyway (a runner that gave
  // up, a host reboot) is started instead: a starting runner asks for work by itself.
  async notify(executionId: string, agent: TaskAgent): Promise<{ agentConsoleUrl?: string }> {
    const { stdout } = await this.#podman(['inspect', '--format', '{{.State.Running}}', executionId]);
    if (stdout.trim() === 'true') {
      await this.#nudge(executionId);
      return {};
    }
    await this.#podman(['start', executionId]);
    return this.#movedConsole(executionId, agent);
  }

  async #nudge(containerId: string): Promise<void> {
    const url = `${await this.#loopbackUrl(containerId, doorbellPort, 'the doorbell')}/nudge`;
    const response = await this.#fetch(url, { method: 'POST', signal: AbortSignal.timeout(nudgeTimeoutMs) });
    if (!response.ok) throw new Error(`the doorbell answered ${response.status}`);
  }

  // Killed without the stop timeout: the runner runs as PID 1, which ignores SIGTERM.
  async restart(executionId: string, agent: TaskAgent): Promise<{ agentConsoleUrl?: string }> {
    await this.#podman(['restart', '--time', '0', executionId]);
    return this.#movedConsole(executionId, agent);
  }

  // A host port picked by podman need not survive a restart, so it is read again.
  async #movedConsole(containerId: string, agent: TaskAgent): Promise<{ agentConsoleUrl?: string }> {
    if (!hasConsole(agent)) return {};
    return { agentConsoleUrl: await this.#loopbackUrl(containerId, agentConsolePort, 'the agent console') };
  }

  // Removed containers are discarded, so they are killed without the stop
  // timeout: the runner runs as PID 1, which ignores SIGTERM.
  async remove(executionId: string): Promise<void> {
    await this.#podman(['rm', '-f', '--time', '0', '--ignore', executionId]);
  }

  async listExecutions(): Promise<string[]> {
    // --no-trunc: `run -d` returns the full id, which is what callers stored.
    const { stdout } = await this.#podman(['ps', '--all', '--no-trunc', '--filter', `label=${taskLabel}`, '--format', '{{.ID}}']);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async #podman(args: readonly string[], env?: NodeJS.ProcessEnv) {
    const result = await this.#run('podman', args, env ? { env } : {});
    if (result.code !== 0) {
      throw new Error(`podman ${args[0]} failed with exit code ${result.code}: ${result.stderr.trim()}`);
    }
    return result;
  }
}

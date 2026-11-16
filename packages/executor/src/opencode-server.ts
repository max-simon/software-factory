import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { BridgeConfig } from './config.ts';

export interface OpencodeConfigInput {
  agent: string;
  systemPrompt: string;
  bridgePath: string;
  bridge: BridgeConfig;
}

/**
 * The whole opencode config, passed in OPENCODE_CONFIG_CONTENT: the orchestrator
 * agent, the `factory` MCP bridge and no permission prompts.
 */
export function opencodeConfig(input: OpencodeConfigInput): object {
  return {
    update: 'disable',
    agents: {
      [input.agent]: {
        mode: 'primary',
        system: input.systemPrompt,
        // Nobody answers permission requests: an `ask` would stall the turn.
        permissions: [{ action: '*', resource: '*', effect: 'allow' }],
      },
    },
    mcp: {
      servers: {
        factory: {
          type: 'local',
          command: [process.execPath, input.bridgePath],
          environment: { FACTORY_CONTROL_PLANE_URL: input.bridge.controlPlaneUrl, FACTORY_TASK_TOKEN: input.bridge.taskToken },
          // Plain tool calls named `factory_<tool>` instead of generated JavaScript.
          codemode: false,
        },
      },
    },
  };
}

export interface OpencodeServer {
  url: string;
  password: string;
  stop(): void;
}

export interface StartOptions {
  config: object;
  port: number;
  /**
   * Set when engineers reach the web console through a published port: the
   * server then listens on every interface of the container with this password.
   * Unset, it listens on loopback only with a fresh password.
   */
  consolePassword?: string;
  /** How long to wait for the server to answer before giving up. */
  readyTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

/** Starts `opencode serve`; its output goes to the execution server's log. Resolves once the server answers. */
export async function startOpencodeServer(options: StartOptions): Promise<OpencodeServer> {
  const password = options.consolePassword ?? randomUUID();
  const hostname = options.consolePassword ? '0.0.0.0' : '127.0.0.1';
  const url = `http://127.0.0.1:${options.port}`;
  const child = spawn('opencode', ['serve', '--hostname', hostname, '--port', String(options.port)], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      OPENCODE_PASSWORD: password,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config),
      // The cloned repository must not replace the agent, its permissions or the MCP servers.
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    },
  });
  let exit: string | undefined;
  child.on('exit', (code, signal) => (exit = `opencode serve exited with ${signal ?? `code ${code}`}`));
  child.on('error', (error) => (exit = `opencode serve could not start: ${error.message}`));
  const stop = () => void child.kill();
  try {
    await waitUntilReady(url, password, options, () => exit);
  } catch (error) {
    stop();
    throw error;
  }
  return { url, password, stop };
}

async function waitUntilReady(url: string, password: string, options: StartOptions, exited: () => string | undefined) {
  const fetchFn = options.fetchFn ?? fetch;
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const deadline = Date.now() + (options.readyTimeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    const reason = exited();
    if (reason !== undefined) throw new Error(reason);
    try {
      if ((await fetchFn(`${url}/api/info`, { headers: { authorization } })).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`opencode serve did not answer on ${url} within ${options.readyTimeoutMs ?? 30_000} ms`);
}

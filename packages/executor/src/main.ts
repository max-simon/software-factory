import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { agentConsolePort, doorbellPort } from '@factory/core';
import { createAgentClient, type AgentClient } from './agent-client.ts';
import type { AgentSession } from './agent-session.ts';
import { createClaudeSession, mcpConfig } from './claude-session.ts';
import { ConfigError, loadRunnerConfig, type RunnerConfig } from './config.ts';
import { serveDoorbell } from './doorbell.ts';
import { createHeartbeat } from './heartbeat.ts';
import { createOpencodeApi } from './opencode-api.ts';
import { opencodeConfig, startOpencodeServer } from './opencode-server.ts';
import { createOpencodeSession } from './opencode-session.ts';
import { runCommand } from './run-command.ts';
import { runWorker } from './runner.ts';
import { createSessionStore } from './session-state.ts';

const heartbeatIntervalMs = 15_000;
// About the control plane's startup timeout: a runner that cannot reach it for
// longer is restarted anyway.
const workRequestRetry = { attempts: 20, delayMs: 15_000 };
const log = (message: string) => console.error(`[runner] ${message}`);
const bridgePath = fileURLToPath(new URL('./mcp-bridge.ts', import.meta.url));

interface Agent {
  session: AgentSession;
  newSessionId: () => string;
  stop: () => void;
}

async function main(): Promise<number> {
  const config = loadConfigOrExit();
  log(`task ${config.taskId} with ${config.agent} on ${config.model}`);
  const client = createAgentClient(config.controlPlaneUrl, config.taskToken);
  const workDir = join(homedir(), 'workspace');
  // Listening first, so a nudge right after a (re)start is not refused.
  const doorbell = await serveDoorbell(doorbellPort);
  const agent = await startAgentOrFail(config, client, workDir);
  if (agent === undefined) {
    doorbell.close();
    return 1;
  }
  try {
    return await runWorker({
      client,
      run: runCommand,
      log,
      repository: config,
      workDir,
      session: agent.session,
      // Outside the work directory, which a fresh start wipes.
      sessions: createSessionStore(join(homedir(), '.factory', 'session.json')),
      newSessionId: agent.newSessionId,
      heartbeat: createHeartbeat({ send: client.sendHeartbeat, intervalMs: heartbeatIntervalMs, log }),
      doorbell,
      now: Date.now,
      retry: { ...workRequestRetry, sleep: (ms) => sleep(ms) },
    });
  } finally {
    doorbell.close();
    agent.stop();
  }
}

/** A failure here happens before the runner can report one, so it is reported here. */
async function startAgentOrFail(config: RunnerConfig, client: AgentClient, workDir: string): Promise<Agent | undefined> {
  try {
    return await startAgent(config, workDir);
  } catch (error) {
    const reason = `could not start ${config.agent}: ${error instanceof Error ? error.message : String(error)}`;
    log(reason);
    await client.reportFailure(reason).catch((e: unknown) => log(`could not report failure: ${String(e)}`));
    return undefined;
  }
}

async function startAgent(config: RunnerConfig, workDir: string): Promise<Agent> {
  const systemPrompt = await readFile(new URL('./prompts/orchestrator.md', import.meta.url), 'utf8');
  if (config.agent === 'claude') {
    const session = createClaudeSession(runCommand, {
      mcpConfigPath: await writeMcpConfig(config),
      systemPrompt,
      model: config.model,
      cwd: workDir,
    });
    return { session, newSessionId: randomUUID, stop: () => {} };
  }
  const agentName = 'factory';
  const server = await startOpencodeServer({
    config: opencodeConfig({ agent: agentName, systemPrompt, bridgePath, bridge: config }),
    port: agentConsolePort,
    ...(config.opencodePassword && { consolePassword: config.opencodePassword }),
  });
  const session = createOpencodeSession(
    { api: createOpencodeApi(server.url, server.password), sleep: (ms) => sleep(ms), log },
    { agent: agentName, model: config.model, cwd: workDir },
  );
  // opencode session ids start with `ses`.
  return { session, newSessionId: () => `ses_${randomUUID().replaceAll('-', '')}`, stop: server.stop };
}

function loadConfigOrExit(): RunnerConfig {
  try {
    return loadRunnerConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    log(error.message);
    process.exit(1);
  }
}

// The file holds the task token, so only this user may read it.
async function writeMcpConfig(config: RunnerConfig): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'factory-')), 'mcp.json');
  await writeFile(path, JSON.stringify(mcpConfig(bridgePath, config)), { mode: 0o600 });
  return path;
}

// Exits explicitly: a runner that gave up must stop the execution server, so
// the runtime starts it afresh, and a lingering child process must not keep it running.
process.exit(await main());

import type { Work } from '@factory/core';
import type { AgentClient } from './agent-client.ts';
import type { AgentSession } from './agent-session.ts';
import type { Doorbell } from './doorbell.ts';
import type { HeartbeatSender } from './heartbeat.ts';
import { followUpPrompt, resumePrompt, taskPrompt } from './prompts.ts';
import type { RunCommand } from './run-command.ts';
import type { SessionState, SessionStore } from './session-state.ts';

export interface RepositorySetup {
  /** Unset: the agent works in an empty directory and opens no pull requests. */
  repoUrl?: string;
  baseBranch?: string;
  gitUserName: string;
  gitUserEmail: string;
}

export interface RunnerDeps {
  client: AgentClient;
  run: RunCommand;
  log: (message: string) => void;
  repository: RepositorySetup;
  /** Where the repository is cloned and the agent works. */
  workDir: string;
  session: AgentSession;
  sessions: SessionStore;
  /** A fresh id in the agent's format. */
  newSessionId: () => string;
  heartbeat: HeartbeatSender;
  /** Rung when work waits for the idle runner. */
  doorbell: Doorbell;
  /** Milliseconds clock that times each turn. */
  now: () => number;
  /** How often, and how far apart, to ask for work while the control plane cannot be reached. */
  retry: { attempts: number; delayMs: number; sleep: (ms: number) => Promise<void> };
}

/**
 * Asks the control plane for work and runs one agent turn per piece of work;
 * with none, waits idle for the doorbell and asks again. Returns the exit code
 * once the doorbell closes. The repository and the agent session stay on
 * disk, so a restarted runner resumes them. The runner never decides the
 * task's status after a turn: the control plane does, when the runner asks for
 * work again.
 */
export async function runWorker(deps: RunnerDeps): Promise<number> {
  let state = await deps.sessions.load();
  for (;;) {
    // A ring from before this request is answered by it.
    deps.doorbell.reset();
    let work: Work | undefined;
    try {
      work = await askForWork(deps);
    } catch (error) {
      // The control plane sees the silence and restarts this execution server.
      deps.log(`giving up asking for work: ${describe(error)}`);
      return 1;
    }
    if (work !== undefined) {
      state = await doWork(deps, work, state);
      continue;
    }
    deps.log('no work, waiting for the doorbell');
    if (!(await deps.doorbell.wait())) {
      deps.log('doorbell closed, stopping');
      return 0;
    }
  }
}

async function askForWork(deps: RunnerDeps): Promise<Work | undefined> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await deps.client.requestWork();
    } catch (error) {
      if (attempt >= deps.retry.attempts) throw error;
      deps.log(`asking for work failed, retrying: ${describe(error)}`);
      await deps.retry.sleep(deps.retry.delayMs);
    }
  }
}

/**
 * Accepts the work and runs one turn with it. Returns the session state after
 * the turn. A failure is reported; one that cannot be is left to the control
 * plane, which fails a task still in progress once the runner asks again.
 */
async function doWork(deps: RunnerDeps, work: Work, state: SessionState | undefined): Promise<SessionState | undefined> {
  try {
    await deps.client.acceptWork(work.followUps.map((f) => f.id));
  } catch (error) {
    // Not accepted, so the next request hands out the same work.
    deps.log(`could not accept work: ${describe(error)}`);
    return state;
  }
  deps.heartbeat.start(state ? 'working' : 'setting_up');
  try {
    const turn = state ? await resumeTurn(deps, work, state) : await freshTurn(deps, work);
    return await runTurn(deps, turn);
  } catch (error) {
    await fail(deps, describe(error));
    return state;
  } finally {
    deps.heartbeat.stop();
  }
}

interface PlannedTurn {
  prompt: string;
  sessionId: string;
  isResume: boolean;
  /** The session's cost total before the turn. */
  costUsd: number;
}

/** Without a session, the work starts over from the task; follow-ups sent meanwhile join it. */
async function freshTurn(deps: RunnerDeps, work: Work): Promise<PlannedTurn> {
  await setUpRepository(deps.run, deps.repository, deps.workDir);
  const [task, project] = await Promise.all([deps.client.getTask(), deps.client.getProject()]);
  const prompt = [taskPrompt(task, project), ...(work.followUps.length > 0 ? [followUpPrompt(work.followUps)] : [])];
  return { prompt: prompt.join('\n\n'), sessionId: deps.newSessionId(), isResume: false, costUsd: 0 };
}

async function resumeTurn(deps: RunnerDeps, work: Work, state: SessionState): Promise<PlannedTurn> {
  const task = await deps.client.getTask();
  const prompt = resumePrompt(task, new Set(work.inputIds), work.followUps);
  return { prompt, sessionId: state.sessionId, isResume: true, costUsd: state.costUsd };
}

/**
 * Runs the turn, reports its usage and keeps the session for the next turn. A
 * failed first turn may have left no session, so only a resumed one is kept.
 */
async function runTurn(deps: RunnerDeps, turn: PlannedTurn): Promise<SessionState | undefined> {
  const { heartbeat } = deps;
  heartbeat.setPhase('working');
  const started = deps.now();
  const { prompt, sessionId, isResume } = turn;
  const outcome = await deps.session.runTurn({ prompt, sessionId, isResume }, (activity) => heartbeat.setActivity(activity));
  await recordMetrics(deps, deps.now() - started, turn.costUsd, outcome.totalCostUsd);
  const next = { sessionId, costUsd: outcome.totalCostUsd ?? turn.costUsd };
  if (outcome.failure === undefined || isResume) await deps.sessions.save(next);
  if (outcome.failure !== undefined) {
    await fail(deps, outcome.failure);
    return isResume ? next : undefined;
  }
  return next;
}

/**
 * Reports one turn's duration and cost increase over the session's previous
 * total. A turn without a total reports no cost, and the next total catches up.
 * Metrics never fail the task, and a lost report is not resent.
 */
async function recordMetrics(deps: RunnerDeps, durationMs: number, baseline: number, total: number | undefined): Promise<void> {
  const costUsd = total === undefined ? 0 : Math.max(0, total - baseline);
  try {
    await deps.client.reportMetrics({ durationMs, costUsd });
  } catch (error) {
    deps.log(`could not report metrics: ${describe(error)}`);
  }
}

/** Starts from a clean directory: a fresh turn may follow one whose set-up or session failed. */
async function setUpRepository(run: RunCommand, repository: RepositorySetup, directory: string): Promise<void> {
  await mustRun(run, 'rm', ['-rf', directory]);
  if (!repository.repoUrl) return mustRun(run, 'mkdir', ['-p', directory]);
  await mustRun(run, 'gh', ['auth', 'setup-git']);
  await mustRun(run, 'git', ['config', '--global', 'user.name', repository.gitUserName]);
  await mustRun(run, 'git', ['config', '--global', 'user.email', repository.gitUserEmail]);
  await mustRun(run, 'git', ['clone', repository.repoUrl, directory]);
  if (repository.baseBranch) await mustRun(run, 'git', ['-C', directory, 'checkout', repository.baseBranch]);
}

async function mustRun(run: RunCommand, command: string, args: string[]): Promise<void> {
  const result = await run(command, args);
  if (result.code === 0) return;
  const detail = result.stderr.trim().slice(-500);
  throw new Error(`set-up failed: ${command} ${args[0]} exited with code ${result.code}: ${detail}`);
}

async function fail(deps: RunnerDeps, reason: string): Promise<void> {
  deps.log(`reporting failure: ${reason}`);
  try {
    await deps.client.reportFailure(reason);
  } catch (error) {
    deps.log(`could not report failure: ${describe(error)}`);
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

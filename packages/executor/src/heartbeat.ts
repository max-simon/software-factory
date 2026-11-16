import type { Heartbeat, HeartbeatPhase } from '@factory/core';

/** Calls `tick` every `ms` until the returned function is called. */
export type Schedule = (tick: () => void, ms: number) => () => void;

// Unref'd: a forgotten heartbeat must not keep a finished runner alive.
export const intervalSchedule: Schedule = (tick, ms) => {
  const timer = setInterval(tick, ms);
  timer.unref();
  return () => clearInterval(timer);
};

export interface HeartbeatDeps {
  send: (heartbeat: Omit<Heartbeat, 'at'>) => Promise<void>;
  intervalMs: number;
  log: (message: string) => void;
  schedule?: Schedule;
}

/** Tells the control plane, from the runner process, that the execution server works and on what. */
export interface HeartbeatSender {
  /** Sends right away, then every interval; does nothing while started. */
  start(phase: HeartbeatPhase): void;
  /** A new phase is sent right away and clears the activity. */
  setPhase(phase: HeartbeatPhase): void;
  /** Activity changes many times a second, so it only rides along with the next beat. */
  setActivity(activity: string): void;
  /** Ends the beats until the next start. */
  stop(): void;
}

export function createHeartbeat(deps: HeartbeatDeps): HeartbeatSender {
  const schedule = deps.schedule ?? intervalSchedule;
  let state: Omit<Heartbeat, 'at'> = { phase: 'setting_up' };
  let cancel: (() => void) | undefined;
  let inFlight = false;
  let isOutdated = false;

  // One request at a time, so a slow control plane neither piles up requests
  // nor receives an older state after a newer one. A beat due meanwhile is sent
  // once the running one ends, with the state at that time.
  const beat = (): void => {
    if (cancel === undefined) return;
    if (inFlight) {
      isOutdated = true;
      return;
    }
    inFlight = true;
    void sendSafely({ ...state }).finally(() => {
      inFlight = false;
      if (!isOutdated) return;
      isOutdated = false;
      beat();
    });
  };

  // A missed heartbeat only makes the status look stale; it must never fail the task.
  const sendSafely = async (heartbeat: Omit<Heartbeat, 'at'>): Promise<void> => {
    try {
      await deps.send(heartbeat);
    } catch (error) {
      deps.log(`heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return {
    start: (phase) => {
      if (cancel !== undefined) return;
      state = { phase };
      cancel = schedule(beat, deps.intervalMs);
      beat();
    },
    setPhase: (phase) => {
      if (phase === state.phase) return;
      state = { phase };
      beat();
    },
    setActivity: (activity) => {
      state = { ...state, activity };
    },
    stop: () => {
      cancel?.();
      cancel = undefined;
    },
  };
}

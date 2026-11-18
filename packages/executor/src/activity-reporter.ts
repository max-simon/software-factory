/** Runs `run` once after `ms`, unless the returned function is called first. */
export type Defer = (run: () => void, ms: number) => () => void;

// Unref'd: a pending report must not keep a finished runner alive.
const unrefTimeout: Defer = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

// A slow control plane must not grow a batch without bound; the oldest lines matter least.
const maxBatch = 200;

export interface ActivityReporterDeps {
  send: (entries: string[]) => Promise<void>;
  /** How long a line waits for others to join its batch. */
  delayMs: number;
  log: (message: string) => void;
  defer?: Defer;
}

/**
 * Sends every activity line of a turn, so the engineer can follow it live. A
 * heartbeat carries only the latest line; this keeps the ones in between,
 * batched, so the control plane gets one request per `delayMs` at most.
 */
export interface ActivityReporter {
  add(text: string): void;
  /** Sends what is still waiting, e.g. once the turn ended. Never throws. */
  flush(): Promise<void>;
}

export function createActivityReporter(deps: ActivityReporterDeps): ActivityReporter {
  const defer = deps.defer ?? unrefTimeout;
  let pending: string[] = [];
  let cancel: (() => void) | undefined;
  // Batches are chained, so they arrive in order and one at a time.
  let sending = Promise.resolve();

  const sendPending = (): Promise<void> => {
    cancel?.();
    cancel = undefined;
    sending = sending.then(async () => {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      try {
        await deps.send(batch);
      } catch (error) {
        // Lost lines only leave a gap in what the engineer sees; they must never fail the task.
        deps.log(`activity report failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return sending;
  };

  return {
    add: (text) => {
      pending.push(text);
      if (pending.length > maxBatch) pending.shift();
      cancel ??= defer(() => void sendPending(), deps.delayMs);
    },
    flush: sendPending,
  };
}

export interface PauseWatchOptions {
  /** Epoch milliseconds. */
  now?: () => number;
  /** A gap between two checks longer than this counts as a pause. */
  pauseMs?: number;
  log?: (message: string) => void;
}

/** Well above the one-second check interval, well below the heartbeat timeout. */
const defaultPauseMs = 10_000;

/**
 * Tells since when this process has run without a pause. A host that sleeps
 * (a closed laptop lid, a suspended VM) pauses the control plane and the
 * execution servers alike, so heartbeats due meanwhile were never sent and
 * their silence must not count. The caller checks about once a second; a
 * longer gap between two checks means the process did not run.
 */
export class PauseWatch {
  readonly #now: () => number;
  readonly #pauseMs: number;
  readonly #log: (message: string) => void;
  #lastCheckAt: number;
  #awakeSince: number;

  constructor(options: PauseWatchOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#pauseMs = options.pauseMs ?? defaultPauseMs;
    this.#log = options.log ?? ((message) => console.error(message));
    this.#lastCheckAt = this.#awakeSince = this.#now();
  }

  /**
   * Records that the process runs and returns since when it has run without a
   * pause: its start or the end of the latest pause. Checking right before
   * judging silence catches a pause the periodic check has not seen yet.
   */
  check(): number {
    const now = this.#now();
    const gap = now - this.#lastCheckAt;
    if (gap > this.#pauseMs) {
      this.#awakeSince = now;
      this.#log(`control plane was paused for ${Math.round(gap / 1000)} s; heartbeat silence counts from now`);
    }
    this.#lastCheckAt = now;
    return this.#awakeSince;
  }
}

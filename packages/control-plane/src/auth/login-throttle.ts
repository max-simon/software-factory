export interface LoginThrottleOptions {
  /** The failure in a row that first locks a key. */
  lockoutAfter?: number;
  /** The first lockout; each further failure doubles it. */
  baseLockoutMs?: number;
  maxLockoutMs?: number;
  /** Failures are forgotten after this long without one. */
  forgetAfterMs?: number;
  /** Milliseconds since the epoch. */
  now?: () => number;
}

interface Failures {
  count: number;
  lockedUntil: number;
  lastFailureAt: number;
}

// Bounds memory when many keys fail once; only forgotten entries are dropped.
const pruneAbove = 10_000;

/**
 * In-memory exponential backoff for logins, per key: a login is refused while
 * any of the keys the caller passes is locked. The `lockoutAfter`th failure in a row locks the key for
 * `baseLockoutMs`, each further one for twice as long, up to `maxLockoutMs`.
 * A success resets the keys, and so does `forgetAfterMs` without a failure.
 * State is lost on restart, which only shortens lockouts.
 */
export class LoginThrottle {
  readonly #lockoutAfter: number;
  readonly #baseLockoutMs: number;
  readonly #maxLockoutMs: number;
  readonly #forgetAfterMs: number;
  readonly #now: () => number;
  readonly #failures = new Map<string, Failures>();

  constructor(options: LoginThrottleOptions = {}) {
    this.#lockoutAfter = options.lockoutAfter ?? 5;
    this.#baseLockoutMs = options.baseLockoutMs ?? 30_000;
    this.#maxLockoutMs = options.maxLockoutMs ?? 15 * 60_000;
    this.#forgetAfterMs = options.forgetAfterMs ?? 24 * 3_600_000;
    this.#now = options.now ?? Date.now;
  }

  /** Milliseconds until a login with these keys may be tried again, or 0 when it may now. */
  retryAfterMs(keys: readonly string[]): number {
    const now = this.#now();
    return Math.max(0, ...keys.map((key) => (this.#failures.get(key)?.lockedUntil ?? 0) - now));
  }

  recordFailure(keys: readonly string[]): void {
    const now = this.#now();
    if (this.#failures.size > pruneAbove) this.#prune(now);
    for (const key of keys) {
      const entry = this.#failures.get(key) ?? { count: 0, lockedUntil: 0, lastFailureAt: now };
      if (this.#isForgotten(entry, now)) entry.count = 0;
      entry.count += 1;
      entry.lastFailureAt = now;
      const over = entry.count - this.#lockoutAfter;
      if (over >= 0) entry.lockedUntil = now + Math.min(this.#maxLockoutMs, this.#baseLockoutMs * 2 ** over);
      this.#failures.set(key, entry);
    }
  }

  recordSuccess(keys: readonly string[]): void {
    for (const key of keys) this.#failures.delete(key);
  }

  #isForgotten(entry: Failures, now: number): boolean {
    return entry.lockedUntil <= now && now - entry.lastFailureAt >= this.#forgetAfterMs;
  }

  #prune(now: number): void {
    for (const [key, entry] of this.#failures) {
      if (this.#isForgotten(entry, now)) this.#failures.delete(key);
    }
  }
}

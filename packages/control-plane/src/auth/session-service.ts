import { createHash, randomBytes } from 'node:crypto';
import type { Principal, SessionStore, UserRepository } from '@factory/core';

export interface SessionServiceDeps {
  sessions: SessionStore;
  users: UserRepository;
  /** A session not used for this long ends. */
  idleTimeoutMs: number;
  /** A session ends this long after sign-in, however active. */
  maxLifetimeMs: number;
  /** Milliseconds since the epoch. */
  now?: () => number;
}

const tokenBytes = 32;
// A busy UI polls every few seconds; recording each request would write as often.
const touchIntervalMs = 60_000;

export const hashSessionToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * Factory-issued sessions, however the user signed in: every login route,
 * the local password one or an IdP's, ends in `createSession`.
 */
export class SessionService {
  readonly #sessions: SessionStore;
  readonly #users: UserRepository;
  readonly #idleTimeoutMs: number;
  readonly #maxLifetimeMs: number;
  readonly #now: () => number;

  constructor(deps: SessionServiceDeps) {
    this.#sessions = deps.sessions;
    this.#users = deps.users;
    this.#idleTimeoutMs = deps.idleTimeoutMs;
    this.#maxLifetimeMs = deps.maxLifetimeMs;
    this.#now = deps.now ?? Date.now;
  }

  get maxLifetimeMs(): number {
    return this.#maxLifetimeMs;
  }

  /** Starts a session for an authenticated user and returns its token; also prunes ended sessions. */
  createSession(userId: string): { token: string; expiresAt: string } {
    const now = this.#now();
    this.#sessions.deleteExpired(iso(now), iso(now - this.#idleTimeoutMs));
    const token = randomBytes(tokenBytes).toString('base64url');
    const expiresAt = iso(now + this.#maxLifetimeMs);
    this.#sessions.insert({ idHash: hashSessionToken(token), userId, createdAt: iso(now), lastSeenAt: iso(now), expiresAt });
    return { token, expiresAt };
  }

  /**
   * The principal of a live session of an active user, or undefined. Using a
   * session keeps it from going idle; an ended one is deleted on the way.
   */
  resolve(token: string | undefined): Principal | undefined {
    if (!token) return undefined;
    const idHash = hashSessionToken(token);
    const session = this.#sessions.get(idHash);
    if (session === undefined) return undefined;
    const now = this.#now();
    const lastSeen = Date.parse(session.lastSeenAt);
    if (now >= Date.parse(session.expiresAt) || now >= lastSeen + this.#idleTimeoutMs) {
      this.#sessions.delete(idHash);
      return undefined;
    }
    const user = this.#users.get(session.userId);
    if (user === undefined || user.disabledAt !== undefined) {
      this.#sessions.deleteForUser(session.userId);
      return undefined;
    }
    if (now - lastSeen >= touchIntervalMs) this.#sessions.touch(idHash, iso(now));
    return { userId: session.userId, via: 'session' };
  }

  /** Ends every session of the user except the one of `token`, e.g. after the user changed its password. */
  endOtherSessions(userId: string, token: string): void {
    this.#sessions.deleteForUserExcept(userId, hashSessionToken(token));
  }

  /** Ends the session; harmless for an unknown token. */
  endSession(token: string): void {
    this.#sessions.delete(hashSessionToken(token));
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();

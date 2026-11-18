import type { IncomingHttpHeaders } from 'node:http';
import { createUser, type Principal } from '@factory/core';
import { SqliteSessionRepository } from './adapters/sqlite-session-repository.ts';
import { SqliteUserRepository } from './adapters/sqlite-user-repository.ts';
import { SessionService } from './auth/session-service.ts';
import { readSessionToken, sessionCookieName } from './http/session-cookie.ts';
import type { ItemPrefix } from './task-store.ts';

/** Readable, predictable item ids for tests: `q1`, `q2`, `d1`, … counted per prefix across all tasks. */
export function sequentialItemIds(): (prefix: ItemPrefix) => string {
  const counts = new Map<ItemPrefix, number>();
  return (prefix) => {
    const count = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, count);
    return `${prefix}${count}`;
  };
}

export interface TestAuth {
  /** For `createServer`: resolves the session cookie. */
  authenticate: (headers: IncomingHttpHeaders) => Principal | undefined;
  /** A `Cookie` header with a session of the active user `ada`. */
  cookie: string;
}

/** In-memory users and sessions for servers under test, with `ada` signed in. */
export function testAuth(): TestAuth {
  const users = new SqliteUserRepository(':memory:');
  users.insert(createUser({ username: 'ada' }, { id: 'u1', now: '2026-11-12T10:00:00.000Z' }));
  const sessions = new SessionService({
    sessions: new SqliteSessionRepository(':memory:'),
    users,
    idleTimeoutMs: 12 * 3_600_000,
    maxLifetimeMs: 7 * 86_400_000,
  });
  return {
    authenticate: (headers) => sessions.resolve(readSessionToken(headers)),
    cookie: `${sessionCookieName}=${sessions.createSession('u1').token}`,
  };
}

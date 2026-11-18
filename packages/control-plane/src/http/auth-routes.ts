import {
  normalizeUsername,
  renameUser,
  type Authenticator,
  type PasswordHasher,
  type Principal,
  type UserRepository,
} from '@factory/core';
import type { LocalPasswordStore } from '../auth/local-password-authenticator.ts';
import type { LoginThrottle } from '../auth/login-throttle.ts';
import { parsePassword } from '../auth/passwords.ts';
import type { SessionService } from '../auth/session-service.ts';
import type { Response, Route } from './server.ts';
import { clearedSessionCookie, readSessionToken, sessionCookie } from './session-cookie.ts';
import { requireSession } from './token-routes.ts';
import { parseDisplayNameChange, parsePasswordChange, ValidationError } from './validation.ts';

export interface AuthRoutesDeps {
  authenticator: Authenticator;
  sessions: SessionService;
  users: UserRepository;
  throttle: LoginThrottle;
  /** Where `POST /auth/password` stores the new password's hash. */
  passwords: LocalPasswordStore;
  hasher: PasswordHasher;
  /** Milliseconds since the epoch. */
  now?: () => number;
}

// One message for an unknown username and a wrong password, so a login does not tell which usernames exist.
const loginFailedMessage = 'wrong username or password';
const throttledMessage = 'too many failed logins, try again later';

function parseLogin(body: unknown): { username: string; password: string } {
  const { username, password } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new ValidationError('login needs a username and a password');
  }
  return { username, password };
}

const throttled = (retryAfterMs: number): Response => ({
  status: 429,
  headers: { 'retry-after': String(Math.ceil(retryAfterMs / 1000)) },
  body: { error: { code: 'too_many_attempts', message: throttledMessage } },
});

/**
 * Login with username and password, logout, the signed-in user's own account
 * and the list of users. An IdP adapter adds its own login route that ends in
 * `sessions.createSession`.
 */
export function authRoutes({ authenticator, sessions, users, throttle, passwords, hasher, now = Date.now }: AuthRoutesDeps): Route[] {
  const me = (principal: Principal | undefined): Response => {
    const user = users.get(principal!.userId)!;
    return { status: 200, body: { id: user.id, username: user.username, displayName: user.displayName } };
  };

  return [
    {
      method: 'POST',
      path: '/auth/login',
      public: true,
      handle: async ({ body, clientAddress, secure }): Promise<Response> => {
        const { username, password } = parseLogin(body);
        const keys = [`user:${normalizeUsername(username)}`, `client:${clientAddress}`];
        const retryAfterMs = throttle.retryAfterMs(keys);
        if (retryAfterMs > 0) return throttled(retryAfterMs);
        const userId = await authenticator.authenticate({ kind: 'password', username, password });
        if (userId === undefined) {
          throttle.recordFailure(keys);
          return { status: 401, body: { error: { code: 'login_failed', message: loginFailedMessage } } };
        }
        throttle.recordSuccess(keys);
        const { token } = sessions.createSession(userId);
        return {
          ...me({ userId, via: 'session' }),
          headers: { 'set-cookie': sessionCookie(token, sessions.maxLifetimeMs, secure) },
        };
      },
    },
    {
      method: 'POST',
      path: '/auth/logout',
      handle: ({ headers, principal, secure }) => {
        // A token has no session to end; revoke it with DELETE /auth/tokens/:id.
        const forbidden = requireSession(principal);
        if (forbidden) return forbidden;
        sessions.endSession(readSessionToken(headers)!);
        return { status: 204, headers: { 'set-cookie': clearedSessionCookie(secure) } };
      },
    },
    { method: 'GET', path: '/auth/me', handle: ({ principal }) => me(principal) },
    {
      method: 'PATCH',
      path: '/auth/me',
      handle: ({ principal, body }) => {
        const forbidden = requireSession(principal);
        if (forbidden) return forbidden;
        const renamed = renameUser(users.get(principal!.userId)!, parseDisplayNameChange(body));
        users.update({ ...renamed, updatedAt: new Date(now()).toISOString() });
        return me(principal);
      },
    },
    {
      method: 'POST',
      path: '/auth/password',
      handle: async ({ principal, body, headers, clientAddress }): Promise<Response> => {
        const forbidden = requireSession(principal);
        if (forbidden) return forbidden;
        const { currentPassword, newPassword } = parsePasswordChange(body);
        const user = users.get(principal!.userId)!;
        // A stolen session must not guess the password faster than a login could.
        const keys = [`user:${user.username}`, `client:${clientAddress}`];
        const retryAfterMs = throttle.retryAfterMs(keys);
        if (retryAfterMs > 0) return throttled(retryAfterMs);
        const verified = await authenticator.authenticate({ kind: 'password', username: user.username, password: currentPassword });
        if (verified !== user.id) {
          throttle.recordFailure(keys);
          // 400, not 401: the session is fine, and a 401 would send the web UI to its login.
          return { status: 400, body: { error: { code: 'wrong_password', message: 'the current password is wrong' } } };
        }
        throttle.recordSuccess(keys);
        passwords.setPasswordHash(user.id, await hasher.hash(parsePassword(newPassword)));
        // Whoever else signed in with the old password is signed out; this browser stays signed in.
        sessions.endOtherSessions(user.id, readSessionToken(headers)!);
        return { status: 204 };
      },
    },
    {
      method: 'GET',
      path: '/users',
      handle: () => ({
        status: 200,
        body: users.list().map((user) => ({
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          disabled: user.disabledAt !== undefined,
        })),
      }),
    },
  ];
}

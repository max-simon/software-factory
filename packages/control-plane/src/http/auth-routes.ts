import { normalizeUsername, type Authenticator, type Principal, type UserRepository } from '@factory/core';
import type { LoginThrottle } from '../auth/login-throttle.ts';
import type { SessionService } from '../auth/session-service.ts';
import type { UserAccountService } from '../user-account-service.ts';
import { requireSession } from './authenticate.ts';
import type { Response, Route } from './server.ts';
import { clearedSessionCookie, readSessionToken, sessionCookie } from './session-cookie.ts';
import { parseDisplayNameChange, parseLogin, parsePasswordChange } from './validation.ts';

export interface AuthRoutesDeps {
  authenticator: Authenticator;
  sessions: SessionService;
  accounts: Pick<UserAccountService, 'rename' | 'changePassword'>;
  users: UserRepository;
  /** Throttles failed logins per username. */
  throttle: LoginThrottle;
  /**
   * Throttles failed logins per client address, with a far higher limit: on
   * loopback every client shares one address, so this only caps password
   * spraying across usernames instead of letting one person's typos lock
   * everyone out.
   */
  clientThrottle: LoginThrottle;
}

// One message for an unknown username and a wrong password, so a login does not tell which usernames exist.
const loginFailedMessage = 'wrong username or password';
const throttledMessage = 'too many failed logins, try again later';

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
export function authRoutes({
  authenticator,
  sessions,
  accounts,
  users,
  throttle,
  clientThrottle,
}: AuthRoutesDeps): Route[] {
  /** The throttle state of one attempt to prove `username`'s password from `clientAddress`. */
  const attempt = (username: string, clientAddress: string) => {
    const userKeys = [`user:${username}`];
    const clientKeys = [`client:${clientAddress}`];
    return {
      retryAfterMs: () => Math.max(throttle.retryAfterMs(userKeys), clientThrottle.retryAfterMs(clientKeys)),
      recordFailure: () => {
        throttle.recordFailure(userKeys);
        clientThrottle.recordFailure(clientKeys);
      },
      recordSuccess: () => {
        throttle.recordSuccess(userKeys);
        clientThrottle.recordSuccess(clientKeys);
      },
    };
  };

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
        const throttling = attempt(normalizeUsername(username), clientAddress);
        const retryAfterMs = throttling.retryAfterMs();
        if (retryAfterMs > 0) return throttled(retryAfterMs);
        const userId = await authenticator.authenticate({ kind: 'password', username, password });
        if (userId === undefined) {
          throttling.recordFailure();
          return { status: 401, body: { error: { code: 'login_failed', message: loginFailedMessage } } };
        }
        throttling.recordSuccess();
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
        accounts.rename(principal!.userId, parseDisplayNameChange(body));
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
        const throttling = attempt(user.username, clientAddress);
        const retryAfterMs = throttling.retryAfterMs();
        if (retryAfterMs > 0) return throttled(retryAfterMs);
        const isChanged = await accounts.changePassword(user.id, currentPassword, newPassword, readSessionToken(headers)!);
        if (!isChanged) {
          throttling.recordFailure();
          // 400, not 401: the session is fine, and a 401 would send the web UI to its login.
          return { status: 400, body: { error: { code: 'wrong_password', message: 'the current password is wrong' } } };
        }
        throttling.recordSuccess();
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

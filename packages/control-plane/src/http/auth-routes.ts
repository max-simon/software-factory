import { normalizeUsername, type Authenticator, type Principal, type UserRepository } from '@factory/core';
import type { LoginThrottle } from '../auth/login-throttle.ts';
import type { SessionService } from '../auth/session-service.ts';
import type { Response, Route } from './server.ts';
import { clearedSessionCookie, readSessionToken, sessionCookie } from './session-cookie.ts';
import { ValidationError } from './validation.ts';

export interface AuthRoutesDeps {
  authenticator: Authenticator;
  sessions: SessionService;
  users: UserRepository;
  throttle: LoginThrottle;
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

/**
 * Login with username and password, logout and the signed-in user. An IdP
 * adapter adds its own login route that ends in `sessions.createSession`.
 */
export function authRoutes({ authenticator, sessions, users, throttle }: AuthRoutesDeps): Route[] {
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
        if (retryAfterMs > 0) {
          return {
            status: 429,
            headers: { 'retry-after': String(Math.ceil(retryAfterMs / 1000)) },
            body: { error: { code: 'too_many_attempts', message: throttledMessage } },
          };
        }
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
      handle: ({ headers, secure }) => {
        sessions.endSession(readSessionToken(headers)!);
        return { status: 204, headers: { 'set-cookie': clearedSessionCookie(secure) } };
      },
    },
    { method: 'GET', path: '/auth/me', handle: ({ principal }) => me(principal) },
  ];
}

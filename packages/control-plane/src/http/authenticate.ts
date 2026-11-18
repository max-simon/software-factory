import type { IncomingHttpHeaders } from 'node:http';
import type { Principal } from '@factory/core';
import type { AccessTokenService } from '../auth/access-token-service.ts';
import type { SessionService } from '../auth/session-service.ts';
import type { Response } from './server.ts';
import { readSessionToken } from './session-cookie.ts';

/** The token of an `Authorization: Bearer <token>` header; undefined for any other scheme or none. */
export function readBearerToken(headers: IncomingHttpHeaders): string | undefined {
  const match = /^Bearer +(\S+) *$/i.exec(headers.authorization ?? '');
  return match?.[1];
}

/**
 * Resolves a request's principal: from its personal access token when it has
 * an `Authorization` header, from its session cookie otherwise. An invalid
 * `Authorization` header resolves to nothing, even next to a valid cookie, so
 * a client with a revoked token finds out instead of acting through a cookie.
 */
export function authenticateRequest(
  sessions: Pick<SessionService, 'resolve'>,
  tokens: Pick<AccessTokenService, 'resolve'>,
): (headers: IncomingHttpHeaders) => Principal | undefined {
  return (headers) =>
    headers.authorization !== undefined ? tokens.resolve(readBearerToken(headers)) : sessions.resolve(readSessionToken(headers));
}

/**
 * 403 unless the caller signed in with a session: a token must not mint
 * further tokens or outlive its own revocation through another one.
 */
export function requireSession(principal: Principal | undefined): Response | undefined {
  if (principal?.via === 'session') return undefined;
  return {
    status: 403,
    body: { error: { code: 'session_required', message: 'this needs a signed-in session; access tokens cannot use it' } },
  };
}

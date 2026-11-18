import type { AccessToken, Principal } from '@factory/core';
import type { AccessTokenService } from '../auth/access-token-service.ts';
import type { Response, Route } from './server.ts';
import { parseNewAccessToken } from './validation.ts';

/** What the API shows of a token: never its hash, nor the token after creation. */
const toView = ({ id, name, createdAt, lastUsedAt, expiresAt }: AccessToken) => ({
  id,
  name,
  createdAt,
  ...(lastUsedAt !== undefined && { lastUsedAt }),
  ...(expiresAt !== undefined && { expiresAt }),
});

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

/** A signed-in user lists, creates and revokes its own personal access tokens. */
export function tokenRoutes(tokens: AccessTokenService): Route[] {
  return [
    {
      method: 'GET',
      path: '/auth/tokens',
      handle: ({ principal }) => requireSession(principal) ?? { status: 200, body: tokens.list(principal!.userId).map(toView) },
    },
    {
      method: 'POST',
      path: '/auth/tokens',
      handle: ({ principal, body }) => {
        const forbidden = requireSession(principal);
        if (forbidden) return forbidden;
        const { token, ...metadata } = tokens.issue(principal!.userId, parseNewAccessToken(body));
        return { status: 201, body: { ...toView(metadata), token } };
      },
    },
    {
      method: 'DELETE',
      path: '/auth/tokens/:id',
      handle: ({ principal, params }) => {
        const forbidden = requireSession(principal);
        if (forbidden) return forbidden;
        if (!tokens.revoke(principal!.userId, params.id!)) {
          return { status: 404, body: { error: { code: 'not_found', message: `no token ${params.id}` } } };
        }
        return { status: 204 };
      },
    },
  ];
}

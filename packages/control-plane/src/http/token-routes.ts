import type { AccessToken } from '@factory/core';
import type { AccessTokenService } from '../auth/access-token-service.ts';
import { requireSession } from './authenticate.ts';
import type { Route } from './server.ts';
import { parseNewAccessToken } from './validation.ts';

/** What the API shows of a token: never its hash, nor the token after creation. */
const toView = ({ id, name, createdAt, lastUsedAt, expiresAt }: AccessToken) => ({
  id,
  name,
  createdAt,
  ...(lastUsedAt !== undefined && { lastUsedAt }),
  ...(expiresAt !== undefined && { expiresAt }),
});

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

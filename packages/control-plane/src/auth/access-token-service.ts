import { createHash, randomBytes } from 'node:crypto';
import {
  accessTokenPrefix,
  assertActiveUser,
  parseAccessTokenExpiry,
  parseAccessTokenName,
  type AccessToken,
  type AccessTokenRepository,
  type NewAccessToken,
  type Principal,
  type UserRepository,
} from '@factory/core';

export interface AccessTokenServiceDeps {
  tokens: AccessTokenRepository;
  users: UserRepository;
  /** Milliseconds since the epoch. */
  now?: () => number;
  newId?: () => string;
}

const tokenBytes = 32;
const day = 86_400_000;
// An MCP client calls the API on every tool call; recording each call would write as often.
const touchIntervalMs = 60_000;

export const hashAccessToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * Personal access tokens: for MCP clients and scripts, which send them as
 * `Authorization: Bearer fct_…` and act as the user that created them.
 */
export class AccessTokenService {
  readonly #tokens: AccessTokenRepository;
  readonly #users: UserRepository;
  readonly #now: () => number;
  readonly #newId: () => string;

  constructor(deps: AccessTokenServiceDeps) {
    this.#tokens = deps.tokens;
    this.#users = deps.users;
    this.#now = deps.now ?? Date.now;
    this.#newId = deps.newId ?? (() => randomBytes(6).toString('hex'));
  }

  /**
   * Creates a token for an active user. The returned `token` is the only copy:
   * only its hash is stored. Throws `DomainError`s for an invalid name or expiry.
   */
  issue(userId: string, request: NewAccessToken): AccessToken & { token: string } {
    assertActiveUser(this.#users.get(userId), userId);
    const name = parseAccessTokenName(request.name);
    const days = request.expiresInDays === undefined ? undefined : parseAccessTokenExpiry(request.expiresInDays);
    const now = this.#now();
    const token = accessTokenPrefix + randomBytes(tokenBytes).toString('base64url');
    const metadata: AccessToken = {
      id: this.#newId(),
      userId,
      name,
      createdAt: iso(now),
      ...(days !== undefined && { expiresAt: iso(now + days * day) }),
    };
    this.#tokens.insert(metadata, hashAccessToken(token));
    return { ...metadata, token };
  }

  /** The user's own tokens, expired ones included, oldest first. */
  list(userId: string): AccessToken[] {
    return this.#tokens.listForUser(userId);
  }

  /** Deletes one of the user's own tokens; false when the user has no token with that id. */
  revoke(userId: string, id: string): boolean {
    return this.#tokens.delete(userId, id);
  }

  /** Deletes every token of the user, e.g. after its password changed. */
  revokeAll(userId: string): void {
    this.#tokens.deleteForUser(userId);
  }

  /** The principal of an unexpired token of an active user, or undefined. */
  resolve(token: string | undefined): Principal | undefined {
    if (!token?.startsWith(accessTokenPrefix)) return undefined;
    const found = this.#tokens.getByHash(hashAccessToken(token));
    if (found === undefined) return undefined;
    const now = this.#now();
    if (found.expiresAt !== undefined && now >= Date.parse(found.expiresAt)) return undefined;
    const user = this.#users.get(found.userId);
    if (user === undefined || user.disabledAt !== undefined) return undefined;
    if (found.lastUsedAt === undefined || now - Date.parse(found.lastUsedAt) >= touchIntervalMs) {
      this.#tokens.touch(found.id, iso(now));
    }
    return { userId: found.userId, via: 'token' };
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();

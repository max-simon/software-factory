import { DomainError } from './errors.ts';

/**
 * A personal access token's metadata: lets MCP clients and scripts, which
 * cannot keep a browser cookie, act as the user that created it. The token
 * itself is shown once on creation; only its hash is stored.
 */
export interface AccessToken {
  id: string;
  userId: string;
  /** What the user calls it, e.g. the machine or client it is for. */
  name: string;
  createdAt: string;
  /** Updated on use, at most about once a minute. */
  lastUsedAt?: string;
  /** No expiry when absent. */
  expiresAt?: string;
}

/** What a user asks for when creating a token. */
export interface NewAccessToken {
  name: string;
  expiresInDays?: number;
}

/** Every token starts with it, so it is easy to recognise, e.g. by secret scanners. */
export const accessTokenPrefix = 'fct_';
export const accessTokenNameMaxLength = 100;
export const accessTokenMaxExpiryDays = 3650;

/** The trimmed name, or a `DomainError` `invalid_token_name`. */
export function parseAccessTokenName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > accessTokenNameMaxLength) {
    throw new DomainError('invalid_token_name', `token name must be 1 to ${accessTokenNameMaxLength} characters long`);
  }
  return trimmed;
}

/** A whole number of days from 1 to `accessTokenMaxExpiryDays`, or a `DomainError` `invalid_token_expiry`. */
export function parseAccessTokenExpiry(days: unknown): number {
  if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > accessTokenMaxExpiryDays) {
    throw new DomainError('invalid_token_expiry', `expiresInDays must be a whole number from 1 to ${accessTokenMaxExpiryDays}`);
  }
  return days as number;
}

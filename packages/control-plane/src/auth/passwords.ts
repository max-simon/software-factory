import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { DomainError, type PasswordHasher } from '@factory/core';

export const passwordMinLength = 12;
export const passwordMaxLength = 256;

/** The password unchanged, or a `DomainError` `invalid_password` when its length is out of bounds. */
export function parsePassword(password: string): string {
  if (password.length < passwordMinLength || password.length > passwordMaxLength) {
    throw new DomainError(
      'invalid_password',
      `password must be ${passwordMinLength} to ${passwordMaxLength} characters long`,
    );
  }
  return password;
}

export interface ScryptParams {
  /** CPU and memory cost, a power of two. */
  N: number;
  r: number;
  p: number;
}

export const defaultScryptParams: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };

const saltBytes = 16;
const keyBytes = 64;
// Bounds for parameters read back from a stored hash, so a corrupt row cannot
// make verification allocate gigabytes or spin for minutes.
const maxN = 2 ** 20;
const maxR = 32;
const maxP = 16;
const minKeyBytes = 16;
const maxKeyBytes = 128;
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;

function derive(password: string, salt: Buffer, keylen: number, { N, r, p }: ScryptParams): Promise<Buffer> {
  // scrypt needs about 128 * N * r bytes; twice that leaves room for its bookkeeping.
  const options: ScryptOptions = { N, r, p, maxmem: 128 * N * r * 2 };
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

const isPowerOfTwo = (n: number): boolean => Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;

function parseInteger(text: string): number | undefined {
  return /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : undefined;
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

function parseHash(encoded: string): ParsedHash | undefined {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return undefined;
  const [, nText, rText, pText, saltText, keyText] = parts as [string, string, string, string, string, string];
  const N = parseInteger(nText);
  const r = parseInteger(rText);
  const p = parseInteger(pText);
  if (N === undefined || r === undefined || p === undefined) return undefined;
  if (!isPowerOfTwo(N) || N > maxN || r > maxR || p > maxP) return undefined;
  if (!base64Pattern.test(saltText) || !base64Pattern.test(keyText)) return undefined;
  const salt = Buffer.from(saltText, 'base64');
  const key = Buffer.from(keyText, 'base64');
  if (salt.length === 0 || key.length < minKeyBytes || key.length > maxKeyBytes) return undefined;
  return { params: { N, r, p }, salt, key };
}

/**
 * Hashes with scrypt as `scrypt$N$r$p$<salt>$<key>` (base64). Verification
 * reads the parameters from the hash, so raising them later keeps old hashes
 * valid.
 */
export class ScryptPasswordHasher implements PasswordHasher {
  readonly #params: ScryptParams;

  constructor(params: Partial<ScryptParams> = {}) {
    this.#params = { ...defaultScryptParams, ...params };
    if (!isPowerOfTwo(this.#params.N)) throw new Error('scrypt N must be a power of two greater than 1');
  }

  async hash(password: string): Promise<string> {
    const { N, r, p } = this.#params;
    const salt = randomBytes(saltBytes);
    const key = await derive(password, salt, keyBytes, this.#params);
    return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
  }

  async verify(password: string, hash: string): Promise<boolean> {
    const parsed = parseHash(hash);
    if (parsed === undefined) return false;
    let key: Buffer;
    try {
      key = await derive(password, parsed.salt, parsed.key.length, parsed.params);
    } catch {
      return false;
    }
    return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
  }
}

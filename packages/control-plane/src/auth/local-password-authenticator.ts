import { randomBytes } from 'node:crypto';
import {
  localProvider,
  normalizeUsername,
  type Authenticator,
  type Credentials,
  type LocalPasswordStore,
  type PasswordHasher,
  type UserRepository,
} from '@factory/core';
import { passwordMaxLength } from './passwords.ts';

export interface LocalPasswordAuthenticatorDeps {
  users: UserRepository;
  passwords: LocalPasswordStore;
  hasher: PasswordHasher;
}

/** The factory's own username and password login, the `local` identity provider. */
export class LocalPasswordAuthenticator implements Authenticator {
  readonly #users: UserRepository;
  readonly #passwords: LocalPasswordStore;
  readonly #hasher: PasswordHasher;
  #dummyHash: Promise<string> | undefined;

  constructor(deps: LocalPasswordAuthenticatorDeps) {
    this.#users = deps.users;
    this.#passwords = deps.passwords;
    this.#hasher = deps.hasher;
  }

  async authenticate(credentials: Credentials): Promise<string | undefined> {
    if (credentials.kind !== 'password') return undefined;
    const { username, password } = credentials;
    // Longer passwords can never have been set; refuse them before hashing.
    if (password.length > passwordMaxLength) return undefined;
    const user = this.#users.getByUsername(normalizeUsername(username));
    const identity = user && this.#users.findIdentity(localProvider, user.id);
    const hash = identity && this.#passwords.getPasswordHash(identity.userId);
    if (user === undefined || user.disabledAt !== undefined || hash === undefined) {
      // Hash anyway so the response time does not tell which usernames exist.
      await this.#hasher.verify(password, await this.#getDummyHash());
      return undefined;
    }
    return (await this.#hasher.verify(password, hash)) ? user.id : undefined;
  }

  #getDummyHash(): Promise<string> {
    this.#dummyHash ??= this.#hasher.hash(randomBytes(32).toString('base64')).catch((error: unknown) => {
      this.#dummyHash = undefined;
      throw error;
    });
    return this.#dummyHash;
  }
}

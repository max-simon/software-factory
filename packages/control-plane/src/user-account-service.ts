import { randomBytes } from 'node:crypto';
import {
  assertActiveUser,
  assertUsernameAvailable,
  createUser,
  disableUser,
  DomainError,
  isActiveUser,
  localProvider,
  parseUsername,
  renameUser,
  type AccessTokenRepository,
  type LocalPasswordStore,
  type NewUser,
  type PasswordHasher,
  type SessionStore,
  type User,
  type UserRepository,
} from '@factory/core';
import { parsePassword } from './auth/passwords.ts';
import { hashSessionToken } from './auth/session-service.ts';

export interface UserAccountServiceDeps {
  users: UserRepository;
  passwords: LocalPasswordStore;
  hasher: PasswordHasher;
  sessions: Pick<SessionStore, 'deleteForUser' | 'deleteForUserExcept'>;
  tokens: Pick<AccessTokenRepository, 'deleteForUser'>;
  now?: () => string;
  newId?: () => string;
}

/**
 * Users and their local passwords, for the account routes and the user CLI.
 * Takes user ids; callers resolve usernames themselves.
 */
export class UserAccountService {
  readonly #users: UserRepository;
  readonly #passwords: LocalPasswordStore;
  readonly #hasher: PasswordHasher;
  readonly #sessions: UserAccountServiceDeps['sessions'];
  readonly #tokens: UserAccountServiceDeps['tokens'];
  readonly #now: () => string;
  readonly #newId: () => string;

  constructor(deps: UserAccountServiceDeps) {
    this.#users = deps.users;
    this.#passwords = deps.passwords;
    this.#hasher = deps.hasher;
    this.#sessions = deps.sessions;
    this.#tokens = deps.tokens;
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#newId = deps.newId ?? (() => randomBytes(5).toString('hex'));
  }

  /** Creates a user that signs in with `password`; a rejected username or password leaves no user behind. */
  async create(input: NewUser, password: string): Promise<User> {
    const username = parseUsername(input.username);
    assertUsernameAvailable(username, this.#users.getByUsername(username));
    const user = createUser({ ...input, username }, { id: this.#newId(), now: this.#now() });
    const hash = await this.#hasher.hash(parsePassword(password));
    this.#users.insert(user);
    this.#users.linkIdentity({ provider: localProvider, subject: user.id, userId: user.id });
    this.#passwords.setPasswordHash(user.id, hash);
    return user;
  }

  rename(userId: string, displayName: string): User {
    const renamed = { ...renameUser(this.#activeUser(userId), displayName), updatedAt: this.#now() };
    this.#users.update(renamed);
    return renamed;
  }

  /** Sets the password of an active user, as an operator does; sessions and tokens stay. */
  async setPassword(userId: string, password: string): Promise<void> {
    this.#activeUser(userId);
    this.#passwords.setPasswordHash(userId, await this.#hasher.hash(parsePassword(password)));
  }

  /**
   * The user's own change, which needs its current password: whoever else
   * knew the old one is signed out, except the session of `keepSessionToken`,
   * and loses every token minted with it. False when `currentPassword` is wrong.
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string, keepSessionToken: string): Promise<boolean> {
    this.#activeUser(userId);
    // Checked first, so a password that cannot be set costs no verification.
    const password = parsePassword(newPassword);
    const current = this.#passwords.getPasswordHash(userId);
    if (current === undefined || !(await this.#hasher.verify(currentPassword, current))) return false;
    this.#passwords.setPasswordHash(userId, await this.#hasher.hash(password));
    this.#sessions.deleteForUserExcept(userId, hashSessionToken(keepSessionToken));
    this.#tokens.deleteForUser(userId);
    return true;
  }

  /**
   * Disables the user for good and ends its sessions and tokens, also when it
   * was disabled already; whether it was active until now.
   */
  disable(userId: string): boolean {
    const user = this.#users.get(userId);
    if (user === undefined) throw new DomainError('unknown_user', `user ${userId} does not exist`);
    this.#sessions.deleteForUser(userId);
    this.#tokens.deleteForUser(userId);
    if (!isActiveUser(user)) return false;
    const now = this.#now();
    this.#users.update({ ...disableUser(user, now), updatedAt: now });
    return true;
  }

  #activeUser(userId: string): User {
    return assertActiveUser(this.#users.get(userId), userId);
  }
}

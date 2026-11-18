import { DatabaseSync } from 'node:sqlite';
import { DomainError, localProvider, normalizeUsername, type ExternalIdentity, type User, type UserRepository } from '@factory/core';
import type { LocalPasswordStore } from '../auth/local-password-authenticator.ts';

// The local password hash lives on the user's `local` identity row, so a user
// signing in through an IdP only never has one.
const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    disabled_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users (username);
  CREATE TABLE IF NOT EXISTS external_identities (
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users (id),
    password_hash TEXT,
    PRIMARY KEY (provider, subject)
  );
  CREATE INDEX IF NOT EXISTS external_identities_user_id ON external_identities (user_id);
`;

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
}

interface IdentityRow {
  provider: string;
  subject: string;
  user_id: string;
}

const userColumns = 'id, username, display_name, created_at, updated_at, disabled_at';

function toUser(row: UserRow): User {
  const user: User = {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.disabled_at !== null) user.disabledAt = row.disabled_at;
  return user;
}

const isUsernameConflict = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed: users\.username/.test(error.message);

/** Shares the database file with the task repository through its own connection. */
export class SqliteUserRepository implements UserRepository, LocalPasswordStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    // The user CLI writes while the control plane may be running.
    this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.#db.exec(schema);
  }

  insert(user: User): void {
    this.#writeUser(user, () =>
      this.#db
        .prepare(`INSERT INTO users (${userColumns}) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(user.id, user.username, user.displayName, user.createdAt, user.updatedAt, user.disabledAt ?? null),
    );
  }

  update(user: User): void {
    const result = this.#writeUser(user, () =>
      this.#db
        .prepare('UPDATE users SET username = ?, display_name = ?, updated_at = ?, disabled_at = ? WHERE id = ?')
        .run(user.username, user.displayName, user.updatedAt, user.disabledAt ?? null, user.id),
    );
    if (result.changes === 0) throw new Error(`cannot update user ${user.id}: it does not exist`);
  }

  get(id: string): User | undefined {
    const row = this.#db.prepare(`SELECT ${userColumns} FROM users WHERE id = ?`).get(id) as UserRow | undefined;
    return row ? toUser(row) : undefined;
  }

  getByUsername(username: string): User | undefined {
    const row = this.#db
      .prepare(`SELECT ${userColumns} FROM users WHERE username = ?`)
      .get(normalizeUsername(username)) as UserRow | undefined;
    return row ? toUser(row) : undefined;
  }

  list(): User[] {
    const rows = this.#db
      .prepare(`SELECT ${userColumns} FROM users ORDER BY created_at, id`)
      .all() as unknown as UserRow[];
    return rows.map(toUser);
  }

  linkIdentity(identity: ExternalIdentity): void {
    this.#db
      .prepare('INSERT INTO external_identities (provider, subject, user_id) VALUES (?, ?, ?)')
      .run(identity.provider, identity.subject, identity.userId);
  }

  findIdentity(provider: string, subject: string): ExternalIdentity | undefined {
    const row = this.#db
      .prepare('SELECT provider, subject, user_id FROM external_identities WHERE provider = ? AND subject = ?')
      .get(provider, subject) as IdentityRow | undefined;
    return row ? { provider: row.provider, subject: row.subject, userId: row.user_id } : undefined;
  }

  setPasswordHash(userId: string, hash: string): void {
    this.#db
      .prepare(
        `INSERT INTO external_identities (provider, subject, user_id, password_hash) VALUES (?, ?, ?, ?)
         ON CONFLICT (provider, subject) DO UPDATE SET password_hash = excluded.password_hash`,
      )
      .run(localProvider, userId, userId, hash);
  }

  getPasswordHash(userId: string): string | undefined {
    const row = this.#db
      .prepare('SELECT password_hash FROM external_identities WHERE provider = ? AND subject = ?')
      .get(localProvider, userId) as { password_hash: string | null } | undefined;
    return row?.password_hash ?? undefined;
  }

  close(): void {
    this.#db.close();
  }

  #writeUser<T>(user: User, write: () => T): T {
    try {
      return write();
    } catch (error) {
      if (isUsernameConflict(error)) {
        throw new DomainError('duplicate_username', `username ${user.username} is taken`);
      }
      throw error;
    }
  }
}

import { DatabaseSync } from 'node:sqlite';
import type { AccessToken, AccessTokenRepository } from '@factory/core';

// Only the token's SHA-256 is stored, so a copy of the database cannot be used to act as a user.
// No foreign key to users: the user CLI and tests may open the users table through another connection.
const schema = `
  CREATE TABLE IF NOT EXISTS access_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    expires_at TEXT
  );
  CREATE INDEX IF NOT EXISTS access_tokens_user_id ON access_tokens (user_id);
`;

const columns = 'id, user_id, name, created_at, last_used_at, expires_at';

interface AccessTokenRow {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

const toAccessToken = (row: AccessTokenRow): AccessToken => ({
  id: row.id,
  userId: row.user_id,
  name: row.name,
  createdAt: row.created_at,
  ...(row.last_used_at !== null && { lastUsedAt: row.last_used_at }),
  ...(row.expires_at !== null && { expiresAt: row.expires_at }),
});

/** Shares the database file with the other repositories through its own connection. */
export class SqliteAccessTokenRepository implements AccessTokenRepository {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    // The user CLI creates and deletes tokens while the control plane may be running.
    this.#db.exec('PRAGMA busy_timeout = 5000;');
    this.#db.exec(schema);
  }

  insert(token: AccessToken, tokenHash: string): void {
    this.#db
      .prepare(
        'INSERT INTO access_tokens (id, user_id, name, token_hash, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(token.id, token.userId, token.name, tokenHash, token.createdAt, token.lastUsedAt ?? null, token.expiresAt ?? null);
  }

  getByHash(tokenHash: string): AccessToken | undefined {
    const row = this.#db.prepare(`SELECT ${columns} FROM access_tokens WHERE token_hash = ?`).get(tokenHash) as
      | AccessTokenRow
      | undefined;
    return row ? toAccessToken(row) : undefined;
  }

  listForUser(userId: string): AccessToken[] {
    const rows = this.#db
      .prepare(`SELECT ${columns} FROM access_tokens WHERE user_id = ? ORDER BY created_at, rowid`)
      .all(userId) as unknown as AccessTokenRow[];
    return rows.map(toAccessToken);
  }

  touch(id: string, lastUsedAt: string): void {
    this.#db.prepare('UPDATE access_tokens SET last_used_at = ? WHERE id = ?').run(lastUsedAt, id);
  }

  delete(userId: string, id: string): boolean {
    return this.#db.prepare('DELETE FROM access_tokens WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }

  deleteForUser(userId: string): void {
    this.#db.prepare('DELETE FROM access_tokens WHERE user_id = ?').run(userId);
  }

  close(): void {
    this.#db.close();
  }
}

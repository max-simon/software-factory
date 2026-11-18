import { DatabaseSync } from 'node:sqlite';
import type { Session, SessionStore } from '../auth/session-service.ts';

// Only the token's SHA-256 is stored, so a copy of the database cannot be used to sign in.
// No foreign key to users: the user CLI and tests may open the users table through another connection.
const schema = `
  CREATE TABLE IF NOT EXISTS sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions (user_id);
`;

interface SessionRow {
  id_hash: string;
  user_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

const toSession = (row: SessionRow): Session => ({
  idHash: row.id_hash,
  userId: row.user_id,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  expiresAt: row.expires_at,
});

/** Shares the database file with the other repositories through its own connection. */
export class SqliteSessionRepository implements SessionStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    // The user CLI deletes sessions while the control plane may be running.
    this.#db.exec('PRAGMA busy_timeout = 5000;');
    this.#db.exec(schema);
  }

  insert(session: Session): void {
    this.#db
      .prepare('INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(session.idHash, session.userId, session.createdAt, session.lastSeenAt, session.expiresAt);
  }

  get(idHash: string): Session | undefined {
    const row = this.#db
      .prepare('SELECT id_hash, user_id, created_at, last_seen_at, expires_at FROM sessions WHERE id_hash = ?')
      .get(idHash) as SessionRow | undefined;
    return row ? toSession(row) : undefined;
  }

  touch(idHash: string, lastSeenAt: string): void {
    this.#db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(lastSeenAt, idHash);
  }

  delete(idHash: string): void {
    this.#db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
  }

  deleteForUser(userId: string): void {
    this.#db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  deleteExpired(now: string, idleSince: string): void {
    this.#db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?').run(now, idleSince);
  }

  close(): void {
    this.#db.close();
  }
}

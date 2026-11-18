import { DatabaseSync } from 'node:sqlite';
import type { ChangeActor, Project, ProjectChange, ProjectRepository } from '@factory/core';

const schema = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    data TEXT NOT NULL
  );
  -- Append-only, like task_changes; values are JSON, absent for a creation.
  -- Projects stored before the changelog existed have entries from their next change on.
  CREATE TABLE IF NOT EXISTS project_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    user_id TEXT,
    field TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT
  );
  CREATE INDEX IF NOT EXISTS project_changes_project ON project_changes (project_id, id);
`;

interface Row {
  data: string;
}

const toProject = (row: Row): Project => JSON.parse(row.data) as Project;

/** Shares the database file with the task repository through its own connection. */
export class SqliteProjectRepository implements ProjectRepository {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(schema);
  }

  insert(project: Project, changes: readonly ProjectChange[] = []): void {
    this.#transaction(() => {
      this.#db
        .prepare('INSERT INTO projects (id, created_at, data) VALUES (?, ?, ?)')
        .run(project.id, project.createdAt, JSON.stringify(project));
      this.#appendChanges(project.id, changes);
    });
  }

  get(id: string): Project | undefined {
    const row = this.#db.prepare('SELECT data FROM projects WHERE id = ?').get(id) as Row | undefined;
    return row ? toProject(row) : undefined;
  }

  list(): Project[] {
    const rows = this.#db.prepare('SELECT data FROM projects ORDER BY created_at, id').all() as unknown as Row[];
    return rows.map(toProject);
  }

  save(project: Project, changes: readonly ProjectChange[] = []): void {
    this.#transaction(() => {
      const result = this.#db.prepare('UPDATE projects SET data = ? WHERE id = ?').run(JSON.stringify(project), project.id);
      if (result.changes === 0) throw new Error(`cannot save project ${project.id}: it does not exist`);
      this.#appendChanges(project.id, changes);
    });
  }

  listChanges(id: string): ProjectChange[] {
    const rows = this.#db
      .prepare('SELECT at, actor, user_id, field, from_value, to_value FROM project_changes WHERE project_id = ? ORDER BY id')
      .all(id) as unknown as ChangeRow[];
    return rows.map(toChange);
  }

  close(): void {
    this.#db.close();
  }

  #appendChanges(id: string, changes: readonly ProjectChange[]): void {
    const append = this.#db.prepare(
      'INSERT INTO project_changes (project_id, at, actor, user_id, field, from_value, to_value) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const change of changes) {
      const values = 'from' in change ? [JSON.stringify(change.from), JSON.stringify(change.to)] : [null, null];
      append.run(id, change.at, change.actor, change.userId ?? null, change.field, ...values);
    }
  }

  #transaction(write: () => void): void {
    this.#db.exec('BEGIN');
    try {
      write();
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
}

interface ChangeRow {
  at: string;
  actor: ChangeActor;
  user_id: string | null;
  field: ProjectChange['field'];
  from_value: string | null;
  to_value: string | null;
}

// The writer pairs each field with values of its type, so the cast only restores what it stored.
const toChange = ({ at, actor, user_id, field, from_value, to_value }: ChangeRow): ProjectChange => {
  const meta = { at, actor, ...(user_id !== null && { userId: user_id }) };
  return (
    from_value === null || to_value === null
      ? { ...meta, field }
      : { ...meta, field, from: JSON.parse(from_value), to: JSON.parse(to_value) }
  ) as ProjectChange;
};

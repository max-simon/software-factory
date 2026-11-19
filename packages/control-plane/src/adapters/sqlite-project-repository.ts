import { DatabaseSync } from 'node:sqlite';
import type { Project, ProjectRepository } from '@factory/core';

// Databases created while projects kept a changelog still hold its table; nothing reads it any more.
const schema = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    data TEXT NOT NULL
  );
  DROP TABLE IF EXISTS project_changes;
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

  insert(project: Project): void {
    this.#db
      .prepare('INSERT INTO projects (id, created_at, data) VALUES (?, ?, ?)')
      .run(project.id, project.createdAt, JSON.stringify(project));
  }

  get(id: string): Project | undefined {
    const row = this.#db.prepare('SELECT data FROM projects WHERE id = ?').get(id) as Row | undefined;
    return row ? toProject(row) : undefined;
  }

  list(): Project[] {
    const rows = this.#db.prepare('SELECT data FROM projects ORDER BY created_at, id').all() as unknown as Row[];
    return rows.map(toProject);
  }

  save(project: Project): void {
    const result = this.#db.prepare('UPDATE projects SET data = ? WHERE id = ?').run(JSON.stringify(project), project.id);
    if (result.changes === 0) throw new Error(`cannot save project ${project.id}: it does not exist`);
  }

  close(): void {
    this.#db.close();
  }
}

import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '@factory/core';
import type {
  ChangeActor,
  Decision,
  Execution,
  Heartbeat,
  HeartbeatPhase,
  PullRequest,
  PullRequestStatus,
  Task,
  TaskChange,
  TaskRepository,
  TaskStatus,
  Worker,
} from '@factory/core';

// Status, token hash, execution id and external URL are duplicated into columns
// because the dispatcher, the agent API and the issue sync query by them; `data` stays the source of truth.
// Rank is read from `data` directly: boards are small enough to sort without an index.
const schema = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    token_hash TEXT UNIQUE,
    execution_id TEXT,
    external_url TEXT,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status);
  -- Every running task beats every few seconds, so its last heartbeat lives
  -- apart from the task data: a beat writes this small row, not the whole task.
  CREATE TABLE IF NOT EXISTS heartbeats (
    task_id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    phase TEXT NOT NULL,
    activity TEXT
  );
  -- Append-only; values are JSON, absent for a creation. Tasks stored before
  -- the changelog existed have entries from their next change on. user_id
  -- is set for changes by a user, except those stored before users existed.
  CREATE TABLE IF NOT EXISTS task_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    user_id TEXT,
    field TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT
  );
  CREATE INDEX IF NOT EXISTS task_changes_task ON task_changes (task_id, id);
`;

const selectTasks = 'SELECT t.data, h.at, h.phase, h.activity FROM tasks t LEFT JOIN heartbeats h ON h.task_id = t.id';

interface Row {
  data: string;
  at: string | null;
  phase: HeartbeatPhase | null;
  activity: string | null;
}

export class SqliteTaskRepository implements TaskRepository {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    // WAL with NORMAL sync appends a commit to the log without an fsync, so the
    // frequent small writes block the event loop only briefly. A power loss may
    // drop the last commits but never corrupts the file. WAL is stored in the
    // file, so it covers the project repository's connection too.
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.#db.exec(schema);
    this.#addChangeUserIds();
    this.#addExternalUrls();
    this.#rankUnrankedTasks();
    this.#dropAssignees();
    this.#dropAgents();
  }

  insert(task: Task, changes: readonly TaskChange[] = []): void {
    this.#transaction(() => {
      this.#writeTask(task, () =>
        this.#db
          .prepare(
            'INSERT INTO tasks (id, created_at, status, token_hash, execution_id, external_url, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(task.id, task.createdAt, task.status, ...executionColumns(task), externalUrl(task), toData(task)),
      );
      this.#writeHeartbeat(task.id, task.execution?.lastHeartbeat);
      this.#appendChanges(task.id, changes);
    });
  }

  get(id: string): Task | undefined {
    return this.#one(`${selectTasks} WHERE t.id = ?`, id);
  }

  list(statuses?: readonly TaskStatus[]): Task[] {
    if (statuses?.length === 0) return [];
    const where = statuses ? `WHERE t.status IN (${statuses.map(() => '?').join(', ')})` : '';
    const rows = this.#db
      .prepare(`${selectTasks} ${where} ORDER BY json_extract(t.data, '$.rank'), t.created_at, t.id`)
      .all(...(statuses ?? [])) as unknown as Row[];
    return rows.map(toTask);
  }

  save(task: Task, changes: readonly TaskChange[] = []): void {
    this.#transaction(() => {
      const result = this.#writeTask(task, () =>
        this.#db
          .prepare('UPDATE tasks SET status = ?, token_hash = ?, execution_id = ?, external_url = ?, data = ? WHERE id = ?')
          .run(task.status, ...executionColumns(task), externalUrl(task), toData(task), task.id),
      );
      if (result.changes === 0) throw new Error(`cannot save task ${task.id}: it does not exist`);
      this.#writeHeartbeat(task.id, task.execution?.lastHeartbeat);
      this.#appendChanges(task.id, changes);
    });
  }

  listChanges(id: string): TaskChange[] {
    const rows = this.#db
      .prepare('SELECT at, actor, user_id, field, from_value, to_value FROM task_changes WHERE task_id = ? ORDER BY id')
      .all(id) as unknown as ChangeRow[];
    return rows.map(toChange);
  }

  saveHeartbeat(id: string, heartbeat: Heartbeat): void {
    this.#writeHeartbeat(id, heartbeat);
  }

  delete(id: string): void {
    this.#transaction(() => {
      this.#db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      this.#db.prepare('DELETE FROM task_changes WHERE task_id = ?').run(id);
      this.#writeHeartbeat(id, undefined);
    });
  }

  findByTokenHash(tokenHash: string): Task | undefined {
    return this.#one(`${selectTasks} WHERE t.token_hash = ?`, tokenHash);
  }

  findByExternalUrl(url: string): Task | undefined {
    return this.#one(`${selectTasks} WHERE t.external_url = ?`, url);
  }

  close(): void {
    this.#db.close();
  }

  /** Databases created before changes recorded their user lack the column; their rows read without one. */
  #addChangeUserIds(): void {
    const columns = this.#db.prepare('PRAGMA table_info(task_changes)').all() as unknown as Array<{ name: string }>;
    if (columns.some((column) => column.name === 'user_id')) return;
    this.#db.exec('ALTER TABLE task_changes ADD COLUMN user_id TEXT');
  }

  /**
   * Databases created before managed tasks existed lack the column; their
   * tasks are all ordinary. The index goes here, not in the schema, because it
   * needs the column, and SQLite cannot add a column with a UNIQUE constraint.
   */
  #addExternalUrls(): void {
    const columns = this.#db.prepare('PRAGMA table_info(tasks)').all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'external_url')) {
      this.#db.exec('ALTER TABLE tasks ADD COLUMN external_url TEXT');
    }
    this.#db.exec('CREATE UNIQUE INDEX IF NOT EXISTS tasks_external_url ON tasks (external_url)');
  }

  #writeTask<T>(task: Task, write: () => T): T {
    try {
      return write();
    } catch (error) {
      if (isExternalUrlConflict(error)) {
        throw new DomainError('duplicate_external_link', `another task already links ${task.external?.url}`);
      }
      throw error;
    }
  }

  /** Tasks stored before ranks existed go below the ranked ones, oldest first. */
  #rankUnrankedTasks(): void {
    const unranked = this.#db
      .prepare("SELECT id FROM tasks WHERE json_extract(data, '$.rank') IS NULL ORDER BY created_at, id")
      .all() as unknown as Array<{ id: string }>;
    if (unranked.length === 0) return;
    const { next } = this.#db
      .prepare("SELECT COALESCE(MAX(json_extract(data, '$.rank')) + 1, 0) AS next FROM tasks")
      .get() as { next: number };
    const update = this.#db.prepare("UPDATE tasks SET data = json_set(data, '$.rank', ?) WHERE id = ?");
    this.#db.exec('BEGIN');
    unranked.forEach(({ id }, i) => update.run(next + i, id));
    this.#db.exec('COMMIT');
  }

  /**
   * Tasks stored while tasks had assignees keep them in `data`, and their
   * changelog keeps the assignee changes, a field `TaskChange` no longer has; both go.
   */
  #dropAssignees(): void {
    this.#transaction(() => {
      this.#db.exec("UPDATE tasks SET data = json_remove(data, '$.assignees') WHERE json_type(data, '$.assignees') IS NOT NULL");
      this.#db.exec("DELETE FROM task_changes WHERE field = 'assignees'");
    });
  }

  /** Tasks stored while an agent was chosen per task name it, and opencode tasks kept the address and password of its console. */
  #dropAgents(): void {
    this.#db.exec(
      "UPDATE tasks SET data = json_remove(data, '$.agent', '$.agentConsoleUrl', '$.agentConsolePassword', '$.execution.console') " +
        "WHERE json_type(data, '$.agent') IS NOT NULL OR json_type(data, '$.agentConsoleUrl') IS NOT NULL " +
        "OR json_type(data, '$.agentConsolePassword') IS NOT NULL OR json_type(data, '$.execution.console') IS NOT NULL",
    );
  }

  #appendChanges(id: string, changes: readonly TaskChange[]): void {
    const append = this.#db.prepare(
      'INSERT INTO task_changes (task_id, at, actor, user_id, field, from_value, to_value) VALUES (?, ?, ?, ?, ?, ?, ?)',
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

  /** No heartbeat deletes the row: a restarted task starts without one. */
  #writeHeartbeat(id: string, heartbeat: Heartbeat | undefined): void {
    if (heartbeat === undefined) {
      this.#db.prepare('DELETE FROM heartbeats WHERE task_id = ?').run(id);
      return;
    }
    this.#db
      .prepare(
        `INSERT INTO heartbeats (task_id, at, phase, activity) VALUES (?, ?, ?, ?)
         ON CONFLICT (task_id) DO UPDATE SET at = excluded.at, phase = excluded.phase, activity = excluded.activity`,
      )
      .run(id, heartbeat.at, heartbeat.phase, heartbeat.activity ?? null);
  }

  #one(sql: string, param: string): Task | undefined {
    const row = this.#db.prepare(sql).get(param) as Row | undefined;
    return row ? toTask(row) : undefined;
  }
}

interface ChangeRow {
  at: string;
  actor: ChangeActor;
  user_id: string | null;
  field: TaskChange['field'];
  from_value: string | null;
  to_value: string | null;
}

// The writer pairs each field with values of its type, so the cast only restores what it stored.
const toChange = ({ at, actor, user_id, field, from_value, to_value }: ChangeRow): TaskChange => {
  const meta = { at, actor, ...(user_id !== null && { userId: user_id }) };
  return (
    from_value === null || to_value === null
      ? { ...meta, field }
      : { ...meta, field, from: JSON.parse(from_value), to: JSON.parse(to_value) }
  ) as TaskChange;
};

type StoredPullRequest = Omit<PullRequest, 'status'> & Partial<Pick<PullRequest, 'status'>>;
type StoredDecision = Omit<Decision, 'chosen'> & { chosen?: number | string };
/** How tasks stored before executions had their own record kept them. */
interface LegacyExecutionFields {
  tokenHash?: string;
  executionId?: string;
  worker?: Worker;
  workAcceptedAt?: string;
  lastHeartbeat?: Heartbeat;
}
type StoredTask = Omit<Task, 'model' | 'followUps' | 'dependsOn' | 'pullRequests' | 'decisions'> &
  Partial<Pick<Task, 'model' | 'followUps' | 'dependsOn'>> & { pullRequests: StoredPullRequest[]; decisions: StoredDecision[] } & LegacyExecutionFields;

// Decisions stored before `chosen` became an index hold the chosen text, which
// agents often worded differently from every option; such text becomes the last option.
const toDecision = ({ chosen, ...decision }: StoredDecision): Decision => {
  if (typeof chosen !== 'string') return { ...decision, ...(chosen !== undefined && { chosen }) };
  const index = decision.options.indexOf(chosen);
  if (index >= 0) return { ...decision, chosen: index };
  return { ...decision, options: [...decision.options, chosen], chosen: decision.options.length };
};

const isExternalUrlConflict = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed: tasks\.external_url/.test(error.message);

const externalUrl = ({ external }: Task): string | null => external?.url ?? null;

const executionColumns = ({ execution }: Task): [string | null, string | null] => [
  execution?.tokenHash ?? null,
  execution?.id ?? null,
];

/** The heartbeat lives in its own table. */
function toData(task: Task): string {
  if (task.execution === undefined) return JSON.stringify(task);
  const { lastHeartbeat: _stored, ...execution } = task.execution;
  return JSON.stringify({ ...task, execution });
}

const toHeartbeat = ({ at, phase, activity }: Row): Heartbeat | undefined =>
  at === null || phase === null ? undefined : { at, phase, ...(activity !== null && { activity }) };

/**
 * Tasks stored before executions had their own record kept its fields on the
 * task; one counts only with both id and token. Tasks stored before worker
 * states existed count as working since their last update.
 */
function legacyExecution(fields: LegacyExecutionFields, updatedAt: string): Execution | undefined {
  const { executionId, tokenHash, worker, workAcceptedAt } = fields;
  if (executionId === undefined || tokenHash === undefined) return undefined;
  return {
    id: executionId,
    tokenHash,
    worker: worker ?? { state: 'working', since: updatedAt },
    ...(workAcceptedAt !== undefined && { workAcceptedAt }),
  };
}

// Tasks stored before models, follow-ups, dependencies or pull request statuses existed lack
// them; they keep the old behaviour. A done task only got there once all its
// pull requests were merged or closed, and merged is by far the common case.
// Tasks stored before heartbeats had their own table carry one in `data`; it
// is dropped, since a running task beats again within seconds.
const toTask = (row: Row): Task => {
  const { lastHeartbeat: _legacy, tokenHash, executionId, worker, workAcceptedAt, ...stored } = JSON.parse(row.data) as StoredTask;
  const legacyStatus: PullRequestStatus = stored.status === 'done' ? 'merged' : 'open';
  const legacy = { tokenHash, executionId, worker, workAcceptedAt };
  const execution = stored.execution ?? legacyExecution(legacy, stored.updatedAt);
  const heartbeat = toHeartbeat(row);
  const { execution: _stored, ...task } = stored;
  return {
    ...task,
    ...(execution && { execution: { ...execution, ...(heartbeat && { lastHeartbeat: heartbeat }) } }),
    model: stored.model ?? 'opus',
    followUps: stored.followUps ?? [],
    dependsOn: stored.dependsOn ?? [],
    pullRequests: stored.pullRequests.map((pr) => ({ ...pr, status: pr.status ?? legacyStatus })),
    decisions: stored.decisions.map(toDecision),
  };
};

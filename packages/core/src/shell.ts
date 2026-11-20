import type { TaskView } from './views.ts';

/** Terminal size in character cells. */
export interface ShellSize {
  cols: number;
  rows: number;
}

/** An engineer's request for a shell into a task's execution server. */
export interface ShellRequest {
  id: string;
  taskId: string;
  size: ShellSize;
  /** The id of the user who asked for it. */
  requestedBy: string;
  createdAt: string;
}

/** A control message the browser sends as a WebSocket text frame. */
export type ShellControl = { type: 'resize'; cols: number; rows: number };

/** At most this many shells may be open into one execution server at a time. */
export const maxShellsPerTask = 3;

// Generous for any real screen, small enough that a client cannot make the
// pseudo-terminal allocate absurd buffers.
const maxCols = 500;
const maxRows = 200;

const isIntegerIn = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;

/** Whole numbers only, cols 1 to 500 and rows 1 to 200; `undefined` otherwise. */
export function parseShellSize(cols: unknown, rows: unknown): ShellSize | undefined {
  if (!isIntegerIn(cols, maxCols) || !isIntegerIn(rows, maxRows)) return undefined;
  return { cols, rows };
}

/** One WebSocket text frame; `undefined` for anything but an exact, valid control message. */
export function parseShellControl(text: string): ShellControl | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const fields: Record<string, unknown> = { ...value };
  const isResize = fields.type === 'resize' && Object.keys(fields).every((key) => ['type', 'cols', 'rows'].includes(key));
  if (!isResize) return undefined;
  const size = parseShellSize(fields.cols, fields.rows);
  return size && { type: 'resize', ...size };
}

/** Whether an engineer may open a shell: the task allows it and has an execution server that is not going away. Takes the browser's view too. */
export const canOpenShell = (task: Pick<TaskView, 'shellEnabled' | 'execution' | 'status'>): boolean =>
  task.shellEnabled && task.execution !== undefined && task.status !== 'done';

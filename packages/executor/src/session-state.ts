import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * What the runner must remember across processes: the execution server keeps its
 * disk, but a restarted runner is a new process.
 */
export interface SessionState {
  /** The agent session to resume; it exists once a turn of it succeeded. */
  sessionId: string;
  /** The session's running cost total so far; the control plane gets each increase. */
  costUsd: number;
}

export interface SessionStore {
  /** Undefined until a session exists. */
  load(): Promise<SessionState | undefined>;
  save(state: SessionState): Promise<void>;
}

export function createSessionStore(path: string): SessionStore {
  return {
    load: async () => {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
      return parseState(text, path);
    },
    save: async (state) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(state));
    },
  };
}

// Written only by this runner, so a malformed file means a broken disk: failing
// loudly beats silently starting over and losing the agent's work.
function parseState(text: string, path: string): SessionState {
  const { sessionId, costUsd } = JSON.parse(text) as Partial<Record<keyof SessionState, unknown>>;
  if (typeof sessionId !== 'string' || sessionId === '' || typeof costUsd !== 'number' || !(costUsd >= 0)) {
    throw new Error(`${path} does not hold a session state: ${text.slice(0, 200)}`);
  }
  return { sessionId, costUsd };
}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TokenUsage } from '@factory/core';

/**
 * What the runner must remember across processes: the execution server keeps its
 * disk, but a restarted runner is a new process.
 */
export interface SessionState {
  /** The agent session to resume; it exists once a turn of it succeeded. */
  sessionId: string;
  /** The session's running cost total so far; the control plane gets each increase. */
  costUsd: number;
  /** The session's running token totals so far, reported like the cost. */
  tokens: TokenUsage;
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
  const { sessionId, costUsd, tokens } = JSON.parse(text) as Partial<Record<keyof SessionState, unknown>>;
  const failure = new Error(`${path} does not hold a session state: ${text.slice(0, 200)}`);
  if (typeof sessionId !== 'string' || sessionId === '' || !isCount(costUsd)) throw failure;
  // A state saved before tokens were tracked has a zero baseline: none of its tokens were reported yet,
  // so the next turn reports the session's whole total.
  if (tokens === undefined) return { sessionId, costUsd, tokens: noTokens };
  if (typeof tokens !== 'object' || tokens === null) throw failure;
  const inputTokens = Reflect.get(tokens, 'inputTokens');
  const outputTokens = Reflect.get(tokens, 'outputTokens');
  const cacheReadTokens = Reflect.get(tokens, 'cacheReadTokens');
  const cacheCreationTokens = Reflect.get(tokens, 'cacheCreationTokens');
  if (!isCount(inputTokens) || !isCount(outputTokens) || !isCount(cacheReadTokens) || !isCount(cacheCreationTokens)) throw failure;
  return { sessionId, costUsd, tokens: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } };
}

export const noTokens: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

const isCount = (value: unknown): value is number => typeof value === 'number' && value >= 0;

import { createHash, randomBytes } from 'node:crypto';

export interface AgentToken {
  /** Handed to the execution server once; never stored. */
  token: string;
  tokenHash: string;
}

const tokenBytes = 32;

export const hashAgentToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function createAgentToken(): AgentToken {
  const token = randomBytes(tokenBytes).toString('hex');
  return { token, tokenHash: hashAgentToken(token) };
}

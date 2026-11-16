import { spawn } from 'node:child_process';

export interface CommandResult {
  code: number;
  /** At most the last `capturedBytes` characters. */
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
  /** Also stream output to this process's stdout/stderr, i.e. the execution server's log. */
  teeOutput?: boolean;
  /** Called with every complete stdout line as it arrives, without its newline. */
  onStdoutLine?: (line: string) => void;
}

export type RunCommand = (command: string, args: readonly string[], options?: CommandOptions) => Promise<CommandResult>;

// A session streams megabytes of JSON; callers only ever need its end.
const capturedBytes = 64 * 1024;
const keepTail = (text: string): string => (text.length > capturedBytes ? text.slice(-capturedBytes) : text);

export const runCommand: RunCommand = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const lines = options.onStdoutLine && lineSplitter(options.onStdoutLine);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (options.teeOutput) process.stdout.write(chunk);
      lines?.push(chunk);
      stdout = keepTail(stdout + chunk);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (options.teeOutput) process.stderr.write(chunk);
      stderr = keepTail(stderr + chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      lines?.end();
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

// Chunks split lines anywhere; the partial last line waits for the next chunk.
// Lines are not capped: stream-json events can be large, but each one is
// handed over and dropped right away.
function lineSplitter(onLine: (line: string) => void): { push: (chunk: string) => void; end: () => void } {
  let partial = '';
  return {
    push: (chunk) => {
      const parts = (partial + chunk).split('\n');
      partial = parts.pop()!;
      parts.forEach(onLine);
    },
    end: () => {
      if (partial !== '') onLine(partial);
      partial = '';
    },
  };
}

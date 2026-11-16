import { spawn } from 'node:child_process';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (
  command: string,
  args: readonly string[],
  /** `input` is written to the command's stdin, which is closed right away otherwise. */
  options?: { env?: NodeJS.ProcessEnv; input?: string },
) => Promise<CommandResult>;

export const runCommand: RunCommand = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    // A command that exits before reading its input breaks the pipe; its exit code tells the caller.
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

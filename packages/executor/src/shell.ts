import type { SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { parseShellControl, type ShellRequest, type ShellSize } from '@factory/core';

/** The part of a child process the shell host uses; `ChildProcess` satisfies it. */
export interface ShellProcess {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
}

/** Node's WebSocket constructor, which also takes request headers. */
export type WebSocketConstructor = new (url: string, init: { headers: Record<string, string> }) => WebSocket;

// TypeScript's default DOM typings describe the browser constructor, which
// takes no headers; Node's takes `{ headers }` (checked on Node 26.13.1).
export const NodeWebSocket = WebSocket as unknown as WebSocketConstructor;

export type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ShellProcess;

export interface ShellHostDeps {
  listShellRequests: () => Promise<ShellRequest[]>;
  controlPlaneUrl: string;
  taskToken: string;
  /** Where the shell starts; `homeDir` if it does not exist. */
  workDir: string;
  homeDir: string;
  spawn: SpawnProcess;
  WebSocket: WebSocketConstructor;
  /** Signals a process group; `process.kill` with a negative pid. */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  log: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  /** How long a hung-up shell may linger before it is killed. */
  killDelayMs?: number;
}

export interface ShellHost {
  /** Connects every pending request not handled yet; call it on each shell ring. */
  checkRequests(): Promise<void>;
}

// A WHATWG WebSocket client may not send 1011, so the application range mirrors it.
const shellFailedCode = 4011;
const maxBufferedBytes = 1024 * 1024;
const drainCheckMs = 50;
const defaultKillDelayMs = 2_000;
const ptsPattern = /^\/dev\/pts\/\d+$/;
// Far more than a pts path; a longer first line is not one.
const maxFirstLineBytes = 256;

/**
 * Serves the engineers' shell requests, each over its own WebSocket to the
 * control plane. Lists the pending requests once at start: a container
 * started for a shell gets no ring.
 */
export function createShellHost(deps: ShellHostDeps): ShellHost {
  const handledIds = new Set<string>();
  const checkRequests = async (): Promise<void> => {
    let requests: ShellRequest[];
    try {
      requests = await deps.listShellRequests();
    } catch (error) {
      deps.log(`could not list shell requests: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const request of requests) {
      if (handledIds.has(request.id)) continue;
      handledIds.add(request.id);
      openShell(deps, request, () => handledIds.delete(request.id));
    }
  };
  void checkRequests();
  return { checkRequests };
}

/** `http:` becomes `ws:`, `https:` becomes `wss:`. */
export function shellUrl(controlPlaneUrl: string, requestId: string): string {
  const url = new URL(`/agent/shells/${encodeURIComponent(requestId)}`, controlPlaneUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function openShell(deps: ShellHostDeps, request: ShellRequest, onEnd: () => void): void {
  const socket = new deps.WebSocket(shellUrl(deps.controlPlaneUrl, request.id), {
    headers: { authorization: `Bearer ${deps.taskToken}` },
  });
  socket.binaryType = 'arraybuffer';
  let shell: RunningShell | undefined;
  socket.addEventListener('open', () => {
    deps.log(`shell ${request.id} opened`);
    try {
      shell = startShell(deps, socket, request.size);
    } catch (error) {
      // spawn throws, rather than emits, for some errors.
      deps.log(`shell could not start: ${error instanceof Error ? error.message : String(error)}`);
      socket.close(shellFailedCode, 'shell could not start');
    }
  });
  socket.addEventListener('message', (event: MessageEvent<unknown>) => shell?.receive(event.data));
  socket.addEventListener('close', () => {
    deps.log(`shell ${request.id} closed`);
    shell?.hangUp();
    onEnd();
  });
}

interface RunningShell {
  receive(data: unknown): void;
  hangUp(): void;
}

function startShell(deps: ShellHostDeps, socket: WebSocket, initialSize: ShellSize): RunningShell {
  let size = initialSize;
  let pts: string | undefined;
  let hasFailed = false;
  // Held until the terminal is known: the pty would echo it ahead of `tty`'s output.
  let earlyInput: Buffer[] = [];
  let killTimer: NodeJS.Timeout | undefined;
  const closeSocket = (code: number, reason: string) => {
    if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(code, reason);
  };
  const failStart = (reason: string) => {
    hasFailed = true;
    deps.log(`shell could not start: ${reason}`);
    closeSocket(shellFailedCode, reason);
  };
  const resize = () => {
    if (pts) runStty(deps, pts, size);
  };

  // `tty` prints the pseudo-terminal first, so stty can size it from outside.
  const child = deps.spawn('script', ['-qfec', 'tty; exec bash -l', '/dev/null'], {
    detached: true,
    cwd: existsSync(deps.workDir) ? deps.workDir : deps.homeDir,
    env: { ...(deps.env ?? process.env), TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const isRunning = () => child.exitCode === null && child.signalCode === null;
  child.once('error', (error) => {
    deps.log(`shell could not start: ${error.message}`);
    closeSocket(shellFailedCode, 'shell could not start');
  });
  child.once('close', (code, signal) => {
    clearTimeout(killTimer);
    if (pts === undefined) closeSocket(shellFailedCode, 'shell could not start');
    else closeSocket(1000, `exit ${code ?? signal}`);
  });
  child.stdin?.on('error', (error) => deps.log(`shell input failed: ${error.message}`));

  const stdout = child.stdout;
  let head = Buffer.alloc(0);
  stdout?.on('data', (chunk: Buffer<ArrayBuffer>) => {
    if (hasFailed) return;
    if (pts === undefined) {
      head = Buffer.concat([head, chunk]);
      const newline = head.indexOf('\n');
      if (newline === -1 && head.length <= maxFirstLineBytes) return;
      const line = head.subarray(0, Math.max(newline, 0)).toString().trim();
      if (newline === -1 || !ptsPattern.test(line)) {
        failStart('no terminal');
        return;
      }
      pts = line;
      resize();
      earlyInput.forEach((input) => child.stdin?.write(input));
      earlyInput = [];
      chunk = head.subarray(newline + 1);
      if (chunk.length === 0) return;
    }
    socket.send(chunk);
    if (socket.bufferedAmount > maxBufferedBytes) pauseUntilDrained(socket, stdout);
  });

  return {
    receive: (data) => {
      if (data instanceof ArrayBuffer) {
        if (pts === undefined) earlyInput.push(Buffer.from(data));
        else child.stdin?.write(Buffer.from(data));
        return;
      }
      const control = typeof data === 'string' ? parseShellControl(data) : undefined;
      if (!control) {
        deps.log('ignored an invalid shell control message');
        return;
      }
      size = control;
      resize();
    },
    hangUp: () => {
      if (!isRunning() || child.pid === undefined) return;
      const pid = child.pid;
      signalGroup(deps, pid, 'SIGHUP');
      killTimer = setTimeout(() => {
        if (isRunning()) signalGroup(deps, pid, 'SIGKILL');
      }, deps.killDelayMs ?? defaultKillDelayMs);
    },
  };
}

function pauseUntilDrained(socket: WebSocket, stdout: Readable): void {
  if (stdout.isPaused()) return;
  stdout.pause();
  const timer = setInterval(() => {
    if (socket.bufferedAmount > maxBufferedBytes && socket.readyState === socket.OPEN) return;
    clearInterval(timer);
    stdout.resume();
  }, drainCheckMs);
}

function signalGroup(deps: ShellHostDeps, pid: number, signal: NodeJS.Signals): void {
  try {
    deps.kill(-pid, signal);
  } catch (error) {
    deps.log(`could not send ${signal} to the shell: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runStty(deps: ShellHostDeps, pts: string, { rows, cols }: ShellSize): void {
  let child: ShellProcess;
  try {
    child = deps.spawn('stty', ['-F', pts, 'rows', String(rows), 'cols', String(cols)], { stdio: 'ignore' });
  } catch (error) {
    deps.log(`stty failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  child.once('error', (error) => deps.log(`stty failed: ${error.message}`));
  child.once('close', (code) => {
    if (code !== 0) deps.log(`stty exited with ${code}`);
  });
}

import assert from 'node:assert/strict';
import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';
import type { ShellRequest } from '@factory/core';
import { createShellHost, NodeWebSocket, shellUrl, type ShellHostDeps, type ShellProcess } from './shell.ts';
import { startTestWebSocketServer, type TestConnection } from './test-websocket-server.ts';

class FakeProcess extends EventEmitter implements ShellProcess {
  readonly pid = 4242;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  input = '';

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => (this.input += chunk.toString()));
  }

  exit(code: number): void {
    this.exitCode = code;
    this.emit('close', code, null);
  }
}

interface Spawned {
  command: string;
  args: string[];
  options: SpawnOptions;
}

const request = (id: string, size = { cols: 80, rows: 24 }): ShellRequest => ({
  id,
  taskId: 't1',
  size,
  requestedBy: 'u1',
  createdAt: '2026-11-20T00:00:00.000Z',
});

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function setUp(t: TestContext, requests: ShellRequest[] = [request('s1')], overrides: Partial<ShellHostDeps> = {}) {
  const server = await startTestWebSocketServer();
  t.after(() => server.close());
  const homeDir = await mkdtemp(join(tmpdir(), 'shell-home-'));
  const spawned: Spawned[] = [];
  const shells: FakeProcess[] = [];
  const kills: Array<[number, NodeJS.Signals]> = [];
  const logs: string[] = [];
  let listings = 0;
  const deps: ShellHostDeps = {
    listShellRequests: async () => {
      listings++;
      return requests;
    },
    controlPlaneUrl: server.url,
    taskToken: 'task-secret',
    workDir: join(homeDir, 'workspace'),
    homeDir,
    spawn: (command, args, options) => {
      spawned.push({ command, args, options });
      const child = new FakeProcess();
      if (command === 'script') shells.push(child);
      else setImmediate(() => child.exit(0));
      return child;
    },
    WebSocket: NodeWebSocket,
    kill: (pid, signal) => void kills.push([pid, signal]),
    log: (message) => void logs.push(message),
    env: { PATH: '/usr/bin', SECRET: 'kept' },
    killDelayMs: 20,
    ...overrides,
  };
  const host = createShellHost(deps);
  const stty = () => spawned.filter((s) => s.command === 'stty').map((s) => s.args.join(' '));
  return { server, host, spawned, shells, kills, logs, stty, homeDir, listings: () => listings };
}

/** Connects and lets the fake shell report its terminal. */
async function openShell(setup: Awaited<ReturnType<typeof setUp>>): Promise<{ connection: TestConnection; shell: FakeProcess }> {
  const connection = await setup.server.nextConnection();
  await waitFor(() => setup.shells.length > 0, 'the shell to start');
  const shell = setup.shells[0]!;
  shell.stdout.write('/dev/pts/3\r\nwelcome\r\n');
  await waitFor(() => connection.frames.length > 0 || setup.stty().length > 0, 'the shell output');
  return { connection, shell };
}

test('the URL follows the control plane scheme', () => {
  assert.equal(shellUrl('http://host.containers.internal:4700', 's1'), 'ws://host.containers.internal:4700/agent/shells/s1');
  assert.equal(shellUrl('https://factory.example/', 's1'), 'wss://factory.example/agent/shells/s1');
});

test('lists the requests at start-up and connects with the task token', async (t) => {
  const setup = await setUp(t);
  const connection = await setup.server.nextConnection();
  assert.equal(setup.listings(), 1);
  assert.equal(connection.request.url, '/agent/shells/s1');
  assert.equal(connection.request.headers.authorization, 'Bearer task-secret');
});

test('a ring skips requests already being handled', async (t) => {
  const setup = await setUp(t, [request('s1')]);
  await setup.server.nextConnection();
  await setup.host.checkRequests();
  await setup.host.checkRequests();
  assert.equal(setup.listings(), 3);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(setup.server.connections.length, 1);
});

test('a failed listing is logged and retried at the next ring', async (t) => {
  let isDown = true;
  const setup = await setUp(t, [], {
    listShellRequests: async () => {
      if (isDown) throw new Error('connection refused');
      return [request('s2')];
    },
  });
  await setup.host.checkRequests();
  assert.ok(setup.logs.includes('could not list shell requests: connection refused'));
  isDown = false;
  await setup.host.checkRequests();
  assert.equal((await setup.server.nextConnection()).request.url, '/agent/shells/s2');
});

test('starts a login shell in script, with TERM, in the home directory without a workspace', async (t) => {
  const setup = await setUp(t);
  await openShell(setup);
  const script = setup.spawned.find((s) => s.command === 'script')!;
  assert.deepEqual(script.args, ['-qfec', 'tty; exec bash -l', '/dev/null']);
  assert.equal(script.options.detached, true);
  assert.equal(script.options.cwd, setup.homeDir);
  assert.deepEqual(script.options.env, { PATH: '/usr/bin', SECRET: 'kept', TERM: 'xterm-256color' });
});

test('drops the terminal line from the output and sizes the terminal', async (t) => {
  const setup = await setUp(t, [request('s1', { cols: 120, rows: 40 })]);
  const { connection } = await openShell(setup);
  await waitFor(() => connection.frames.length > 0, 'output');
  assert.deepEqual(connection.frames, [{ binary: Buffer.from('welcome\r\n') }]);
  await waitFor(() => setup.stty().length > 0, 'stty');
  assert.deepEqual(setup.stty(), ['-F /dev/pts/3 rows 40 cols 120']);
});

test('binary frames go to the shell, resize frames run stty, other text is ignored', async (t) => {
  const setup = await setUp(t);
  const { connection, shell } = await openShell(setup);
  connection.sendBinary(Buffer.from('ls\r'));
  connection.sendText(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  connection.sendText(JSON.stringify({ type: 'resize', cols: 0, rows: 30 }));
  connection.sendText('rm -rf /');
  await waitFor(() => shell.input === 'ls\r' && setup.stty().length === 2, 'input and resize');
  await waitFor(() => setup.logs.filter((l) => l === 'ignored an invalid shell control message').length === 2, 'logs');
  assert.deepEqual(setup.stty(), ['-F /dev/pts/3 rows 24 cols 80', '-F /dev/pts/3 rows 30 cols 100']);
  assert.ok(setup.logs.every((l) => !l.includes('rm -rf')));
});

test('a first line that is no terminal closes with 4011', async (t) => {
  const setup = await setUp(t);
  const connection = await setup.server.nextConnection();
  await waitFor(() => setup.shells.length > 0, 'the shell');
  setup.shells[0]!.stdout.write('not a tty\n');
  assert.deepEqual(await connection.closed, { code: 4011, reason: 'no terminal' });
  assert.deepEqual(connection.frames, []);
});

test('a shell that cannot be spawned closes with 4011', async (t) => {
  const setup = await setUp(t);
  const connection = await setup.server.nextConnection();
  await waitFor(() => setup.shells.length > 0, 'the shell');
  setup.shells[0]!.emit('error', new Error('spawn script ENOENT'));
  assert.deepEqual(await connection.closed, { code: 4011, reason: 'shell could not start' });
});

test('the shell exiting closes with 1000 and its exit code', async (t) => {
  const setup = await setUp(t);
  const { connection, shell } = await openShell(setup);
  shell.exit(130);
  assert.deepEqual(await connection.closed, { code: 1000, reason: 'exit 130' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(setup.kills, []);
});

test('closing the connection hangs up the process group, then kills it', async (t) => {
  const setup = await setUp(t);
  const { connection } = await openShell(setup);
  connection.close(1000, 'bye');
  await waitFor(() => setup.kills.length === 2, 'the kill');
  assert.deepEqual(setup.kills, [
    [-4242, 'SIGHUP'],
    [-4242, 'SIGKILL'],
  ]);
});

test('a shell that ends on the hang-up is not killed', async (t) => {
  const setup = await setUp(t);
  const { connection, shell } = await openShell(setup);
  connection.close(1000, 'bye');
  await waitFor(() => setup.kills.length === 1, 'the hang-up');
  shell.signalCode = 'SIGHUP';
  shell.emit('close', null, 'SIGHUP');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(setup.kills, [[-4242, 'SIGHUP']]);
});

test('a closed request can be served again', async (t) => {
  const setup = await setUp(t);
  const { connection } = await openShell(setup);
  connection.close(1000, 'bye');
  await waitFor(() => setup.kills.length > 0, 'the hang-up');
  await setup.host.checkRequests();
  assert.equal((await setup.server.nextConnection()).request.url, '/agent/shells/s1');
});

test('input typed before the terminal is known reaches the shell after it', async (t) => {
  const setup = await setUp(t);
  const connection = await setup.server.nextConnection();
  await waitFor(() => setup.shells.length > 0, 'the shell');
  const shell = setup.shells[0]!;
  connection.sendBinary(Buffer.from('early'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(shell.input, '');
  shell.stdout.write('/dev/pts/3\r\n');
  await waitFor(() => shell.input === 'early', 'the early input');
});

test('a first line too long for a terminal closes with 4011', async (t) => {
  const setup = await setUp(t);
  const connection = await setup.server.nextConnection();
  await waitFor(() => setup.shells.length > 0, 'the shell');
  setup.shells[0]!.stdout.write('x'.repeat(300));
  assert.deepEqual(await connection.closed, { code: 4011, reason: 'no terminal' });
});

test('a connection closed before the terminal is known still hangs up the shell', async (t) => {
  const setup = await setUp(t);
  const connection = await setup.server.nextConnection();
  await waitFor(() => setup.shells.length > 0, 'the shell');
  connection.close(1000, 'bye');
  await waitFor(() => setup.kills.length > 0, 'the hang-up');
  assert.deepEqual(setup.kills[0], [-4242, 'SIGHUP']);
});

test('a spawn that throws closes with 4011 instead of crashing', async (t) => {
  const setup = await setUp(t, [request('s1')], {
    spawn: () => {
      throw new Error('spawn E2BIG');
    },
  });
  const connection = await setup.server.nextConnection();
  assert.deepEqual(await connection.closed, { code: 4011, reason: 'shell could not start' });
});

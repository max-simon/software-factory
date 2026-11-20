import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionSpec } from '@factory/core';
import { PodmanRuntime, type PodmanRuntimeOptions } from './podman-runtime.ts';
import type { CommandResult, RunCommand } from './run-command.ts';

interface Call {
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
}

/** `result` answers every command, or each by its arguments. */
function setup(
  result: Partial<CommandResult> | ((args: readonly string[]) => Partial<CommandResult>) = {},
  options: { anthropicCredential?: PodmanRuntimeOptions['anthropicCredential']; doorbellStatus?: number } = {},
) {
  const calls: Call[] = [];
  const nudges: Array<{ url: string; method?: string }> = [];
  const { doorbellStatus = 204, ...runtimeOptions } = options;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    nudges.push({ url: String(url), ...(init?.method && { method: init.method }) });
    return new Response(null, { status: doorbellStatus });
  }) as typeof fetch;
  const runCommand: RunCommand = async (command, args, options) => {
    calls.push({ command, args, ...(options?.env && { env: options.env }) });
    return { code: 0, stdout: '', stderr: '', ...(typeof result === 'function' ? result(args) : result) };
  };
  const runtime = new PodmanRuntime({
    image: 'factory-executor:latest',
    gitUserName: 'Factory Bot',
    gitUserEmail: 'bot@example.com',
    anthropicCredential: 'ANTHROPIC_API_KEY',
    ...runtimeOptions,
    runCommand,
    fetchFn,
  });
  return { runtime, calls, nudges };
}

const spec: ExecutionSpec = {
  taskId: 'abc123',
  repoUrl: 'https://github.com/o/r',
  controlPlaneUrl: 'http://host.containers.internal:8080',
  token: 'tok-plain-value',
  model: 'sonnet',
  shellEnabled: true,
};

const envArgs = (args: readonly string[]): string[] => args.flatMap((arg, i) => (args[i - 1] === '--env' ? [arg] : []));
const published = (args: readonly string[]): string[] => args.flatMap((arg, i) => (args[i - 1] === '--publish' ? [arg] : []));

test('start runs a named, replaced, detached container with the image last', async () => {
  const { runtime, calls } = setup({ stdout: 'container-id\n' });
  const started = await runtime.start(spec);

  assert.deepEqual(started, { executionId: 'container-id' });
  const { command, args } = calls[0]!;
  assert.equal(command, 'podman');
  assert.deepEqual(args.slice(0, 5), ['run', '-d', '--replace', '--name', 'factory-task-abc123']);
  assert.equal(args.at(-1), 'factory-executor:latest');
});

test('start labels the container with its task so it can be listed', async () => {
  const { runtime, calls } = setup();
  await runtime.start(spec);
  const { args } = calls[0]!;
  assert.equal(args[args.indexOf('--label') + 1], 'factory.task=abc123');
});

test('start passes plain values by assignment and secrets by name only', async () => {
  const { runtime, calls } = setup();
  await runtime.start({ ...spec, baseBranch: 'develop' });
  const env = envArgs(calls[0]!.args);

  assert.deepEqual(env, [
    'FACTORY_TASK_ID=abc123',
    'FACTORY_REPO_URL=https://github.com/o/r',
    'FACTORY_BASE_BRANCH=develop',
    'FACTORY_MODEL=sonnet',
    'FACTORY_SHELL_ENABLED=true',
    'FACTORY_CONTROL_PLANE_URL=http://host.containers.internal:8080',
    'GIT_USER_NAME=Factory Bot',
    'GIT_USER_EMAIL=bot@example.com',
    'ANTHROPIC_API_KEY',
    'GITHUB_TOKEN',
    'FACTORY_TASK_TOKEN',
  ]);
});

test('start passes a disabled shell as a plain value too', async () => {
  const { runtime, calls } = setup();
  await runtime.start({ ...spec, shellEnabled: false });
  assert.ok(envArgs(calls[0]!.args).includes('FACTORY_SHELL_ENABLED=false'));
});

test('start forwards the configured Anthropic credential by name', async () => {
  const { runtime, calls } = setup({ stdout: 'c1' }, { anthropicCredential: 'CLAUDE_CODE_OAUTH_TOKEN' });
  await runtime.start(spec);
  const credentials = envArgs(calls[0]!.args).filter((name) => name === 'ANTHROPIC_API_KEY' || name === 'CLAUDE_CODE_OAUTH_TOKEN');
  assert.deepEqual(credentials, ['CLAUDE_CODE_OAUTH_TOKEN']);
});

test('start omits FACTORY_BASE_BRANCH when unset', async () => {
  const { runtime, calls } = setup();
  await runtime.start(spec);
  assert.ok(!envArgs(calls[0]!.args).some((entry) => entry.startsWith('FACTORY_BASE_BRANCH')));
});

test('start publishes only the doorbell on host loopback', async () => {
  const { runtime, calls } = setup({ stdout: 'container-id' });
  await runtime.start(spec);
  assert.deepEqual(published(calls[0]!.args), ['127.0.0.1::4097']);
  assert.equal(calls.length, 1);
});

test('start hands the token to podman through its environment, never an argument', async () => {
  const { runtime, calls } = setup();
  await runtime.start(spec);
  const { args, env } = calls[0]!;

  assert.ok(args.every((arg) => !arg.includes(spec.token)));
  assert.equal(env?.FACTORY_TASK_TOKEN, spec.token);
});

test('start throws with stderr on a non-zero exit', async () => {
  const { runtime } = setup({ code: 125, stderr: 'image not found\n' });
  await assert.rejects(runtime.start(spec), /podman run failed with exit code 125: image not found/);
});

/** Answers `inspect` with whether the container runs and `port` with the doorbell's loopback port. */
const containerIn = (isRunning: boolean) => (args: readonly string[]) => {
  if (args[0] === 'inspect') return { stdout: `${isRunning}\n` };
  if (args[0] === 'port') return { stdout: '127.0.0.1:43100\n' };
  return {};
};

test('notify rings the doorbell of a running container', async () => {
  const { runtime, calls, nudges } = setup(containerIn(true));
  await runtime.notify('c1');
  assert.deepEqual(calls.map((call) => call.args), [['inspect', '--format', '{{.State.Running}}', 'c1'], ['port', 'c1', '4097/tcp']]);
  assert.deepEqual(nudges, [{ url: 'http://127.0.0.1:43100/nudge', method: 'POST' }]);
});

test('notify throws when the doorbell does not accept the nudge', async () => {
  const { runtime } = setup(containerIn(true), { doorbellStatus: 503 });
  await assert.rejects(runtime.notify('c1'), /the doorbell answered 503/);
});

test('notify starts a stopped container instead of ringing', async () => {
  const { runtime, calls, nudges } = setup(containerIn(false));
  await runtime.notify('c1');
  assert.deepEqual(calls.map((call) => call.args).slice(1), [['start', 'c1']]);
  assert.deepEqual(nudges, []);
});

test('notify throws with stderr when the container cannot be inspected', async () => {
  const { runtime } = setup({ code: 125, stderr: 'no such container' });
  await assert.rejects(runtime.notify('c1'), /podman inspect failed with exit code 125: no such container/);
});

test('notifyShell rings the shell doorbell of a running container', async () => {
  const { runtime, calls, nudges } = setup(containerIn(true));
  await runtime.notifyShell('c1');
  assert.deepEqual(calls.map((call) => call.args), [['inspect', '--format', '{{.State.Running}}', 'c1'], ['port', 'c1', '4097/tcp']]);
  assert.deepEqual(nudges, [{ url: 'http://127.0.0.1:43100/shell', method: 'POST' }]);
});

test('notifyShell starts a stopped container instead of ringing', async () => {
  const { runtime, calls, nudges } = setup(containerIn(false));
  await runtime.notifyShell('c1');
  assert.deepEqual(calls.map((call) => call.args).slice(1), [['start', 'c1']]);
  assert.deepEqual(nudges, []);
});

test('notifyShell throws when the doorbell does not accept the request', async () => {
  const { runtime } = setup(containerIn(true), { doorbellStatus: 503 });
  await assert.rejects(runtime.notifyShell('c1'), /the doorbell answered 503/);
});

test('restart kills the container at once and keeps it', async () => {
  const { runtime, calls } = setup(containerIn(true));
  await runtime.restart('c1');
  assert.deepEqual(calls.map((call) => call.args), [['restart', '--time', '0', 'c1']]);
});

test('remove force-removes and ignores a missing container', async () => {
  const { runtime, calls } = setup();
  await runtime.remove('c1');
  assert.deepEqual(calls[0]!.args, ['rm', '-f', '--time', '0', '--ignore', 'c1']);
});

test('listExecutions lists the full ids of all labelled containers, running or exited', async () => {
  const { runtime, calls } = setup({ stdout: `${'a'.repeat(64)}\n  ${'b'.repeat(64)}  \n\n` });
  assert.deepEqual(await runtime.listExecutions(), ['a'.repeat(64), 'b'.repeat(64)]);
  assert.deepEqual(calls[0]!.args, ['ps', '--all', '--no-trunc', '--filter', 'label=factory.task', '--format', '{{.ID}}']);
});

test('listExecutions returns no ids for empty output', async () => {
  const { runtime } = setup({ stdout: '' });
  assert.deepEqual(await runtime.listExecutions(), []);
});

test('listExecutions throws with stderr on a non-zero exit', async () => {
  const { runtime } = setup({ code: 125, stderr: 'cannot connect to podman\n' });
  await assert.rejects(runtime.listExecutions(), /podman ps failed with exit code 125: cannot connect to podman/);
});

test('start removes a half-created container by name when run fails', async () => {
  const { runtime, calls } = setup({ code: 125, stderr: 'boom' });
  await assert.rejects(runtime.start(spec));
  assert.deepEqual(calls.at(-1)?.args, ['rm', '-f', '--ignore', 'factory-task-abc123']);
});

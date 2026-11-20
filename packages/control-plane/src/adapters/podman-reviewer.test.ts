import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InputReviewRequest, PrReviewRequest, SpecReviewRequest } from '@factory/core';
import { loadConfig } from '../config.ts';
import { PodmanReviewer } from './podman-reviewer.ts';
import type { CommandResult, RunCommand } from './run-command.ts';

const request: SpecReviewRequest = {
  project: { title: 'Billing', description: '' },
  task: { title: 'Add VAT', specification: 'spec', labels: [], autonomyMode: 'autonomous' },
  otherTasks: [],
};

function setup(
  answer: (args: readonly string[]) => Partial<CommandResult> | Promise<Partial<CommandResult>>,
  timeoutMs?: number,
  anthropicCredential = 'CLAUDE_CODE_OAUTH_TOKEN',
) {
  const calls: Array<{ args: readonly string[]; input?: string }> = [];
  const runCommand: RunCommand = async (_command, args, options) => {
    calls.push({ args, ...(options?.input !== undefined && { input: options.input }) });
    return { code: 0, stdout: '', stderr: '', ...(await answer(args)) };
  };
  const reviewer = new PodmanReviewer({
    image: 'factory-reviewer:latest',
    model: 'sonnet',
    anthropicCredential,
    runCommand,
    ...(timeoutMs !== undefined && { timeoutMs }),
  });
  return { reviewer, calls };
}

test('reviewSpec runs a throwaway container, sends the request on stdin and returns its answer', async () => {
  const { reviewer, calls } = setup(() => ({ stdout: '{"verdict":"ready","comment":"fine"}\n' }));

  assert.deepEqual(await reviewer.reviewSpec(request), { verdict: 'ready', comment: 'fine' });
  const { args, input } = calls[0]!;
  assert.deepEqual(args.slice(0, 3), ['run', '--rm', '-i']);
  assert.match(args[4]!, /^factory-reviewer-[0-9a-f]{10}$/);
  assert.deepEqual(args.slice(5), [
    '--label',
    'factory.reviewer=true',
    '--env',
    'FACTORY_MODEL=sonnet',
    '--env',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'factory-reviewer:latest',
    'spec',
  ]);
  assert.deepEqual(JSON.parse(input!), request);
});

test('reviewSpec fails with the end of stderr when the container fails', async () => {
  const { reviewer } = setup(() => ({ code: 1, stderr: 'noise\nreviewer failed: claude failed: rate limited\n' }));
  await assert.rejects(reviewer.reviewSpec(request), /exited with code 1: noise\nreviewer failed: claude failed: rate limited$/);
});

test('reviewSpec rejects answers that are no spec review', async () => {
  await assert.rejects(setup(() => ({ stdout: 'oops' })).reviewer.reviewSpec(request), /printed no JSON: oops/);
  await assert.rejects(
    setup(() => ({ stdout: '{"verdict":"needs_clarification","comment":" "}' })).reviewer.reviewSpec(request),
    /needs a comment/,
  );
});

test('reviewSpec removes a container that takes too long and fails', async () => {
  let release: () => void = () => {};
  const { reviewer, calls } = setup(
    (args) =>
      args[0] === 'run' ? new Promise((resolve) => (release = () => resolve({ code: 137 }))) : (release(), {}),
    10,
  );

  await assert.rejects(reviewer.reviewSpec(request), /gave no answer within 0.01 s/);
  assert.deepEqual(calls[1]!.args, ['rm', '-f', '--time', '0', '--ignore', calls[0]!.args[4]]);
});

const prRequest: PrReviewRequest = {
  task: { title: 'Add VAT', specification: 'spec' },
  pullRequest: { url: 'https://github.com/o/r/pull/7', headSha: 'abc' },
};

test('reviewPr runs the image in its pr role with the GitHub token and checks the answer', async () => {
  const { reviewer, calls } = setup(() => ({ stdout: '{"risk":"medium","comment":"- check x"}\n' }));
  assert.deepEqual(await reviewer.reviewPr(prRequest), { risk: 'medium', comment: '- check x' });
  assert.deepEqual(calls[0]!.args.slice(-6), ['--env', 'CLAUDE_CODE_OAUTH_TOKEN', '--env', 'GITHUB_TOKEN', 'factory-reviewer:latest', 'pr']);
  assert.deepEqual(JSON.parse(calls[0]!.input!), prRequest);
  await assert.rejects(setup(() => ({ stdout: '{"risk":"low","comment":""}' })).reviewer.reviewPr(prRequest), /needs a comment/);
});

test('reviewInput runs the image in its input role with the GitHub token and checks the answer', async () => {
  const inputRequest: InputReviewRequest = {
    project: { title: 'Billing', description: '' },
    task: { title: 'Add VAT', specification: 'spec', plan: [], questions: [], decisions: [], artifacts: [], pullRequests: [] },
    openIds: ['q1'],
  };
  const answer = { responses: [{ id: 'q1', action: 'leave_to_human', rationale: 'A product call.' }] };
  const { reviewer, calls } = setup(() => ({ stdout: `${JSON.stringify(answer)}\n` }));
  assert.deepEqual(await reviewer.reviewInput(inputRequest), answer);
  assert.deepEqual(calls[0]!.args.slice(-6), ['--env', 'CLAUDE_CODE_OAUTH_TOKEN', '--env', 'GITHUB_TOKEN', 'factory-reviewer:latest', 'input']);
  assert.deepEqual(JSON.parse(calls[0]!.input!), inputRequest);
  await assert.rejects(setup(() => ({ stdout: '{"responses":{}}' })).reviewer.reviewInput(inputRequest), /must be an array/);
});

test('forwards the one credential a task gets: the subscription token when both are set', async () => {
  const required = { GITHUB_TOKEN: 'g', FACTORY_GIT_USER_NAME: 'bot', FACTORY_GIT_USER_EMAIL: 'bot@example.com' };
  const forwarded = async (env: Record<string, string>): Promise<string[]> => {
    const { reviewer, calls } = setup(() => ({ stdout: '{"verdict":"ready","comment":"fine"}' }), undefined, loadConfig(env).agentCredential);
    await reviewer.reviewSpec(request);
    return calls[0]!.args.flatMap((arg, i) => (calls[0]!.args[i - 1] === '--env' && !arg.includes('=') ? [arg] : []));
  };
  assert.deepEqual(await forwarded({ ...required, ANTHROPIC_API_KEY: 'a', CLAUDE_CODE_OAUTH_TOKEN: 'o' }), ['CLAUDE_CODE_OAUTH_TOKEN']);
  assert.deepEqual(await forwarded({ ...required, ANTHROPIC_API_KEY: 'a' }), ['ANTHROPIC_API_KEY']);
  assert.deepEqual(await forwarded({ ...required, CLAUDE_CODE_OAUTH_TOKEN: 'o' }), ['CLAUDE_CODE_OAUTH_TOKEN']);
});

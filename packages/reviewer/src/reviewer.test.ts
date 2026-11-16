import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InputReviewRequest, PrReviewRequest, SpecReviewRequest } from '@factory/core';
import { claudeArgs, structuredOutputOf } from './claude.ts';
import { inputPrompt, parseInputReviewRequest } from './input.ts';
import { parsePrReviewRequest, prPrompt } from './pr.ts';
import { parseSpecReviewRequest, spec, specPrompt } from './spec.ts';

const request: SpecReviewRequest = {
  project: { title: 'Billing', description: 'Invoices for customers.' },
  task: {
    title: 'Add VAT',
    specification: 'Add VAT to invoices.',
    labels: ['tax'],
    autonomyMode: 'supervised',
    repoUrl: 'https://github.com/acme/billing',
  },
  otherTasks: [
    { title: 'Send invoices by mail', status: 'queued', labels: [], isDependency: false },
    { title: 'Add tax rates API', status: 'draft', labels: ['backend'], isDependency: true },
  ],
};

test('parseSpecReviewRequest accepts a request and names the first bad field', () => {
  assert.equal(parseSpecReviewRequest(request), request);
  assert.throws(() => parseSpecReviewRequest({ ...request, task: { ...request.task, labels: 'tax' } }), /task.labels must be an array of strings/);
  assert.throws(() => parseSpecReviewRequest({ ...request, otherTasks: [{ title: 'x', status: 'draft' }] }), /otherTasks\[0\].labels/);
  assert.throws(
    () => parseSpecReviewRequest({ ...request, otherTasks: [{ title: 'x', status: 'draft', labels: [] }] }),
    /otherTasks\[0\].isDependency must be a boolean/,
  );
  assert.throws(
    () => parseSpecReviewRequest({ ...request, otherTasks: [{ title: 'x', status: 'draft', labels: [], isDependency: 'yes' }] }),
    /otherTasks\[0\].isDependency must be a boolean/,
  );
  assert.throws(() => parseSpecReviewRequest('{}'), /request must be an object/);
});

test('specPrompt puts the task first, then its dependencies, the project and its other tasks', () => {
  assert.equal(
    specPrompt(request),
    [
      '# Task to review: Add VAT',
      '',
      "Repository: https://github.com/acme/billing (base branch: the repository's default branch)",
      'Labels: tax',
      'Autonomy mode: supervised (supervised agents may ask the engineer questions; autonomous ones may not)',
      '',
      '## Specification',
      '',
      'Add VAT to invoices.',
      '',
      '## Dependencies (the task starts only once all of them are done)',
      '',
      '- [draft] Add tax rates API (labels: backend)',
      '',
      '# Project: Billing',
      '',
      'Invoices for customers.',
      '',
      '## Other tasks of the project',
      '',
      '- [queued] Send invoices by mail (labels: none)',
    ].join('\n'),
  );
});

test('specPrompt marks what is missing', () => {
  const prompt = specPrompt({
    project: { title: 'P', description: ' ' },
    task: { title: 'T', specification: '', labels: [], autonomyMode: 'autonomous' },
    otherTasks: [],
  });
  assert.match(prompt, /Repository: none; the agent can only deliver documents/);
  assert.match(prompt, /## Specification\n\n\(empty\)/);
  assert.match(prompt, /## Dependencies \(.*\)\n\n\(none\)/);
  assert.match(prompt, /\(no description\)/);
  assert.match(prompt, /## Other tasks of the project\n\n\(none\)$/);
});

test('claudeArgs takes the prompt on stdin and asks for structured output, without tools by default', () => {
  const args = claudeArgs('system', 'opus', spec.schema);
  assert.equal(args[0], '-p');
  assert.equal(args[1]!.startsWith('-'), true, 'no positional prompt');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.equal(args[args.indexOf('--system-prompt') + 1], 'system');
  assert.equal(args[args.indexOf('--json-schema') + 1], JSON.stringify(spec.schema));
});

test('claudeArgs with tools keeps the default set and asks no permissions', () => {
  const args = claudeArgs('system', 'sonnet', spec.schema, true);
  assert.equal(args.includes('--tools'), false);
  assert.ok(args.includes('--dangerously-skip-permissions'));
});

test('structuredOutputOf reads the structured output of the result', () => {
  const stdout = JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: { verdict: 'ready', comment: 'ok' } });
  assert.deepEqual(structuredOutputOf(stdout), { verdict: 'ready', comment: 'ok' });
  assert.throws(() => structuredOutputOf(JSON.stringify({ is_error: true, result: 'Credit balance too low' })), /claude failed: Credit balance too low/);
  assert.throws(() => structuredOutputOf(JSON.stringify({ is_error: false, result: 'plain text' })), /no structured output: plain text/);
  assert.throws(() => structuredOutputOf('not json'), /no JSON result/);
});

const prRequest: PrReviewRequest = {
  task: { title: 'Add VAT', specification: 'Add VAT to invoices.' },
  pullRequest: { url: 'https://github.com/acme/billing/pull/7', headSha: 'abc' },
};

test('parsePrReviewRequest accepts a request and names the first bad field', () => {
  assert.equal(parsePrReviewRequest(prRequest), prRequest);
  assert.throws(() => parsePrReviewRequest({ ...prRequest, task: { title: 'x' } }), /task.specification must be a string/);
  assert.throws(() => parsePrReviewRequest({ ...prRequest, pullRequest: { url: 'u' } }), /pullRequest.headSha must be a string/);
  assert.throws(() => parsePrReviewRequest([]), /request must be an object/);
});

test('prPrompt names the pull request and its head, then the task', () => {
  assert.equal(
    prPrompt(prRequest),
    [
      '# Pull request to review: https://github.com/acme/billing/pull/7',
      '',
      'Head commit: abc',
      '',
      '# Task the pull request was opened for: Add VAT',
      '',
      'Add VAT to invoices.',
    ].join('\n'),
  );
  assert.match(prPrompt({ ...prRequest, task: { title: 'T', specification: ' ' } }), /\(empty\)$/);
});

const inputRequest: InputReviewRequest = {
  project: { title: 'Billing', description: 'Invoices for customers.' },
  task: {
    title: 'Add VAT',
    specification: 'Add VAT to invoices.',
    repoUrl: 'https://github.com/acme/billing',
    plan: [{ title: 'Add rates', status: 'in_progress' }],
    questions: [
      { id: 'q1', createdAt: 't', problem: 'Which currency?', type: 'text', options: [], answer: ['EUR'] },
      { id: 'q2', createdAt: 't', problem: 'Which rate?', type: 'radio', options: ['19%', '7%'] },
    ],
    decisions: [
      { id: 'd0', createdAt: 't', problem: 'Round?', options: ['up', 'down'], chosen: 0, reasoning: 'Law.', approval: { status: 'approved', chosen: 1 } },
      { id: 'd1', createdAt: 't', problem: 'Store rates?', options: ['table', 'config'], chosen: 0, reasoning: 'Rates change.', approval: { status: 'pending' } },
    ],
    artifacts: [{ id: 'a1', createdAt: 't', title: 'Design', kind: 'markdown', content: 'Rates in a table.', approval: { status: 'approved', comment: 'ok' } }],
    pullRequests: [{ url: 'https://github.com/acme/billing/pull/7', title: 'Add VAT', status: 'open' }],
  },
  openIds: ['q2', 'd1'],
};

test('parseInputReviewRequest accepts a request and names the first bad field', () => {
  assert.equal(parseInputReviewRequest(inputRequest), inputRequest);
  assert.throws(() => parseInputReviewRequest({ ...inputRequest, task: { ...inputRequest.task, plan: {} } }), /task.plan must be an array/);
  assert.throws(() => parseInputReviewRequest({ ...inputRequest, openIds: [] }), /at least one item/);
  assert.throws(() => parseInputReviewRequest({ ...inputRequest, project: { title: 'x' } }), /project.description must be a string/);
});

test('inputPrompt puts the open items first, then the task with its earlier items, then the project', () => {
  assert.equal(
    inputPrompt(inputRequest),
    [
      '# Open items to decide on',
      '',
      '## q2: question (pick exactly one option)',
      '',
      'Which rate?',
      '',
      'Options:',
      '- 19%',
      '- 7%',
      '',
      '## d1: decision awaiting approval',
      '',
      'Store rates?',
      '1. table (chosen)',
      '2. config',
      'Reasoning: Rates change.',
      '',
      '# Task: Add VAT',
      '',
      "Repository: https://github.com/acme/billing (base branch: the repository's default branch)",
      '',
      '## Specification',
      '',
      'Add VAT to invoices.',
      '',
      '## Plan',
      '',
      '- [in_progress] Add rates',
      '',
      '## Pull requests',
      '',
      '- [open] Add VAT: https://github.com/acme/billing/pull/7',
      '',
      '## Earlier questions, decisions and artifacts',
      '',
      '- q1: Which currency?',
      '  Answer: EUR',
      '- d0: Round?',
      '  1. up (chosen)',
      '  2. down (picked in review)',
      '  Reasoning: Law.',
      '  Review: approved',
      '- a1: Design (markdown)',
      '  Review: approved, "ok"',
      '',
      '# Project: Billing',
      '',
      'Invoices for customers.',
    ].join('\n'),
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DomainError } from './errors.ts';
import {
  assertTaskProvidersUnclaimed,
  describeTaskProvider,
  gitHubIssueRepos,
  hasTaskProvider,
  isGitHubRepo,
  parseTaskProviderAttachment,
  parseTaskProviders,
  taskProviderKinds,
  taskProviderTypes,
  taskProvidersMax,
} from './task-provider.ts';

const invalid = (error: unknown): boolean => error instanceof DomainError && error.code === 'invalid_task_provider';
const gh = (repo: string) => ({ provider: 'github-issues', repo }) as const;

test('every registered kind has a type with a title and config fields', () => {
  assert.deepEqual(taskProviderKinds, ['github-issues']);
  assert.equal(taskProviderTypes['github-issues'].title, 'GitHub Issues');
  assert.deepEqual(
    taskProviderTypes['github-issues'].fields.map((field) => field.name),
    ['repo'],
  );
});

test('isGitHubRepo accepts owner/repo as GitHub allows it and nothing else', () => {
  for (const repo of ['acme/web', 'acme-corp/api.v2_x', 'o/r', 'A1/.github', `${'a'.repeat(39)}/${'r'.repeat(100)}`]) {
    assert.equal(isGitHubRepo(repo), true, repo);
  }
  const rejected = [
    '',
    'acme',
    'acme/web/x',
    'acme/',
    '/web',
    'ac me/web',
    ' acme/web',
    'acme/web ',
    'acme/..',
    'acme/.',
    'acme_x/web',
    '-acme/web',
    'acme-/web',
    'ac--me/web',
    `${'a'.repeat(40)}/web`,
    `acme/${'r'.repeat(101)}`,
    'https://github.com/acme/web',
    'acme/we$b',
  ];
  for (const repo of rejected) assert.equal(isGitHubRepo(repo), false, repo);
});

test('parseTaskProviderAttachment checks the provider and its config', () => {
  assert.deepEqual(parseTaskProviderAttachment({ provider: 'github-issues', repo: 'Acme/Web' }), gh('Acme/Web'));
  const rejected: unknown[] = [
    null,
    'github-issues',
    [],
    {},
    { provider: 'jira', repo: 'o/r' },
    { provider: 'github-issues' },
    { provider: 'github-issues', repo: 3 },
    { provider: 'github-issues', repo: 'o' },
    { provider: 'github-issues', repo: 'o/r', token: 't' },
  ];
  for (const value of rejected) assert.throws(() => parseTaskProviderAttachment(value), invalid, JSON.stringify(value));
});

test('parseTaskProviders refuses a non-list, too many attachments and one attached twice, ignoring case', () => {
  assert.deepEqual(parseTaskProviders([]), []);
  assert.deepEqual(parseTaskProviders([gh('o/r'), gh('o/s')]), [gh('o/r'), gh('o/s')]);
  assert.throws(() => parseTaskProviders(gh('o/r')), invalid);
  assert.throws(
    () => parseTaskProviders([gh('o/r'), gh('O/R')]),
    (error: unknown) => invalid(error) && /GitHub Issues O\/R is attached twice/.test(String(error)),
  );
  const many = Array.from({ length: taskProvidersMax + 1 }, (_, i) => gh(`o/r${i}`));
  assert.throws(() => parseTaskProviders(many), invalid);
  assert.equal(parseTaskProviders(many.slice(1)).length, taskProvidersMax);
});

test('describeTaskProvider names the provider and its source; hasTaskProvider ignores case', () => {
  assert.equal(describeTaskProvider(gh('acme/web')), 'GitHub Issues acme/web');
  assert.equal(hasTaskProvider([gh('acme/web')], gh('ACME/web')), true);
  assert.equal(hasTaskProvider([gh('acme/web')], gh('acme/api')), false);
});

test('assertTaskProvidersUnclaimed refuses a repository another project attaches, ignoring case, but not its own', () => {
  const projects = [
    { id: 'p1', taskProviders: [gh('o/r')] },
    { id: 'p2', taskProviders: [gh('o/s')] },
  ];
  assert.doesNotThrow(() => assertTaskProvidersUnclaimed([gh('o/r'), gh('x/y')], 'p1', projects));
  assert.doesNotThrow(() => assertTaskProvidersUnclaimed([], 'p3', projects));
  assert.throws(
    () => assertTaskProvidersUnclaimed([gh('x/y'), gh('O/S')], 'p1', projects),
    (error: unknown) =>
      error instanceof DomainError && error.code === 'task_provider_taken' && /GitHub Issues O\/S is already attached to project p2/.test(error.message),
  );
});

test('gitHubIssueRepos lists every attached repository once, first spelling first', () => {
  assert.deepEqual(gitHubIssueRepos([]), []);
  assert.deepEqual(
    gitHubIssueRepos([{ taskProviders: [gh('o/r'), gh('o/s')] }, { taskProviders: [] }, { taskProviders: [gh('O/R'), gh('x/y')] }]),
    ['o/r', 'o/s', 'x/y'],
  );
});

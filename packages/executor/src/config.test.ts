import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadBridgeConfig, loadRunnerConfig } from './config.ts';

const complete = {
  FACTORY_TASK_ID: 't1',
  FACTORY_REPO_URL: 'https://github.com/o/r',
  FACTORY_CONTROL_PLANE_URL: 'http://host.containers.internal:4700',
  FACTORY_TASK_TOKEN: 'task-secret',
  GIT_USER_NAME: 'Factory',
  GIT_USER_EMAIL: 'factory@example.com',
  ANTHROPIC_API_KEY: 'anthropic-secret',
  GITHUB_TOKEN: 'github-secret',
};

test('reads the runner configuration; the base branch is optional', () => {
  assert.equal(loadRunnerConfig(complete).baseBranch, undefined);
  assert.equal(loadRunnerConfig({ ...complete, FACTORY_BASE_BRANCH: 'develop' }).baseBranch, 'develop');
});

test('the model defaults to opus when unset or empty', () => {
  assert.equal(loadRunnerConfig(complete).model, 'opus');
  assert.equal(loadRunnerConfig({ ...complete, FACTORY_MODEL: ' ' }).model, 'opus');
  assert.equal(loadRunnerConfig({ ...complete, FACTORY_MODEL: 'opus' }).model, 'opus');
  assert.equal(loadRunnerConfig({ ...complete, FACTORY_MODEL: 'sonnet' }).model, 'sonnet');
});

test('rejects any other model', () => {
  for (const value of ['haiku', 'Sonnet', 'claude-opus-4']) {
    assert.throws(
      () => loadRunnerConfig({ ...complete, FACTORY_MODEL: value }),
      (error) => error instanceof ConfigError && /FACTORY_MODEL must be one of opus, sonnet/.test(error.message),
    );
  }
});

test('the repository is optional', () => {
  const { FACTORY_REPO_URL, ...withoutRepo } = complete;
  assert.equal('repoUrl' in loadRunnerConfig(withoutRepo), false);
});

test('lists every missing variable without printing secret values', () => {
  const { GITHUB_TOKEN, FACTORY_TASK_ID, ...partial } = complete;
  assert.throws(
    () => loadRunnerConfig({ ...partial, ANTHROPIC_API_KEY: ' ' }),
    (error) =>
      error instanceof ConfigError &&
      error.message ===
        'missing environment variables: FACTORY_TASK_ID, GITHUB_TOKEN, ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN' &&
      !error.message.includes('secret'),
  );
});

test('a subscription token replaces the API key', () => {
  const { ANTHROPIC_API_KEY, ...withoutKey } = complete;
  assert.equal(loadRunnerConfig({ ...withoutKey, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret' }).taskId, 't1');
});

test('the bridge needs only the control-plane URL and token', () => {
  assert.deepEqual(loadBridgeConfig({ FACTORY_CONTROL_PLANE_URL: 'http://cp', FACTORY_TASK_TOKEN: 'tok' }), {
    controlPlaneUrl: 'http://cp',
    taskToken: 'tok',
  });
  assert.throws(() => loadBridgeConfig({}), /FACTORY_CONTROL_PLANE_URL, FACTORY_TASK_TOKEN/);
});

test('shells are disabled unless FACTORY_SHELL_ENABLED is true', () => {
  assert.equal(loadRunnerConfig(complete).shellEnabled, false);
  assert.equal(loadRunnerConfig({ ...complete, FACTORY_SHELL_ENABLED: 'false' }).shellEnabled, false);
  assert.equal(loadRunnerConfig({ ...complete, FACTORY_SHELL_ENABLED: 'true' }).shellEnabled, true);
});

test('rejects any other FACTORY_SHELL_ENABLED value', () => {
  for (const value of ['', 'TRUE', '1', 'yes']) {
    assert.throws(
      () => loadRunnerConfig({ ...complete, FACTORY_SHELL_ENABLED: value }),
      (error) => error instanceof ConfigError && /FACTORY_SHELL_ENABLED must be true or false/.test(error.message),
    );
  }
});


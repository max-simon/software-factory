import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig, unavailableAgent } from './config.ts';

const complete = {
  ANTHROPIC_API_KEY: 'a',
  GITHUB_TOKEN: 'g',
  FACTORY_GIT_USER_NAME: 'bot',
  FACTORY_GIT_USER_EMAIL: 'bot@example.com',
};

test('applies defaults and keeps secrets out of the config', () => {
  const config = loadConfig(complete);
  assert.deepEqual(config, {
    port: 4700,
    dbPath: 'factory.db',
    image: 'factory-executor:latest',
    reviewerImage: 'factory-reviewer:latest',
    reviewerModel: 'sonnet',
    maxRunning: 2,
    gitUserName: 'bot',
    gitUserEmail: 'bot@example.com',
    followUpWindowHours: 24,
    credentials: ['ANTHROPIC_API_KEY'],
    agentCredentials: { claude: 'ANTHROPIC_API_KEY', opencode: 'ANTHROPIC_API_KEY' },
  });
});

test('names every missing required variable', () => {
  assert.throws(
    () => loadConfig({ FACTORY_GIT_USER_NAME: 'bot' }),
    (e: unknown) =>
      e instanceof ConfigError &&
      e.message === 'missing environment variables: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, GITHUB_TOKEN, FACTORY_GIT_USER_EMAIL',
  );
});

test('with only the API key, both agents use it', () => {
  const config = loadConfig(complete);
  assert.equal(unavailableAgent(config.agentCredentials, 'claude'), undefined);
  assert.equal(unavailableAgent(config.agentCredentials, 'opencode'), undefined);
});

test('with only a subscription token, claude uses it and opencode cannot run', () => {
  const { ANTHROPIC_API_KEY, ...withoutKey } = complete;
  const config = loadConfig({ ...withoutKey, CLAUDE_CODE_OAUTH_TOKEN: 'o' });
  assert.deepEqual(config.credentials, ['CLAUDE_CODE_OAUTH_TOKEN']);
  assert.deepEqual(config.agentCredentials, { claude: 'CLAUDE_CODE_OAUTH_TOKEN' });
  assert.equal(unavailableAgent(config.agentCredentials, 'claude'), undefined);
  assert.equal(unavailableAgent(config.agentCredentials, 'opencode'), 'agent opencode needs ANTHROPIC_API_KEY, which is not set');
});

test('with both credentials, claude gets only the subscription token and opencode only the API key', () => {
  const config = loadConfig({ ...complete, CLAUDE_CODE_OAUTH_TOKEN: 'o' });
  assert.deepEqual(config.credentials, ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
  assert.deepEqual(config.agentCredentials, { claude: 'CLAUDE_CODE_OAUTH_TOKEN', opencode: 'ANTHROPIC_API_KEY' });
});

test('ignores blank credentials', () => {
  const config = loadConfig({ ...complete, CLAUDE_CODE_OAUTH_TOKEN: ' ' });
  assert.deepEqual(config.credentials, ['ANTHROPIC_API_KEY']);
});

test('rejects an invalid port', () => {
  assert.throws(() => loadConfig({ ...complete, FACTORY_PORT: 'abc' }), ConfigError);
});

test('reads the running limit and rejects anything but a positive integer', () => {
  assert.equal(loadConfig({ ...complete, FACTORY_MAX_RUNNING: '5' }).maxRunning, 5);
  for (const value of ['0', '-1', '1.5', 'many']) {
    assert.throws(() => loadConfig({ ...complete, FACTORY_MAX_RUNNING: value }), ConfigError);
  }
});

test('no longer reads FACTORY_AGENT: the agent is chosen per task', () => {
  assert.deepEqual(loadConfig({ ...complete, FACTORY_AGENT: 'codex' }), loadConfig(complete));
});

test('reads the follow-up window, 24 hours by default, and rejects anything but a non-negative number', () => {
  assert.equal(loadConfig(complete).followUpWindowHours, 24);
  assert.equal(loadConfig({ ...complete, FACTORY_FOLLOW_UP_WINDOW_HOURS: '2.5' }).followUpWindowHours, 2.5);
  for (const value of ['-1', 'soon', 'Infinity']) {
    assert.throws(() => loadConfig({ ...complete, FACTORY_FOLLOW_UP_WINDOW_HOURS: value }), ConfigError);
  }
});


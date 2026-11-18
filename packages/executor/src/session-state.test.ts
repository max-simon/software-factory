import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createSessionStore, noTokens } from './session-state.ts';

const tokens = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 };

function directory(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'session-'));
  t.after(() => rmSync(dir, { recursive: true }));
  return dir;
}

test('loads nothing before the first save, then what was saved last', async (t) => {
  const store = createSessionStore(join(directory(t), 'nested', 'session.json'));
  assert.equal(await store.load(), undefined);
  await store.save({ sessionId: 'sid', costUsd: 0.5, tokens: noTokens });
  await store.save({ sessionId: 'sid', costUsd: 1.25, tokens });
  assert.deepEqual(await store.load(), { sessionId: 'sid', costUsd: 1.25, tokens });
});

test('a malformed file fails loudly instead of starting over', async (t) => {
  const path = join(directory(t), 'session.json');
  writeFileSync(path, JSON.stringify({ sessionId: '', costUsd: 1 }));
  await assert.rejects(createSessionStore(path).load(), /does not hold a session state/);
});

test('a state saved before tokens were tracked loads with zero tokens', async (t) => {
  const path = join(directory(t), 'session.json');
  writeFileSync(path, JSON.stringify({ sessionId: 'sid', costUsd: 1 }));
  assert.deepEqual(await createSessionStore(path).load(), { sessionId: 'sid', costUsd: 1, tokens: noTokens });
});

test('malformed tokens fail loudly', async (t) => {
  const path = join(directory(t), 'session.json');
  for (const malformed of [null, 3, { ...tokens, outputTokens: -1 }, { inputTokens: 1 }]) {
    writeFileSync(path, JSON.stringify({ sessionId: 'sid', costUsd: 1, tokens: malformed }));
    await assert.rejects(createSessionStore(path).load(), /does not hold a session state/, JSON.stringify(malformed));
  }
});

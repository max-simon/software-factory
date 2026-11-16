import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createSessionStore } from './session-state.ts';

function directory(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'session-'));
  t.after(() => rmSync(dir, { recursive: true }));
  return dir;
}

test('loads nothing before the first save, then what was saved last', async (t) => {
  const store = createSessionStore(join(directory(t), 'nested', 'session.json'));
  assert.equal(await store.load(), undefined);
  await store.save({ sessionId: 'sid', costUsd: 0.5 });
  await store.save({ sessionId: 'sid', costUsd: 1.25 });
  assert.deepEqual(await store.load(), { sessionId: 'sid', costUsd: 1.25 });
});

test('a malformed file fails loudly instead of starting over', async (t) => {
  const path = join(directory(t), 'session.json');
  writeFileSync(path, JSON.stringify({ sessionId: '', costUsd: 1 }));
  await assert.rejects(createSessionStore(path).load(), /does not hold a session state/);
});

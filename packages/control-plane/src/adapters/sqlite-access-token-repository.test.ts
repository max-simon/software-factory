import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccessToken } from '@factory/core';
import { SqliteAccessTokenRepository } from './sqlite-access-token-repository.ts';

const token = (id: string, userId: string, extra: Partial<AccessToken> = {}): AccessToken => ({
  id,
  userId,
  name: `token ${id}`,
  createdAt: '2026-11-12T10:00:00.000Z',
  ...extra,
});

test('inserts, finds by hash, lists, touches and deletes tokens', () => {
  const repo = new SqliteAccessTokenRepository(':memory:');
  const t1 = token('t1', 'u1', { expiresAt: '2026-12-12T10:00:00.000Z' });
  repo.insert(t1, 'h1');
  repo.insert(token('t2', 'u1'), 'h2');
  repo.insert(token('t3', 'u2'), 'h3');
  assert.deepEqual(repo.getByHash('h1'), t1);
  assert.equal(repo.getByHash('t1'), undefined);
  assert.deepEqual(repo.getByHash('h2'), token('t2', 'u1'));
  assert.deepEqual(repo.listForUser('u1').map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(repo.listForUser('nobody'), []);
  repo.touch('t1', '2026-11-12T11:00:00.000Z');
  assert.equal(repo.getByHash('h1')?.lastUsedAt, '2026-11-12T11:00:00.000Z');
  assert.equal(repo.delete('u2', 't1'), false, 'not the owner');
  assert.equal(repo.delete('u1', 't1'), true);
  assert.equal(repo.delete('u1', 't1'), false);
  assert.equal(repo.getByHash('h1'), undefined);
  repo.deleteForUser('u1');
  assert.deepEqual(repo.listForUser('u1'), []);
  assert.ok(repo.getByHash('h3'));
});

test('never returns the hash', () => {
  const repo = new SqliteAccessTokenRepository(':memory:');
  repo.insert(token('t1', 'u1'), 'secret-hash');
  assert.ok(!JSON.stringify([repo.getByHash('secret-hash'), repo.listForUser('u1')]).includes('secret-hash'));
});

test('shares a database file with other connections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-tokens-'));
  try {
    const path = join(dir, 'factory.db');
    const writer = new SqliteAccessTokenRepository(path);
    const reader = new SqliteAccessTokenRepository(path);
    writer.insert(token('t1', 'u1'), 'h1');
    assert.equal(reader.getByHash('h1')?.userId, 'u1');
    reader.deleteForUser('u1');
    assert.equal(writer.getByHash('h1'), undefined);
    writer.close();
    reader.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

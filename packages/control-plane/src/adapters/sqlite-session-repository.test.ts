import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '../auth/session-service.ts';
import { SqliteSessionRepository } from './sqlite-session-repository.ts';

const session = (idHash: string, userId: string, lastSeenAt: string, expiresAt: string): Session => ({
  idHash,
  userId,
  createdAt: '2026-11-12T10:00:00.000Z',
  lastSeenAt,
  expiresAt,
});

test('inserts, gets, touches and deletes sessions', () => {
  const repo = new SqliteSessionRepository(':memory:');
  const s1 = session('h1', 'u1', '2026-11-12T10:00:00.000Z', '2026-11-19T10:00:00.000Z');
  repo.insert(s1);
  repo.insert(session('h2', 'u1', '2026-11-12T10:00:00.000Z', '2026-11-19T10:00:00.000Z'));
  repo.insert(session('h3', 'u2', '2026-11-12T10:00:00.000Z', '2026-11-19T10:00:00.000Z'));
  assert.deepEqual(repo.get('h1'), s1);
  assert.equal(repo.get('missing'), undefined);
  repo.touch('h1', '2026-11-12T11:00:00.000Z');
  assert.equal(repo.get('h1')?.lastSeenAt, '2026-11-12T11:00:00.000Z');
  repo.delete('h1');
  assert.equal(repo.get('h1'), undefined);
  repo.deleteForUser('u1');
  assert.equal(repo.get('h2'), undefined);
  assert.ok(repo.get('h3'));
});

test('deletes sessions that ended or went idle', () => {
  const repo = new SqliteSessionRepository(':memory:');
  repo.insert(session('ended', 'u1', '2026-11-12T10:00:00.000Z', '2026-11-12T12:00:00.000Z'));
  repo.insert(session('idle', 'u1', '2026-11-12T08:00:00.000Z', '2026-11-19T10:00:00.000Z'));
  repo.insert(session('live', 'u1', '2026-11-12T11:00:00.000Z', '2026-11-19T10:00:00.000Z'));
  repo.deleteExpired('2026-11-12T12:00:00.000Z', '2026-11-12T09:00:00.000Z');
  assert.deepEqual(['ended', 'idle', 'live'].filter((id) => repo.get(id)), ['live']);
});

test('shares a database file with other connections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-sessions-'));
  try {
    const path = join(dir, 'factory.db');
    const writer = new SqliteSessionRepository(path);
    const reader = new SqliteSessionRepository(path);
    writer.insert(session('h1', 'u1', '2026-11-12T10:00:00.000Z', '2026-11-19T10:00:00.000Z'));
    assert.equal(reader.get('h1')?.userId, 'u1');
    reader.deleteForUser('u1');
    assert.equal(writer.get('h1'), undefined);
    writer.close();
    reader.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

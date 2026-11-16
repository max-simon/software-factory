import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { staticFiles } from './static-files.ts';

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'static-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<html>');
  await writeFile(join(dir, 'assets', 'app.js'), 'console.log(1)');
  await writeFile(join(dir, 'notes.txt'), 'secret');
  return dir;
}

test('serves index.html for / and files below the root with their content type', async () => {
  const files = staticFiles(await root());
  assert.deepEqual(await files('/'), { content: Buffer.from('<html>'), contentType: 'text/html; charset=utf-8' });
  assert.equal((await files('/assets/app.js'))?.contentType, 'text/javascript; charset=utf-8');
});

test('returns undefined for missing files, unknown types and paths outside the root', async () => {
  const dir = await root();
  const files = staticFiles(join(dir, 'assets'));
  assert.equal(await files('/missing.js'), undefined);
  assert.equal(await staticFiles(dir)('/notes.txt'), undefined);
  assert.equal(await files('/../index.html'), undefined);
  assert.equal(await staticFiles(join(dir, 'nope'))('/'), undefined);
});

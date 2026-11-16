import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { test } from 'node:test';
import { runCommand } from './run-command.ts';

test('captures output and exit code, in the given directory', async () => {
  const script = 'process.stdout.write(process.cwd()); process.stderr.write("err"); process.exit(3)';
  const result = await runCommand(process.execPath, ['-e', script], { cwd: tmpdir() });
  assert.deepEqual(result, { code: 3, stdout: realpathSync(tmpdir()), stderr: 'err' });
});

test('teed output is still captured', async () => {
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("")'], { teeOutput: true });
  assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
});

test('captured output keeps only its tail', async () => {
  const script = 'process.stdout.write("x".repeat(70 * 1024) + "end")';
  const result = await runCommand(process.execPath, ['-e', script]);
  assert.equal(result.stdout.length, 64 * 1024);
  assert.ok(result.stdout.endsWith('xend'));
});

test('hands over stdout line by line, across chunks, including an unterminated last line', async () => {
  const script = 'process.stdout.write("one\\ntw"); setTimeout(() => process.stdout.write("o\\n\\nthree"), 20)';
  const lines: string[] = [];
  const result = await runCommand(process.execPath, ['-e', script], { onStdoutLine: (line) => lines.push(line) });
  assert.deepEqual(lines, ['one', 'two', '', 'three']);
  assert.equal(result.stdout, 'one\ntwo\n\nthree');
});

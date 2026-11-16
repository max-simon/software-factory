import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { text } from 'node:stream/consumers';
import type { TaskModel } from '@factory/core';
import { claudeArgs, structuredOutputOf, type Role } from './claude.ts';
import { input } from './input.ts';
import { pr } from './pr.ts';
import { spec } from './spec.ts';

// Reads one request as JSON on stdin and prints one answer as JSON on stdout.
// The first argument picks the role: `spec` reviews a draft task's
// specification, `input` the open questions and approval requests of a
// supervised task, `pr` a pull request. Failures go to stderr with a non-zero
// exit code.

const roles: Record<string, Role> = { spec, input, pr };

const models: readonly TaskModel[] = ['opus', 'sonnet'];

function loadModel(env: NodeJS.ProcessEnv): TaskModel {
  // The claude CLI reads the credential itself, so its value never passes through our code.
  if (!env.ANTHROPIC_API_KEY?.trim() && !env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
    throw new Error('missing environment variables: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN');
  }
  const model = env.FACTORY_MODEL?.trim() || 'sonnet';
  if (!models.includes(model as TaskModel)) throw new Error(`FACTORY_MODEL must be opus or sonnet, got "${env.FACTORY_MODEL}"`);
  return model as TaskModel;
}

/** On a failed turn the CLI still prints its JSON result, which names the cause; only no output at all is an error here. */
function runClaude(args: readonly string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.on('error', reject);
    child.on('close', (code) => (stdout.trim() || code === 0 ? resolve(stdout) : reject(new Error(`claude exited with code ${code}`))));
    child.stdin.end(input);
  });
}

async function main(): Promise<void> {
  const roleName = process.argv[2] ?? '';
  if (!Object.hasOwn(roles, roleName)) throw new Error(`unknown role "${roleName}", expected one of ${Object.keys(roles).join(', ')}`);
  const role = roles[roleName]!;
  const model = loadModel(process.env);
  const missing = (role.requiredEnv ?? []).filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) throw new Error(`missing environment variables: ${missing.join(', ')}`);
  const prompt = role.prompt(JSON.parse(await text(process.stdin)));
  const args = claudeArgs(await readFile(role.systemPrompt, 'utf8'), model, role.schema, role.hasTools);
  const answer = role.parseAnswer(structuredOutputOf(await runClaude(args, prompt)));
  process.stdout.write(`${JSON.stringify(answer)}\n`);
}

main().catch((error: unknown) => {
  console.error(`reviewer failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

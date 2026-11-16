import type { TaskModel } from '@factory/core';

/** One kind of review: its instructions, the request it reads and the answer it gives. */
export interface Role {
  systemPrompt: URL;
  /** JSON schema the CLI makes the model answer in. */
  schema: object;
  /** Checks the request and turns it into the user message. */
  prompt(request: unknown): string;
  parseAnswer(value: unknown): unknown;
  /** The model gets tools to read for itself; none by default. */
  hasTools?: boolean;
  /** Variables the tools need besides the Anthropic credential. */
  requiredEnv?: readonly string[];
}

// All assumptions about the claude CLI live here.
/**
 * The prompt goes on stdin. Without tools the model judges text only. With
 * them it gets the default set and no permission prompts, which nobody could
 * answer; the container is the sandbox, and what the model should leave alone
 * is up to its instructions.
 */
export function claudeArgs(systemPrompt: string, model: TaskModel, schema: object, hasTools = false): string[] {
  const tools = hasTools ? ['--dangerously-skip-permissions'] : ['--tools', ''];
  return [
    '-p',
    '--model',
    model,
    '--system-prompt',
    systemPrompt,
    ...tools,
    // No MCP servers, nothing to resume.
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
  ];
}

interface ResultEvent {
  is_error?: unknown;
  result?: unknown;
  structured_output?: unknown;
}

/** Reads the structured output from the CLI's single `json` result; the caller checks its shape. */
export function structuredOutputOf(stdout: string): unknown {
  let event: ResultEvent;
  try {
    event = JSON.parse(stdout) as ResultEvent;
  } catch {
    throw new Error(`claude printed no JSON result: ${stdout.trim().slice(0, 500)}`);
  }
  if (event.is_error === true) throw new Error(`claude failed: ${String(event.result)}`);
  if (event.structured_output === undefined) throw new Error(`claude returned no structured output: ${String(event.result)}`);
  return event.structured_output;
}

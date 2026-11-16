// Turns the claude CLI's `--output-format stream-json` events into a short line
// for the engineer, e.g. "Running Bash: yarn test". Only the runner reads these
// events, so the agent spends no tokens on reporting what it is doing.
//
// The event shapes are the CLI's, not ours: every field is treated as optional
// and anything unrecognised yields no activity instead of an error.

import { factoryToolActivity, truncateActivity } from './activity.ts';

type Fields = Record<string, unknown>;

/** The activity a stream-json line shows, or undefined for lines that change nothing. */
export function activityOfLine(line: string): string | undefined {
  if (!line.startsWith('{')) return undefined;
  try {
    return activityOf(JSON.parse(line));
  } catch {
    return undefined;
  }
}

export function activityOf(event: unknown): string | undefined {
  if (!isFields(event)) return undefined;
  const activity = describe(event);
  return activity === undefined ? undefined : truncateActivity(activity);
}

function describe(event: Fields): string | undefined {
  switch (event.type) {
    case 'system':
      return event.subtype === 'init' ? 'Starting session' : undefined;
    case 'assistant':
      // The CLI emits one event per content block; the last block is the newest.
      return contentOf(event).map(describeBlock).filter((a) => a !== undefined).at(-1);
    case 'user':
      return contentOf(event).some((block) => block.type === 'tool_result') ? 'Processing tool result' : undefined;
    case 'result':
      return 'Turn finished';
    default:
      return undefined;
  }
}

function describeBlock(block: Fields): string | undefined {
  switch (block.type) {
    case 'tool_use':
      return typeof block.name === 'string' ? describeTool(block.name, isFields(block.input) ? block.input : {}) : undefined;
    case 'text':
      return 'Writing response';
    case 'thinking':
    case 'redacted_thinking':
      return 'Thinking';
    default:
      return undefined;
  }
}

// The input field that says most about a call of each built-in tool.
const hintFields: Record<string, readonly string[]> = {
  Bash: ['description', 'command'],
  Read: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  Write: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Grep: ['pattern'],
  Glob: ['pattern'],
  Agent: ['description'],
  Task: ['description'],
  WebFetch: ['url'],
  WebSearch: ['query'],
};

function describeTool(name: string, input: Fields): string {
  const factoryTool = /^mcp__factory__(.+)$/.exec(name)?.[1];
  if (factoryTool !== undefined) return factoryToolActivity(factoryTool);
  const hint = (hintFields[name] ?? []).map((key) => input[key]).find((v) => typeof v === 'string' && v.trim() !== '');
  return typeof hint === 'string' ? `Running ${name}: ${firstLine(hint)}` : `Running ${name}`;
}

function contentOf(event: Fields): Fields[] {
  const content = isFields(event.message) ? event.message.content : undefined;
  return Array.isArray(content) ? content.filter(isFields) : [];
}

const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);

const firstLine = (text: string): string => text.trim().split('\n')[0]!.replace(/\s+/g, ' ');

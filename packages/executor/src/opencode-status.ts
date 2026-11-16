// Turns opencode server events into a short line for the engineer, like
// claude-status.ts does for the claude CLI. The server runs for this task only,
// so every session's events count, subagent sessions included.
//
// The event shapes are opencode's: anything unrecognised yields no activity.

import { factoryToolActivity, truncateActivity } from './activity.ts';

type Fields = Record<string, unknown>;

export function activityOfEvent(event: unknown): string | undefined {
  if (!isFields(event)) return undefined;
  const activity = describe(event);
  return activity === undefined ? undefined : truncateActivity(activity);
}

function describe(event: Fields): string | undefined {
  switch (event.type) {
    case 'session.execution.started':
      return 'Starting turn';
    case 'session.reasoning.started':
      return 'Thinking';
    case 'session.text.started':
      return 'Writing response';
    case 'session.tool.input.started': {
      const name = isFields(event.data) ? event.data.name : undefined;
      return typeof name === 'string' ? describeTool(name) : undefined;
    }
    case 'session.idle':
      return 'Turn finished';
    default:
      return undefined;
  }
}

// MCP tools are named `<server>_<tool>` when Code Mode is off for the server.
function describeTool(name: string): string {
  const factoryTool = /^factory_(.+)$/.exec(name)?.[1];
  return factoryTool !== undefined ? factoryToolActivity(factoryTool) : `Running ${name}`;
}

const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);

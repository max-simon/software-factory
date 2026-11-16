// Activity lines the engineer sees while an agent works, shared by the adapters.

const maxActivityLength = 120;

const factoryTools: Record<string, string> = {
  report_plan: 'Reporting plan',
  report_decision: 'Reporting decision',
  report_artifact: 'Reporting artifact',
  report_pull_request: 'Reporting pull request',
  ask_question: 'Asking a question',
  report_ready: 'Reporting ready',
  report_failure: 'Reporting failure',
};

/** The activity for a call of a `factory` MCP tool, given its unprefixed name. */
export const factoryToolActivity = (tool: string): string => factoryTools[tool] ?? `Running ${tool}`;

export const truncateActivity = (text: string): string =>
  text.length > maxActivityLength ? `${text.slice(0, maxActivityLength - 1)}…` : text;

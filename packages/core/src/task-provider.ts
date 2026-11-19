import { DomainError } from './errors.ts';

/**
 * External task providers a project can attach: their issues become the
 * project's managed tasks. Only GitHub Issues so far; a provider is one
 * variant of `TaskProviderAttachment` plus its entry in `taskProviderTypes`.
 */
export interface GitHubIssuesAttachment {
  provider: 'github-issues';
  /** `owner/repo` as the engineer wrote it; GitHub matches it case-insensitively. */
  repo: string;
}

export type TaskProviderAttachment = GitHubIssuesAttachment;
export type TaskProviderKind = TaskProviderAttachment['provider'];

/** A config field the project form asks for; `name` is its key in the attachment. */
export interface TaskProviderField {
  name: string;
  label: string;
  placeholder: string;
}

export interface TaskProviderType<A extends TaskProviderAttachment> {
  title: string;
  fields: readonly TaskProviderField[];
  /** The attachment for these config fields, or a `DomainError` `invalid_task_provider`. */
  parse(config: Readonly<Record<string, unknown>>): A;
  /** What the attachment points at, e.g. `owner/repo`. */
  describe(attachment: A): string;
  /** Equal for attachments that point at the same source, so a project attaches each once. */
  identity(attachment: A): string;
}

/** At most this many attachments per project; each costs a provider call per sync pass. */
export const taskProvidersMax = 20;

// GitHub's rules: an owner is 1–39 alphanumerics or single inner hyphens; a repository 1–100 of [A-Za-z0-9._-], not `.` or `..`.
const ownerPattern = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/;
const repoPattern = /^[\w.-]{1,100}$/;

/** Whether `value` is a GitHub `owner/repo`, exactly as written. */
export function isGitHubRepo(value: string): boolean {
  const [owner, repo, ...rest] = value.split('/');
  if (owner === undefined || repo === undefined || rest.length > 0) return false;
  return ownerPattern.test(owner) && repoPattern.test(repo) && repo !== '.' && repo !== '..';
}

const gitHubIssues: TaskProviderType<GitHubIssuesAttachment> = {
  title: 'GitHub Issues',
  fields: [{ name: 'repo', label: 'Repository', placeholder: 'owner/repo' }],
  parse(config) {
    rejectUnknown(config, ['repo']);
    const { repo } = config;
    if (typeof repo !== 'string' || !isGitHubRepo(repo)) {
      throw new DomainError('invalid_task_provider', `repo must be a GitHub repository as owner/repo, got ${JSON.stringify(repo)}`);
    }
    return { provider: 'github-issues', repo };
  },
  describe: ({ repo }) => repo,
  identity: ({ repo }) => `github-issues:${repo.toLowerCase()}`,
};

/** The registered providers, by kind, in the order the project form offers them. */
export const taskProviderTypes: { readonly [K in TaskProviderKind]: TaskProviderType<Extract<TaskProviderAttachment, { provider: K }>> } = {
  'github-issues': gitHubIssues,
};

export const taskProviderKinds: readonly TaskProviderKind[] = ['github-issues'];

const isKind = (value: unknown): value is TaskProviderKind => taskProviderKinds.some((kind) => kind === value);

function rejectUnknown(config: Readonly<Record<string, unknown>>, known: readonly string[]): void {
  const unknown = Object.keys(config).filter((key) => !known.includes(key));
  if (unknown.length > 0) throw new DomainError('invalid_task_provider', `unknown task provider fields: ${unknown.join(', ')}`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One attachment, `{ provider, ...config }`, checked by its provider's type. */
export function parseTaskProviderAttachment(value: unknown): TaskProviderAttachment {
  if (!isRecord(value)) throw new DomainError('invalid_task_provider', 'a task provider must be an object');
  const { provider, ...config } = value;
  if (!isKind(provider)) {
    throw new DomainError('invalid_task_provider', `provider must be one of ${taskProviderKinds.join(', ')}`);
  }
  return taskProviderTypes[provider].parse(config);
}

/** A project's whole list of attachments: each valid, at most `taskProvidersMax`, none twice. */
export function parseTaskProviders(value: unknown): TaskProviderAttachment[] {
  if (!Array.isArray(value)) throw new DomainError('invalid_task_provider', 'taskProviders must be an array');
  if (value.length > taskProvidersMax) {
    throw new DomainError('invalid_task_provider', `a project attaches at most ${taskProvidersMax} task providers`);
  }
  const attachments = value.map(parseTaskProviderAttachment);
  const seen = new Set<string>();
  for (const attachment of attachments) {
    const identity = taskProviderTypes[attachment.provider].identity(attachment);
    if (seen.has(identity)) {
      throw new DomainError('invalid_task_provider', `${describeTaskProvider(attachment)} is attached twice`);
    }
    seen.add(identity);
  }
  return attachments;
}

/** E.g. `GitHub Issues owner/repo`. */
export function describeTaskProvider(attachment: TaskProviderAttachment): string {
  const type = taskProviderTypes[attachment.provider];
  return `${type.title} ${type.describe(attachment)}`;
}

export function hasTaskProvider(list: readonly TaskProviderAttachment[], attachment: TaskProviderAttachment): boolean {
  const identity = taskProviderTypes[attachment.provider].identity(attachment);
  return list.some((candidate) => taskProviderTypes[candidate.provider].identity(candidate) === identity);
}

/** The `owner/repo` of every GitHub Issues attachment of `projects`, each once (case-insensitively), in order. */
export function gitHubIssueRepos(projects: readonly { taskProviders: readonly TaskProviderAttachment[] }[]): string[] {
  const repos = new Map<string, string>();
  for (const { taskProviders } of projects) {
    for (const attachment of taskProviders) {
      if (attachment.provider !== 'github-issues') continue;
      const key = attachment.repo.toLowerCase();
      if (!repos.has(key)) repos.set(key, attachment.repo);
    }
  }
  return [...repos.values()];
}

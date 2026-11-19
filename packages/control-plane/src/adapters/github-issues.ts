import { DatabaseSync } from 'node:sqlite';
import type { ExternalIssue, IssueProvider } from '@factory/core';
import { apiBase, nextPage, requestGitHub } from './github-api.ts';

/** GitHub refuses a comment body longer than this many characters. */
export const commentMaxLength = 65_536;
const truncationNote = '\n\n*Truncated: this comment exceeded the length GitHub accepts.*';

// The keys of posted comments, so a comment is posted at most once per (url, key).
const schema = `
  CREATE TABLE IF NOT EXISTS issue_comments (
    url TEXT NOT NULL,
    key TEXT NOT NULL,
    posted_at TEXT NOT NULL,
    PRIMARY KEY (url, key)
  );
`;

const namePattern = /^[\w.-]+$/;

interface IssueRef {
  owner: string;
  repo: string;
  number: string;
}

export interface GitHubIssuesOptions {
  token: string;
  /** `owner/repo` of each repository to look for issues in. */
  repos: readonly string[];
  /** The SQLite file the other repositories use. */
  dbPath: string;
  /** Issue URLs on any other host are refused. */
  host?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Lists, labels and comments on GitHub issues through the REST API with the
 * token the execution servers use.
 */
export class GitHubIssues implements IssueProvider {
  readonly #token: string;
  readonly #repos: readonly string[];
  readonly #host: string;
  readonly #fetch: typeof fetch;
  readonly #db: DatabaseSync;

  constructor({ token, repos, dbPath, host = 'github.com', fetchImpl = fetch }: GitHubIssuesOptions) {
    this.#token = token;
    this.#repos = repos;
    this.#host = host;
    this.#fetch = fetchImpl;
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec('PRAGMA busy_timeout = 5000;');
    this.#db.exec(schema);
  }

  async listIssues(label: string): Promise<ExternalIssue[]> {
    // GitHub reads `labels` as a comma-separated list of labels an issue must all carry.
    if (label.includes(',')) throw new Error(`cannot list issues by a label containing a comma: ${label}`);
    const issues: ExternalIssue[] = [];
    for (const repo of this.#repos) {
      let next: string | undefined =
        `${apiBase(this.#host)}/repos/${repo}/issues?labels=${encodeURIComponent(label)}&state=all&per_page=100`;
      while (next !== undefined) {
        const response: Response = await requestGitHub(this.#fetch, this.#token, next, `issues of ${repo}`);
        const page: unknown = await response.json();
        if (!Array.isArray(page)) throw new Error(`GitHub returned no issue list for ${repo}`);
        for (const item of page) {
          // The issues endpoint lists pull requests too.
          if (isRecord(item) && item.pull_request !== undefined) continue;
          issues.push(this.#toIssue(item, repo));
        }
        next = nextPage(response.headers.get('link'));
      }
    }
    return issues;
  }

  async changeLabels(url: string, change: { add: string[]; remove: string[] }): Promise<void> {
    const issueApi = this.#issueApi(url);
    for (const label of change.remove) {
      await requestGitHub(this.#fetch, this.#token, `${issueApi}/labels/${encodeURIComponent(label)}`, url, {
        method: 'DELETE',
        // The issue does not carry the label.
        isNotFoundOk: true,
      });
    }
    if (change.add.length === 0) return;
    await requestGitHub(this.#fetch, this.#token, `${issueApi}/labels`, url, { method: 'POST', body: { labels: change.add } });
  }

  /** Records the key only once GitHub accepted the comment: a crash in between may post it twice, never lose it. */
  async comment(url: string, key: string, body: string): Promise<void> {
    const issueApi = this.#issueApi(url);
    if (this.#db.prepare('SELECT 1 FROM issue_comments WHERE url = ? AND key = ?').get(url, key) !== undefined) return;
    await requestGitHub(this.#fetch, this.#token, `${issueApi}/comments`, url, { method: 'POST', body: { body: truncate(body) } });
    this.#db
      .prepare('INSERT OR IGNORE INTO issue_comments (url, key, posted_at) VALUES (?, ?, ?)')
      .run(url, key, new Date().toISOString());
  }

  close(): void {
    this.#db.close();
  }

  /**
   * The repository comes from the issue's own `html_url`, never from its text
   * or from `queriedRepo`: GitHub lists a transferred issue under its new repository.
   */
  #toIssue(item: unknown, queriedRepo: string): ExternalIssue {
    if (!isRecord(item)) throw new Error(`GitHub returned an issue of ${queriedRepo} that is not an object`);
    const { html_url: url, number, title, body, labels, state } = item;
    const name = typeof url === 'string' ? url : `${queriedRepo}#${String(number)}`;
    const ref = typeof url === 'string' ? this.#parseIssueUrl(url) : undefined;
    if (ref === undefined || typeof url !== 'string') throw new Error(`cannot derive the repository of GitHub issue ${name}`);
    if (typeof title !== 'string') throw new Error(`GitHub returned no title for ${name}`);
    if (body !== null && body !== undefined && typeof body !== 'string') throw new Error(`GitHub returned an invalid body for ${name}`);
    if (state !== 'open' && state !== 'closed') throw new Error(`GitHub returned an unknown state for ${name}: ${String(state)}`);
    return {
      provider: 'github',
      url,
      key: `${ref.owner}/${ref.repo}#${ref.number}`,
      repoUrl: `https://${this.#host}/${ref.owner}/${ref.repo}`,
      title,
      body: body ?? '',
      labels: labelNames(labels, name),
      isOpen: state === 'open',
    };
  }

  #issueApi(url: string): string {
    const ref = this.#parseIssueUrl(url);
    if (ref === undefined) throw new Error(`not a GitHub issue URL on ${this.#host}: ${url}`);
    return `${apiBase(this.#host)}/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;
  }

  /** Accepts only `https://<host>/<owner>/<repo>/issues/<number>` on the configured host. */
  #parseIssueUrl(url: string): IssueRef | undefined {
    if (!URL.canParse(url)) return undefined;
    const { protocol, host, pathname, search, hash } = new URL(url);
    if (protocol !== 'https:' || host !== this.#host || search !== '' || hash !== '') return undefined;
    const [owner, repo, kind, number, ...rest] = pathname.split('/').slice(1);
    if (owner === undefined || repo === undefined || number === undefined || rest.length > 0 || kind !== 'issues') return undefined;
    if (!namePattern.test(owner) || !namePattern.test(repo) || repo === '.' || repo === '..') return undefined;
    if (!/^[1-9]\d*$/.test(number)) return undefined;
    return { owner, repo, number };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** GitHub documents a label as either its name or an object with one. */
function labelNames(labels: unknown, name: string): string[] {
  if (!Array.isArray(labels)) throw new Error(`GitHub returned no label list for ${name}`);
  return labels.map((label: unknown) => {
    if (typeof label === 'string') return label;
    if (isRecord(label) && typeof label.name === 'string') return label.name;
    throw new Error(`GitHub returned an invalid label for ${name}`);
  });
}

/** Cuts the body so that it and the note fit, without splitting a surrogate pair. */
function truncate(body: string): string {
  if (body.length <= commentMaxLength) return body;
  let end = commentMaxLength - truncationNote.length;
  const last = body.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return body.slice(0, end) + truncationNote;
}

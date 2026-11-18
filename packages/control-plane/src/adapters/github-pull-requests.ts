import type {
  PullRequest,
  PullRequestReader,
  PullRequestReview,
  PullRequestReviewState,
  PullRequestWriter,
} from '@factory/core';

const reviewStates: Record<string, PullRequestReviewState> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
};

/**
 * Reviewers with a say on the repository: anyone can review a pull request of
 * a public repository. GitHub's own review decision counts these only too.
 */
const trustedAssociations: ReadonlySet<unknown> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

interface GitHubReview {
  id?: unknown;
  state?: unknown;
  author_association?: unknown;
  user?: { login?: unknown } | null;
  body?: unknown;
  html_url?: unknown;
  submitted_at?: unknown;
}

/**
 * Reads, comments on and merges pull requests through GitHub's REST API with the token the
 * execution servers use. GitHub Enterprise hosts serve the same API under /api/v3.
 */
export class GitHubPullRequests implements PullRequestReader, PullRequestWriter {
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(token: string, fetchImpl: typeof fetch = fetch) {
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  async read(url: string): Promise<PullRequest> {
    const base = apiUrl(url);
    const { body } = await this.#get(base, url);
    const { state, merged, mergeable, title, user, base: target } = body as {
      state?: unknown;
      merged?: unknown;
      mergeable?: unknown;
      title?: unknown;
      user?: { login?: unknown };
      base?: { ref?: unknown };
    };
    if (state !== 'open' && state !== 'closed') throw new Error(`GitHub returned an unknown state for ${url}: ${String(state)}`);
    if (typeof title !== 'string' || title.trim() === '') throw new Error(`GitHub returned no title for ${url}`);
    const headSha = headShaOf(body, url);
    const reviews = (await this.#listReviews(`${base}/reviews?per_page=100`, url))
      .filter((review) => trustedAssociations.has(review.author_association))
      .map(toReview)
      // The author cannot review their own pull request; GitHub files the
      // author's replies to review threads as reviews, which they are not.
      .filter((review): review is PullRequestReview => review !== undefined && review.author !== user?.login);
    return {
      url,
      title,
      status: merged === true ? 'merged' : state,
      headSha,
      reviews,
      // GitHub computes mergeability in the background and answers null until it has.
      ...(typeof mergeable === 'boolean' && { hasConflicts: !mergeable }),
      ...(typeof target?.ref === 'string' && { baseBranch: target.ref }),
    };
  }

  async readHead(url: string): Promise<string> {
    const { body } = await this.#get(apiUrl(url), url);
    return headShaOf(body, url);
  }

  /** A conversation comment, not a review: `read` lists reviews only, so it never counts as one. */
  async comment(url: string, body: string): Promise<void> {
    await this.#request(apiUrl(url).replace(/\/pulls\/(\d+)$/, '/issues/$1/comments'), url, { method: 'POST', body: { body } });
  }

  /** Creates a merge commit, GitHub's default; a repository that allows only squash or rebase refuses it. */
  async merge(url: string, headSha: string): Promise<void> {
    await this.#request(`${apiUrl(url)}/merge`, url, { method: 'PUT', body: { sha: headSha } });
  }

  /** GitHub lists reviews oldest first, so new ones are on the last page. */
  async #listReviews(firstPage: string, url: string): Promise<GitHubReview[]> {
    const reviews: GitHubReview[] = [];
    let next: string | undefined = firstPage;
    while (next !== undefined) {
      const page: { body: unknown; next: string | undefined } = await this.#get(next, url);
      if (!Array.isArray(page.body)) throw new Error(`GitHub returned no review list for ${url}`);
      reviews.push(...(page.body as GitHubReview[]));
      next = page.next;
    }
    return reviews;
  }

  async #get(apiRequestUrl: string, url: string): Promise<{ body: unknown; next: string | undefined }> {
    const response = await this.#request(apiRequestUrl, url);
    return { body: await response.json(), next: nextPage(response.headers.get('link')) };
  }

  async #request(apiRequestUrl: string, url: string, options: { method?: 'GET' | 'POST' | 'PUT'; body?: object } = {}): Promise<Response> {
    const { method = 'GET', body } = options;
    const response = await this.#fetch(apiRequestUrl, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        // GitHub rejects requests without one.
        'user-agent': 'agentic-software-factory',
        ...(body && { 'content-type': 'application/json' }),
      },
      ...(body && { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${url}: ${(await response.text()).slice(0, 200)}`);
    return response;
  }
}

function headShaOf(pull: unknown, url: string): string {
  const sha = (pull as { head?: { sha?: unknown } }).head?.sha;
  if (typeof sha !== 'string') throw new Error(`GitHub returned no head commit for ${url}`);
  return sha;
}

/** Pending and dismissed reviews, and entries without the fields a review needs, are skipped. */
function toReview(review: GitHubReview): PullRequestReview | undefined {
  const state = typeof review.state === 'string' ? reviewStates[review.state] : undefined;
  const author = review.user?.login;
  const { id, html_url: url, submitted_at: submittedAt } = review;
  if (state === undefined || typeof id !== 'number' || typeof author !== 'string') return undefined;
  if (typeof url !== 'string' || typeof submittedAt !== 'string') return undefined;
  return { id, state, author, body: typeof review.body === 'string' ? review.body : '', url, submittedAt };
}

/** The `rel="next"` target of GitHub's Link header. */
function nextPage(link: string | null): string | undefined {
  return link
    ?.split(',')
    .map((part) => /<([^>]+)>;\s*rel="next"/.exec(part)?.[1])
    .find((target) => target !== undefined);
}

/** The core accepts only https://host/owner/repo/pull/number URLs for pull requests. */
function apiUrl(pullRequestUrl: string): string {
  const { host, pathname } = new URL(pullRequestUrl);
  const [owner, repo, , number] = pathname.split('/').filter(Boolean);
  const base = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
  return `${base}/repos/${owner}/${repo}/pulls/${number}`;
}

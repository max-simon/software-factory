/** GitHub Enterprise hosts serve the same REST API under /api/v3. */
export function apiBase(host: string): string {
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
}

/** The `rel="next"` target of GitHub's Link header. */
export function nextPage(link: string | null): string | undefined {
  return link
    ?.split(',')
    .map((part) => /<([^>]+)>;\s*rel="next"/.exec(part)?.[1])
    .find((target) => target !== undefined);
}

export interface GitHubRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: object;
  /** Answers 404 without throwing, for deletes that may find nothing to delete. */
  isNotFoundOk?: boolean;
}

/** Sends one request with the token; throws, naming `subject`, when GitHub answers with an error status. */
export async function requestGitHub(
  fetchImpl: typeof fetch,
  token: string,
  apiRequestUrl: string,
  subject: string,
  options: GitHubRequest = {},
): Promise<Response> {
  const { method = 'GET', body, isNotFoundOk = false } = options;
  const response = await fetchImpl(apiRequestUrl, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      // GitHub rejects requests without one.
      'user-agent': 'agentic-software-factory',
      ...(body && { 'content-type': 'application/json' }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  if (response.ok || (isNotFoundOk && response.status === 404)) return response;
  throw new Error(`GitHub answered ${response.status} for ${subject}: ${(await response.text()).slice(0, 200)}`);
}

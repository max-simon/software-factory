import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubPullRequests } from './github-pull-requests.ts';

interface Answer {
  status?: number;
  body: unknown;
  link?: string;
}

/** Answers the pull request with `pull` and each reviews page with the next of `reviewPages`. */
function setup(pull: Answer, reviewPages: Answer[] = [{ body: [] }]) {
  const requests: Array<{ url: string; method: string | undefined; headers: Record<string, string>; body: unknown }> = [];
  const pages = [...reviewPages];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method,
      headers: init?.headers as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const { status = 200, body, link } = String(url).includes('/reviews') ? pages.shift()! : pull;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      ...(link && { headers: { link } }),
    });
  }) as typeof fetch;
  return { reader: new GitHubPullRequests('gh-token', fetchImpl), requests };
}

const url = 'https://github.com/o/r/pull/7';
const pull = (fields: Record<string, unknown> = {}): Answer => ({
  body: { state: 'open', merged: false, title: 'Add x', user: { login: 'factory-bot' }, ...fields },
});
const gitHubReview = (id: number, state: string, login = 'alice', association = 'COLLABORATOR') => ({
  id,
  state,
  author_association: association,
  user: { login },
  body: `body ${id}`,
  html_url: `${url}#pullrequestreview-${id}`,
  submitted_at: '2026-11-14T10:00:00Z',
});
const review = (id: number, state: string) => ({
  id,
  state,
  author: 'alice',
  body: `body ${id}`,
  url: `${url}#pullrequestreview-${id}`,
  submittedAt: '2026-11-14T10:00:00Z',
});

test('read asks the GitHub API with the token and maps open, merged and closed', async () => {
  const open = setup(pull());
  assert.deepEqual(await open.reader.read(url), { url, title: 'Add x', status: 'open', reviews: [] });
  assert.equal(open.requests[0]!.url, 'https://api.github.com/repos/o/r/pulls/7');
  assert.equal(open.requests[0]!.headers.authorization, 'Bearer gh-token');
  assert.equal(open.requests[1]!.url, 'https://api.github.com/repos/o/r/pulls/7/reviews?per_page=100');
  assert.equal(open.requests[1]!.headers.authorization, 'Bearer gh-token');
  assert.equal((await setup(pull({ state: 'closed', merged: true })).reader.read(url)).status, 'merged');
  assert.equal((await setup(pull({ state: 'closed', merged: false })).reader.read(url)).status, 'closed');
});

test('read skips reviews by people without a say on the repository', async () => {
  const { reader } = setup(pull(), [
    {
      body: [
        gitHubReview(1, 'COMMENTED', 'alice', 'OWNER'),
        gitHubReview(2, 'COMMENTED', 'alice', 'MEMBER'),
        gitHubReview(3, 'COMMENTED', 'alice', 'COLLABORATOR'),
        gitHubReview(4, 'COMMENTED', 'mallory', 'CONTRIBUTOR'),
        gitHubReview(5, 'COMMENTED', 'mallory', 'FIRST_TIME_CONTRIBUTOR'),
        gitHubReview(6, 'COMMENTED', 'mallory', 'NONE'),
        { ...gitHubReview(7, 'COMMENTED', 'mallory'), author_association: undefined },
      ],
    },
  ]);
  assert.deepEqual(
    (await reader.read(url)).reviews?.map((r) => r.id),
    [1, 2, 3],
  );
});

test('read maps submitted reviews and skips pending, dismissed and the author’s own', async () => {
  const { reader } = setup(pull(), [
    {
      body: [
        gitHubReview(1, 'COMMENTED'),
        gitHubReview(2, 'PENDING'),
        gitHubReview(3, 'DISMISSED'),
        gitHubReview(4, 'COMMENTED', 'factory-bot'),
        gitHubReview(5, 'CHANGES_REQUESTED'),
        gitHubReview(6, 'APPROVED'),
      ],
    },
  ]);
  assert.deepEqual((await reader.read(url)).reviews, [
    review(1, 'commented'),
    review(5, 'changes_requested'),
    review(6, 'approved'),
  ]);
});

test('read follows the review pages GitHub links to', async () => {
  const second = 'https://api.github.com/repositories/1/pulls/7/reviews?per_page=100&page=2';
  const { reader, requests } = setup(pull(), [
    { body: [gitHubReview(1, 'COMMENTED')], link: `<${second}>; rel="next", <${second}>; rel="last"` },
    { body: [gitHubReview(2, 'APPROVED')], link: `<https://api.github.com/x?page=1>; rel="prev"` },
  ]);
  assert.deepEqual((await reader.read(url)).reviews, [review(1, 'commented'), review(2, 'approved')]);
  assert.equal(requests[2]!.url, second);
});

test('read uses /api/v3 on a GitHub Enterprise host', async () => {
  const { reader, requests } = setup(pull());
  await reader.read('https://git.example.com/o/r/pull/3');
  assert.equal(requests[0]!.url, 'https://git.example.com/api/v3/repos/o/r/pulls/3');
});

test('read throws on an error status or an unexpected body', async () => {
  await assert.rejects(setup({ status: 404, body: 'Not Found' }).reader.read(url), /GitHub answered 404 for .*: Not Found/);
  await assert.rejects(setup(pull({ state: 'draft' })).reader.read(url), /unknown state/);
  await assert.rejects(setup(pull({ title: '' })).reader.read(url), /no title/);
  await assert.rejects(setup(pull(), [{ status: 500, body: 'oops' }]).reader.read(url), /GitHub answered 500 for .*: oops/);
  await assert.rejects(setup(pull(), [{ body: { message: 'x' } }]).reader.read(url), /no review list/);
});

test('readHead reads the commit the head points to', async () => {
  const { reader, requests } = setup(pull({ head: { sha: 'abc' } }));
  assert.equal(await reader.readHead(url), 'abc');
  assert.equal(requests[0]!.url, 'https://api.github.com/repos/o/r/pulls/7');
  await assert.rejects(setup(pull()).reader.readHead(url), /no head commit/);
});

test('comment posts to the conversation of the pull request', async () => {
  const { reader, requests } = setup({ status: 201, body: {} });
  await reader.comment(url, 'Low risk.');
  assert.equal(requests[0]!.url, 'https://api.github.com/repos/o/r/issues/7/comments');
  assert.equal(requests[0]!.method, 'POST');
  assert.deepEqual(requests[0]!.body, { body: 'Low risk.' });
  assert.equal(requests[0]!.headers['content-type'], 'application/json');
});

test('merge puts to the merge endpoint pinned to the head and throws when GitHub refuses', async () => {
  const merged = setup({ body: { merged: true } });
  await merged.reader.merge(url, 'abc');
  assert.equal(merged.requests[0]!.url, 'https://api.github.com/repos/o/r/pulls/7/merge');
  assert.equal(merged.requests[0]!.method, 'PUT');
  assert.deepEqual(merged.requests[0]!.body, { sha: 'abc' });
  assert.equal(merged.requests[0]!.headers.authorization, 'Bearer gh-token');
  await assert.rejects(
    setup({ status: 409, body: 'Head branch was modified' }).reader.merge(url, 'abc'),
    /GitHub answered 409 for .*: Head branch was modified/,
  );
});

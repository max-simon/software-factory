import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { commentMaxLength, GitHubIssues } from './github-issues.ts';

interface Answer {
  status?: number;
  body: unknown;
  link?: string;
}

interface Request {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

/** Answers each request with the next of `answers`; once they run out, with an empty 200. */
function setup(answers: Answer[] = [], options: { host?: string; repos?: string[]; dbPath?: string } = {}) {
  const requests: Request[] = [];
  const queue = [...answers];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method,
      headers: init?.headers as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const { status = 200, body, link } = queue.shift() ?? { body: {} };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, ...(link && { headers: { link } }) });
  }) as typeof fetch;
  const issues = new GitHubIssues({
    token: 'gh-token',
    repos: options.repos ?? ['o/r'],
    dbPath: options.dbPath ?? ':memory:',
    ...(options.host && { host: options.host }),
    fetchImpl,
  });
  return { issues, requests };
}

const gitHubIssue = (number: number, fields: Record<string, unknown> = {}) => ({
  number,
  html_url: `https://github.com/o/r/issues/${number}`,
  repository_url: 'https://api.github.com/repos/o/r',
  title: `Issue ${number}`,
  body: `Body ${number}`,
  labels: [{ name: 'factory' }, { name: 'area: web' }],
  state: 'open',
  ...fields,
});

const issueUrl = 'https://github.com/o/r/issues/12';

test('listIssues asks for open and closed issues with the label and maps them', async () => {
  const { issues, requests } = setup([{ body: [gitHubIssue(1), gitHubIssue(2, { state: 'closed', body: null })] }]);
  assert.deepEqual(await issues.listIssues('factory: ready'), [
    {
      provider: 'github',
      url: 'https://github.com/o/r/issues/1',
      key: 'o/r#1',
      repoUrl: 'https://github.com/o/r',
      title: 'Issue 1',
      body: 'Body 1',
      labels: ['factory', 'area: web'],
      isOpen: true,
    },
    {
      provider: 'github',
      url: 'https://github.com/o/r/issues/2',
      key: 'o/r#2',
      repoUrl: 'https://github.com/o/r',
      title: 'Issue 2',
      body: '',
      labels: ['factory', 'area: web'],
      isOpen: false,
    },
  ]);
  assert.equal(requests[0]!.url, 'https://api.github.com/repos/o/r/issues?labels=factory%3A%20ready&state=all&per_page=100');
  assert.equal(requests[0]!.method, 'GET');
  assert.equal(requests[0]!.headers.authorization, 'Bearer gh-token');
});

test('listIssues follows the pages GitHub links to, in every configured repository', async () => {
  const second = 'https://api.github.com/repositories/1/issues?labels=factory&state=all&per_page=100&page=2';
  const { issues, requests } = setup(
    [
      { body: [gitHubIssue(1)], link: `<${second}>; rel="next", <${second}>; rel="last"` },
      { body: [gitHubIssue(2)], link: '<https://api.github.com/x?page=1>; rel="prev"' },
      { body: [gitHubIssue(3, { html_url: 'https://github.com/o/s/issues/3' })] },
    ],
    { repos: ['o/r', 'o/s'] },
  );
  assert.deepEqual(
    (await issues.listIssues('factory')).map((issue) => issue.key),
    ['o/r#1', 'o/r#2', 'o/s#3'],
  );
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      'https://api.github.com/repos/o/r/issues?labels=factory&state=all&per_page=100',
      second,
      'https://api.github.com/repos/o/s/issues?labels=factory&state=all&per_page=100',
    ],
  );
});

test('listIssues leaves out pull requests', async () => {
  const pull = { ...gitHubIssue(2, { html_url: 'https://github.com/o/r/pull/2' }), pull_request: { url: 'x' } };
  const { issues } = setup([{ body: [gitHubIssue(1), pull] }]);
  assert.deepEqual(
    (await issues.listIssues('factory')).map((issue) => issue.key),
    ['o/r#1'],
  );
});

test('listIssues takes repository and key from the issue GitHub returned, not from the repository queried', async () => {
  const transferred = gitHubIssue(7, {
    html_url: 'https://github.com/other-org/new-repo/issues/7',
    repository_url: 'https://api.github.com/repos/other-org/new-repo',
    title: 'Belongs to o/r',
    body: 'repo: https://github.com/o/r',
  });
  const [issue] = await setup([{ body: [transferred] }]).issues.listIssues('factory');
  assert.equal(issue!.url, 'https://github.com/other-org/new-repo/issues/7');
  assert.equal(issue!.repoUrl, 'https://github.com/other-org/new-repo');
  assert.equal(issue!.key, 'other-org/new-repo#7');
});

test('listIssues uses /api/v3 and keeps the host on a GitHub Enterprise host', async () => {
  const { issues, requests } = setup([{ body: [gitHubIssue(3, { html_url: 'https://git.example.com/team/app/issues/3' })] }], {
    host: 'git.example.com',
    repos: ['team/app'],
  });
  const [issue] = await issues.listIssues('factory');
  assert.equal(requests[0]!.url, 'https://git.example.com/api/v3/repos/team/app/issues?labels=factory&state=all&per_page=100');
  assert.equal(issue!.repoUrl, 'https://git.example.com/team/app');
  assert.equal(issue!.key, 'team/app#3');
});

test('listIssues rejects an issue whose repository cannot be derived, naming it', async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ html_url: undefined }, /cannot derive the repository of GitHub issue o\/r#5/],
    [{ html_url: 'https://github.com/o/issues/5' }, /cannot derive the repository of GitHub issue https:\/\/github.com\/o\/issues\/5/],
    [{ html_url: 'https://evil.example.com/o/r/issues/5' }, /cannot derive the repository of GitHub issue https:\/\/evil/],
    [{ html_url: 'http://github.com/o/r/issues/5' }, /cannot derive the repository/],
    [{ html_url: 'https://github.com/o/r/issues/5?x=1' }, /cannot derive the repository/],
    [{ html_url: 'not a url' }, /cannot derive the repository of GitHub issue not a url/],
  ];
  for (const [fields, error] of cases) {
    await assert.rejects(setup([{ body: [gitHubIssue(5, fields)] }]).issues.listIssues('factory'), error);
  }
});

test('listIssues rejects malformed responses', async () => {
  const name = 'https://github.com/o/r/issues/5';
  await assert.rejects(setup([{ body: { message: 'x' } }]).issues.listIssues('factory'), /no issue list for o\/r/);
  await assert.rejects(setup([{ body: ['x'] }]).issues.listIssues('factory'), /issue of o\/r that is not an object/);
  await assert.rejects(setup([{ body: [gitHubIssue(5, { title: 3 })] }]).issues.listIssues('factory'), new RegExp(`no title for ${name}`));
  await assert.rejects(setup([{ body: [gitHubIssue(5, { body: {} })] }]).issues.listIssues('factory'), /invalid body for/);
  await assert.rejects(setup([{ body: [gitHubIssue(5, { state: 'draft' })] }]).issues.listIssues('factory'), /unknown state for .*: draft/);
  await assert.rejects(setup([{ body: [gitHubIssue(5, { labels: 'x' })] }]).issues.listIssues('factory'), /no label list for/);
  await assert.rejects(setup([{ body: [gitHubIssue(5, { labels: [{ id: 1 }] })] }]).issues.listIssues('factory'), /invalid label for/);
  await assert.rejects(setup([{ status: 500, body: 'oops' }]).issues.listIssues('factory'), /GitHub answered 500 for issues of o\/r: oops/);
  await assert.rejects(setup().issues.listIssues('a,b'), /comma/);
});

test('covers only issues of the configured repositories on the configured host, ignoring case', () => {
  const { issues } = setup([], { repos: ['o/r', 'Team/App'] });
  assert.equal(issues.covers('https://github.com/o/r/issues/1'), true);
  assert.equal(issues.covers('https://github.com/team/app/issues/2'), true);
  assert.equal(issues.covers('https://github.com/o/other/issues/1'), false);
  assert.equal(issues.covers('https://git.example.com/o/r/issues/1'), false);
  assert.equal(issues.covers('not a url'), false);
});

test('listIssues accepts labels given as names', async () => {
  const [issue] = await setup([{ body: [gitHubIssue(1, { labels: ['factory', { name: 'bug' }] })] }]).issues.listIssues('factory');
  assert.deepEqual(issue!.labels, ['factory', 'bug']);
});

test('changeLabels removes each label, a missing one included, then adds the rest in one request', async () => {
  const { issues, requests } = setup([{ body: [] }, { status: 404, body: { message: 'Label does not exist' } }, { body: [] }]);
  await issues.changeLabels(issueUrl, { add: ['factory: done', 'x'], remove: ['factory: working', 'gone'] });
  assert.deepEqual(
    requests.map((request) => [request.method, request.url, request.body]),
    [
      ['DELETE', 'https://api.github.com/repos/o/r/issues/12/labels/factory%3A%20working', undefined],
      ['DELETE', 'https://api.github.com/repos/o/r/issues/12/labels/gone', undefined],
      ['POST', 'https://api.github.com/repos/o/r/issues/12/labels', { labels: ['factory: done', 'x'] }],
    ],
  );
});

test('changeLabels sends nothing to add when there is nothing, and throws on other errors', async () => {
  const { issues, requests } = setup();
  await issues.changeLabels(issueUrl, { add: [], remove: [] });
  assert.equal(requests.length, 0);
  await assert.rejects(
    setup([{ status: 403, body: 'Forbidden' }]).issues.changeLabels(issueUrl, { add: [], remove: ['x'] }),
    /GitHub answered 403 for https:\/\/github.com\/o\/r\/issues\/12: Forbidden/,
  );
  await assert.rejects(
    setup([{ status: 404, body: 'Not Found' }]).issues.changeLabels(issueUrl, { add: ['x'], remove: [] }),
    /GitHub answered 404/,
  );
});

test('changeLabels and comment refuse a URL that is not an issue on the configured host', async () => {
  const { issues, requests } = setup();
  for (const url of [
    'https://git.example.com/o/r/issues/12',
    'https://github.com/o/r/pull/12',
    'https://github.com/o/r/issues/0',
    'https://github.com/o/r/issues/12/x',
    'https://github.com/o/r/issues/12#c',
    'not a url',
  ]) {
    await assert.rejects(issues.changeLabels(url, { add: ['x'], remove: [] }), /not a GitHub issue URL on github.com/);
    await assert.rejects(issues.comment(url, 'k', 'b'), /not a GitHub issue URL on github.com/);
  }
  assert.equal(requests.length, 0);
});

test('changeLabels uses /api/v3 on a GitHub Enterprise host', async () => {
  const { issues, requests } = setup([], { host: 'git.example.com' });
  await issues.changeLabels('https://git.example.com/o/r/issues/4', { add: ['x'], remove: [] });
  assert.equal(requests[0]!.url, 'https://git.example.com/api/v3/repos/o/r/issues/4/labels');
});

test('comment posts once per key, across adapters on the same database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-issues-'));
  try {
    const dbPath = join(dir, 'factory.db');
    const first = setup([{ status: 201, body: {} }], { dbPath });
    const second = setup([{ status: 201, body: {} }], { dbPath });
    await first.issues.comment(issueUrl, 'started', 'Working on it.');
    await first.issues.comment(issueUrl, 'started', 'Working on it.');
    await second.issues.comment(issueUrl, 'started', 'Working on it again.');
    assert.equal(first.requests.length, 1);
    assert.equal(second.requests.length, 0);
    assert.equal(first.requests[0]!.url, 'https://api.github.com/repos/o/r/issues/12/comments');
    assert.equal(first.requests[0]!.method, 'POST');
    assert.deepEqual(first.requests[0]!.body, { body: 'Working on it.' });

    await second.issues.comment(issueUrl, 'done', 'Done.');
    await second.issues.comment('https://github.com/o/r/issues/13', 'started', 'Working on it.');
    assert.equal(second.requests.length, 2);
    first.issues.close();
    second.issues.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('comment records nothing when GitHub refuses, so a later call posts again', async () => {
  const { issues, requests } = setup([{ status: 502, body: 'Bad Gateway' }, { status: 201, body: {} }]);
  await assert.rejects(issues.comment(issueUrl, 'k', 'b'), /GitHub answered 502/);
  await issues.comment(issueUrl, 'k', 'b');
  assert.equal(requests.length, 2);
});

test('comment truncates a body GitHub would refuse and says so', async () => {
  const { issues, requests } = setup();
  await issues.comment(issueUrl, 'exact', 'a'.repeat(commentMaxLength));
  await issues.comment(issueUrl, 'long', 'a'.repeat(commentMaxLength + 1));
  const bodyOf = (request: Request) => {
    const { body } = request.body as { body: string };
    return body;
  };
  assert.equal(bodyOf(requests[0]!), 'a'.repeat(commentMaxLength));
  const truncated = bodyOf(requests[1]!);
  assert.equal(truncated.length, commentMaxLength);
  assert.match(truncated, /^a+\n\n\*Truncated: .*\*$/);

  // A cut between the two halves of a surrogate pair would leave half a character;
  // the two offsets make one of them land there whatever the note's length.
  for (const prefix of ['', 'a']) {
    await issues.comment(issueUrl, `emoji${prefix}`, prefix + '😀'.repeat(commentMaxLength));
    const emoji = bodyOf(requests.at(-1)!);
    assert.ok(emoji.length <= commentMaxLength);
    assert.ok(emoji.isWellFormed());
  }
});

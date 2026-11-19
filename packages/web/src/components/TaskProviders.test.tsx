import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { draftFieldPrefix, hasUnaddedTaskProvider, TaskProviders } from './TaskProviders.tsx';

const render = (value: Parameters<typeof TaskProviders>[0]['value'], projectId?: string) =>
  renderToStaticMarkup(<TaskProviders value={value} onChange={() => {}} {...(projectId && { projectId })} />);

test('offers the registered providers with their config fields', () => {
  const html = render([]);
  expect(html).toContain('<option value="github-issues" selected="">GitHub Issues</option>');
  expect(html).toContain(`name="${draftFieldPrefix}repo"`);
  expect(html).toContain('placeholder="owner/repo"');
  expect(html).toContain('None attached.');
  expect(html).toContain('<code>factory:project:&lt;project id&gt;</code>');
});

test('lists each attachment with a remove button and names the project label', () => {
  const html = render(
    [
      { provider: 'github-issues', repo: 'acme/web' },
      { provider: 'github-issues', repo: 'acme/api' },
    ],
    'p1',
  );
  expect(html).toContain('GitHub Issues acme/web');
  expect(html).toContain('GitHub Issues acme/api');
  expect(html.match(/>Remove</g)).toHaveLength(2);
  expect(html).not.toContain('None attached.');
  expect(html).toContain('<code>factory:project:p1</code>');
});

test('hasUnaddedTaskProvider notices config typed in but not added', () => {
  const form = new FormData();
  form.set('title', 'P');
  expect(hasUnaddedTaskProvider(form)).toBe(false);
  form.set(`${draftFieldPrefix}repo`, '  ');
  expect(hasUnaddedTaskProvider(form)).toBe(false);
  form.set(`${draftFieldPrefix}repo`, 'acme/web');
  expect(hasUnaddedTaskProvider(form)).toBe(true);
});

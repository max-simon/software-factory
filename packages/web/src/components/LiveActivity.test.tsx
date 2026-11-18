import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { ActivityList, ActivitySection } from './LiveActivity.tsx';

test('lists the newest step first, as text', () => {
  const html = renderToStaticMarkup(
    <ActivityList
      entries={[
        { at: '2026-11-18T10:00:00.000Z', text: 'Running Bash: yarn test' },
        { at: '2026-11-18T10:00:02.000Z', text: 'Writing: <b>done</b>' },
      ]}
    />,
  );
  expect(html.indexOf('Writing:')).toBeLessThan(html.indexOf('Running Bash'));
  expect(html).toContain('&lt;b&gt;done&lt;/b&gt;');
});

const entries = [{ at: '2026-11-18T10:00:00.000Z', text: 'Running Bash: yarn test' }];

test('a running task titles its activity as live', () => {
  const html = renderToStaticMarkup(<ActivitySection entries={entries} isLive />);
  expect(html).toContain('Live activity');
  expect(html).toContain('Running Bash');
});

test('a finished task with entries still shows them, titled as its last activity', () => {
  const html = renderToStaticMarkup(<ActivitySection entries={entries} isLive={false} />);
  expect(html).toContain('Last activity');
  expect(html).not.toContain('Live activity');
  expect(html).toContain('Running Bash');
});

test('a finished task without entries has no activity section', () => {
  expect(renderToStaticMarkup(<ActivitySection entries={[]} isLive={false} />)).toBe('');
});

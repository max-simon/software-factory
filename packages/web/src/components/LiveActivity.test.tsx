import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { ActivityList } from './LiveActivity.tsx';

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

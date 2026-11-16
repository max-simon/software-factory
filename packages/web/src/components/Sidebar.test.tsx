import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { setPreference } from '../theme.ts';
import { Sidebar } from './Sidebar.tsx';

test('the theme toggle offers system, light and dark with the current one checked', () => {
  setPreference('light');
  const html = renderToStaticMarkup(<Sidebar projects={[]} activeId={undefined} />);
  expect(html).toContain('role="radiogroup" aria-label="Theme"');
  expect(html).toContain('role="radio" aria-checked="false">System</button>');
  expect(html).toContain('role="radio" aria-checked="true">Light</button>');
  expect(html).toContain('role="radio" aria-checked="false">Dark</button>');
});

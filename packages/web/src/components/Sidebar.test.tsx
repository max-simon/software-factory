import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { setPreference } from '../theme.ts';
import { Sidebar } from './Sidebar.tsx';

const me = { id: 'u1', username: 'ada', displayName: 'Ada Lovelace' };

test('the theme toggle offers system, light and dark with the current one checked', () => {
  setPreference('light');
  const html = renderToStaticMarkup(<Sidebar projects={[]} activeId={undefined} me={me} />);
  expect(html).toContain('role="radiogroup" aria-label="Theme"');
  expect(html).toContain('role="radio" aria-checked="false">System</button>');
  expect(html).toContain('role="radio" aria-checked="true">Light</button>');
  expect(html).toContain('role="radio" aria-checked="false">Dark</button>');
});

test('the signed-in user’s display name links to the account page, next to a logout', () => {
  const html = renderToStaticMarkup(<Sidebar projects={[]} activeId={undefined} me={me} />);
  expect(html).toContain('href="#/account"');
  expect(html).toContain('title="ada (u1): your account and access tokens">Ada Lovelace</a>');
  expect(html).toContain('>Log out</button>');
  const active = renderToStaticMarkup(<Sidebar projects={[]} activeId={undefined} me={me} isAccountActive />);
  expect(active).toContain('class="active" aria-current="page"');
});

test('while the user loads, the sidebar offers no logout yet', () => {
  expect(renderToStaticMarkup(<Sidebar projects={[]} activeId={undefined} me={undefined} />)).not.toContain('Log out');
});

import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { NewTask } from './TaskForm.tsx';

test('the agent select offers Claude CLI and OpenCode and defaults to claude', () => {
  const html = renderToStaticMarkup(<NewTask projectId="p1" project={undefined} />);
  expect(html).toContain('<option value="claude" selected="">Claude CLI</option>');
  expect(html).toContain('<option value="opencode">OpenCode</option>');
});

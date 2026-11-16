import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { ApprovalNote, ByReviewer } from './Status.tsx';

test('a review by the reviewer names it with its rationale; the engineer’s own carries no mark', () => {
  const byReviewer = renderToStaticMarkup(<ApprovalNote approval={{ status: 'approved', byReviewer: { rationale: 'Matches the spec.' } }} />);
  expect(byReviewer).toContain('by the reviewer: Matches the spec.');
  expect(renderToStaticMarkup(<ApprovalNote approval={{ status: 'approved' }} />)).not.toContain('by the reviewer');
  expect(renderToStaticMarkup(<ByReviewer note={undefined} />)).toBe('');
});

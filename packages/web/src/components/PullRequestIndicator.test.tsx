import type { PullRequestReview } from '@factory/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { PullRequestIndicator } from './PullRequestIndicator.tsx';

const review = (state: PullRequestReview['state']): PullRequestReview => ({
  id: 1,
  author: 'a',
  state,
  body: '',
  url: 'https://github.com/o/r/pull/1#pullrequestreview-1',
  submittedAt: '2026-01-01T00:00:00Z',
});

test('the indicator is an image named by its full label, also shown on hover, without visible text', () => {
  const html = renderToStaticMarkup(<PullRequestIndicator pullRequest={{ status: 'open', reviews: [review('approved')] }} />);
  expect(html).toContain('role="img"');
  expect(html).toContain('title="Open · approved"');
  expect(html).toContain('aria-label="Open · approved"');
  expect(html.replace(/<[^>]*>/g, '')).toBe('');
});

test('the indicator draws the state glyph and the review mark', () => {
  const render = (pullRequest: Parameters<typeof PullRequestIndicator>[0]['pullRequest']) =>
    renderToStaticMarkup(<PullRequestIndicator pullRequest={pullRequest} />);
  const mergedReviewed = render({ status: 'merged', reviews: [review('commented')] });
  expect(mergedReviewed).toContain('pr-indicator-merged');
  expect(mergedReviewed).toContain('pr-indicator-mark-commented');
  expect(mergedReviewed).toContain('aria-label="Merged after review"');
  const mergedUnreviewed = render({ status: 'merged' });
  expect(mergedUnreviewed).toContain('pr-indicator-mark-none');
  expect(mergedUnreviewed).toContain('aria-label="Merged without review"');
  expect(render({ status: 'open', reviews: [review('changes_requested')] })).toContain('aria-label="Open · changes requested"');
  expect(render({ status: 'closed', reviews: [] })).toContain('aria-label="Closed"');
});

test('the indicator marks an open pull request with merge conflicts', () => {
  const html = renderToStaticMarkup(<PullRequestIndicator pullRequest={{ status: 'open', hasConflicts: true }} />);
  expect(html).toContain('pr-indicator-open pr-indicator-conflicted');
  expect(html).toContain('aria-label="Open · not reviewed · merge conflicts"');
  expect(renderToStaticMarkup(<PullRequestIndicator pullRequest={{ status: 'open' }} />)).not.toContain('pr-indicator-conflicted');
});

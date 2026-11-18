import type { PullRequest } from '@factory/core';
import type { ReactNode } from 'react';
import { pullRequestIndicator, type PullRequestReviewMark } from '../model.ts';

// Glyphs drawn on a 14×16 area at the left; the review mark sits at the bottom right.
const glyphs = {
  open: (
    <>
      <circle cx="3.5" cy="3.5" r="1.75" />
      <circle cx="3.5" cy="12.5" r="1.75" />
      <path d="M3.5 5.25v5.5" />
      <circle cx="10.5" cy="12.5" r="1.75" />
      <path d="M10.5 10.75V6a2.5 2.5 0 0 0-2.5-2.5H6.25M7.75 1.75 6 3.5l1.75 1.75" />
    </>
  ),
  merged: (
    <>
      <circle cx="3.5" cy="3.5" r="1.75" />
      <circle cx="3.5" cy="12.5" r="1.75" />
      <path d="M3.5 5.25v5.5M3.5 5.25c0 2.6 2.2 3.75 5 3.75" />
      <circle cx="10.25" cy="9" r="1.75" />
    </>
  ),
  closed: (
    <>
      <circle cx="3.5" cy="3.5" r="1.75" />
      <circle cx="3.5" cy="12.5" r="1.75" />
      <path d="M3.5 5.25v5.5" />
      <circle cx="10.5" cy="12.5" r="1.75" />
      <path d="M10.5 10.75V8.5M8.75 2.25l3.5 3.5M12.25 2.25l-3.5 3.5" />
    </>
  ),
};

const marks: Record<PullRequestReviewMark, ReactNode> = {
  none: <circle cx="17" cy="12" r="3" />,
  approved: (
    <>
      <circle cx="17" cy="12" r="4" />
      <path d="m15.1 12.1 1.4 1.4 2.6-2.8" />
    </>
  ),
  changes_requested: (
    <>
      <circle cx="17" cy="12" r="4" />
      <path d="m15.5 10.5 3 3m0-3-3 3" />
    </>
  ),
  commented: <circle cx="17" cy="12" r="3" />,
};

/** A compact icon for where a pull request stands and how far its review got; the label is on hover. */
export function PullRequestIndicator({ pullRequest }: { pullRequest: Pick<PullRequest, 'status' | 'reviews' | 'hasConflicts'> }) {
  const { state, review, label, hasConflicts } = pullRequestIndicator(pullRequest);
  const conflicted = hasConflicts ? ' pr-indicator-conflicted' : '';
  return (
    <span className={`pr-indicator pr-indicator-${state}${conflicted}`} role="img" title={label} aria-label={label}>
      <svg viewBox="0 0 21 16" width="21" height="16" aria-hidden>
        <g className="pr-indicator-glyph">{glyphs[state]}</g>
        <g className={`pr-indicator-mark pr-indicator-mark-${review}`}>{marks[review]}</g>
      </svg>
    </span>
  );
}

import type { ExternalLink } from '@factory/core';
import { isWebUrl } from '../model.ts';

/**
 * Marks a managed task and links to its issue. The URL comes from the
 * provider, so anything but http(s) (e.g. `javascript:`) shows as plain text.
 */
export function IssueLink({ external }: { external: ExternalLink }) {
  const title = `Managed by a ${external.provider} issue`;
  const content = (
    <>
      <IssueIcon />
      {external.key}
    </>
  );
  if (!isWebUrl(external.url)) {
    return (
      <span className="issue-link" title={title}>
        {content}
      </span>
    );
  }
  return (
    <a className="issue-link" href={external.url} target="_blank" rel="noopener noreferrer" title={title}>
      {content}
    </a>
  );
}

function IssueIcon() {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden>
      <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6" cy="6" r="1.4" fill="currentColor" />
    </svg>
  );
}

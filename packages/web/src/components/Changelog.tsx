import type { ChangeMeta } from '@factory/core';
import { relativeTime } from '../model.ts';
import { UserName } from './UserName.tsx';

/**
 * Who changed what, and when; one line per change, oldest first. A user shows
 * by its current display name; the agent, reviewer and system by their role.
 */
export function Changelog<C extends ChangeMeta & { field: string }>({
  changes,
  describe,
}: {
  changes: readonly C[];
  describe: (change: C) => string;
}) {
  return (
    <ol className="changelog">
      {changes.map((change, i) => (
        <li key={i} className={`changelog-entry changelog-${change.field}`}>
          <time dateTime={change.at} title={change.at}>
            {relativeTime(change.at)}
          </time>
          <span className={`actor actor-${change.actor}`}>
            {change.actor === 'user' ? <UserName id={change.userId} /> : change.actor}
          </span>
          <span className="changelog-text">{describe(change)}</span>
        </li>
      ))}
    </ol>
  );
}

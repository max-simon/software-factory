import type { TaskChange } from '@factory/core';
import { describeChange, relativeTime } from '../model.ts';

/** Who changed title, specification, labels or status, and when; one line per change, oldest first. */
export function Changelog({ changes }: { changes: TaskChange[] }) {
  return (
    <ol className="changelog">
      {changes.map((change, i) => (
        <li key={i} className={`changelog-entry changelog-${change.field}`}>
          <time dateTime={change.at} title={change.at}>
            {relativeTime(change.at)}
          </time>
          <span className={`actor actor-${change.actor}`}>{change.actor}</span>
          <span className="changelog-text">{describeChange(change)}</span>
        </li>
      ))}
    </ol>
  );
}

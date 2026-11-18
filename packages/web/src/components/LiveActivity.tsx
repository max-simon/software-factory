import type { ActivityEntry } from '@factory/core';
import { api } from '../api.ts';
import { usePolling } from '../hooks.ts';

/**
 * What the agent did in its current turn. The control plane keeps it in memory
 * only, so it is empty after a restart until the agent acts again.
 */
export function LiveActivity({ taskId }: { taskId: string }) {
  const { data: entries } = usePolling(() => api.listActivity(taskId), taskId);
  if (!entries?.length) return null;
  return (
    <section className="box">
      <h2 className="section-title">Live activity</h2>
      <ActivityList entries={entries} />
    </section>
  );
}

/** Newest first, so the latest step needs no scrolling. */
export function ActivityList({ entries }: { entries: readonly ActivityEntry[] }) {
  return (
    <ol className="activity">
      {entries.toReversed().map((entry, i) => (
        <li key={i} className="activity-entry">
          <time dateTime={entry.at} title={entry.at}>
            {new Date(entry.at).toLocaleTimeString()}
          </time>
          <span className="activity-text">{entry.text}</span>
        </li>
      ))}
    </ol>
  );
}

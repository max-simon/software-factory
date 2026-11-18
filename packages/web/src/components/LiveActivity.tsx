import type { ActivityEntry } from '@factory/core';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { usePolling } from '../hooks.ts';

/**
 * What the agent did in its latest turn, for as long as the control plane
 * holds it. The feed lives in memory only and is bounded, so a finished task
 * keeps its log until busier tasks push it out or the control plane restarts;
 * then the section is hidden.
 */
export function LiveActivity({ taskId, isLive }: { taskId: string; isLive: boolean }) {
  return isLive ? <PolledActivity taskId={taskId} /> : <FinalActivity taskId={taskId} />;
}

function PolledActivity({ taskId }: { taskId: string }) {
  const { data: entries } = usePolling(() => api.listActivity(taskId), taskId);
  return <ActivitySection entries={entries ?? []} isLive />;
}

/** Without an execution server the log can no longer grow, so one load is enough. */
function FinalActivity({ taskId }: { taskId: string }) {
  const [loaded, setLoaded] = useState<{ taskId: string; entries: ActivityEntry[] }>();
  useEffect(() => {
    let isCancelled = false;
    // A failed load hides the section; the task poll already reports an unreachable control plane.
    api.listActivity(taskId).then(
      (entries) => {
        if (!isCancelled) setLoaded({ taskId, entries });
      },
      () => {},
    );
    return () => {
      isCancelled = true;
    };
  }, [taskId]);
  return <ActivitySection entries={loaded?.taskId === taskId ? loaded.entries : []} isLive={false} />;
}

export function ActivitySection({ entries, isLive }: { entries: readonly ActivityEntry[]; isLive: boolean }) {
  if (entries.length === 0) return null;
  return (
    <section className="box">
      <h2 className="section-title">{isLive ? 'Live activity' : 'Last activity'}</h2>
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

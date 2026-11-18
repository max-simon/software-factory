import { relativeTime, type TimelineEntry } from '../model.ts';
import { DecisionBody } from './InputItems.tsx';
import { Markdown } from './Markdown.tsx';
import { ApprovalNote, ByReviewer, ByUser } from './Status.tsx';

const kindLabels: Record<TimelineEntry['kind'], string> = {
  question: 'Question',
  decision: 'Decision',
  artifact: 'Artifact',
  'follow-up': 'Follow-up',
};

/** Settled questions, decisions and artifacts and all follow-ups in the order the timeline model gives them. */
export function Timeline({ entries, onOpenArtifact }: { entries: TimelineEntry[]; onOpenArtifact: (id: string) => void }) {
  return (
    <ol className="timeline">
      {entries.map((entry) => (
        <li key={`${entry.kind}:${entry.item.id}`} className={`timeline-entry timeline-${entry.kind}`}>
          <span className="timeline-marker" aria-hidden />
          <p className="timeline-meta">
            <span className="timeline-kind">{kindLabels[entry.kind]}</span>
            <time dateTime={entry.item.createdAt} title={entry.item.createdAt}>
              {relativeTime(entry.item.createdAt)}
            </time>
          </p>
          <EntryBody entry={entry} onOpenArtifact={onOpenArtifact} />
        </li>
      ))}
    </ol>
  );
}

function EntryBody({ entry, onOpenArtifact }: { entry: TimelineEntry; onOpenArtifact: (id: string) => void }) {
  switch (entry.kind) {
    case 'question':
      return (
        <>
          <Markdown>{entry.item.problem}</Markdown>
          <p className="answer">
            {entry.item.answer?.join(', ')}
            {entry.item.byReviewer ? <ByReviewer note={entry.item.byReviewer} /> : <ByUser id={entry.item.answeredBy} />}
          </p>
        </>
      );
    case 'decision':
      return (
        <>
          <DecisionBody decision={entry.item} />
          <ApprovalNote approval={entry.item.approval} />
        </>
      );
    case 'artifact':
      return (
        <>
          <button className="artifact-link" onClick={() => onOpenArtifact(entry.item.id)}>
            {entry.item.title} <span className="muted">{entry.item.kind}</span>
          </button>
          <ApprovalNote approval={entry.item.approval} />
        </>
      );
    case 'follow-up':
      return (
        <>
          <Markdown>{entry.item.message}</Markdown>
          <p className="delivery">
            <ByUser id={entry.item.authorId} />
            {entry.item.deliveredAt ? (
              <span className="delivered" title={entry.item.deliveredAt}>
                Delivered {relativeTime(entry.item.deliveredAt)}
              </span>
            ) : (
              <span>Pending delivery</span>
            )}
          </p>
        </>
      );
  }
}

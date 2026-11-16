import type { Annotation, Artifact, ReviewVerdict } from '@factory/core';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import { api } from '../api.ts';
import { findTextRange, normalizeQuote, setHighlight } from '../highlights.ts';
import { useAction } from '../hooks.ts';
import type { TaskView } from '../model.ts';
import { ArtifactContent } from './ArtifactContent.tsx';
import { ErrorText } from './ErrorText.tsx';
import { ApprovalNote } from './Status.tsx';

interface Note extends Annotation {
  /** Where the quote sits in the rendered artifact; missing when it cannot be found again. */
  range: Range | undefined;
}

interface Draft {
  quote: string;
  range: Range;
  top: number;
  left: number;
}

interface Props {
  taskId: string;
  artifact: Artifact;
  /** True while the artifact awaits this engineer's approval. */
  canReview: boolean;
  onClose: () => void;
  onReviewed: (task: TaskView) => void;
}

const popoverWidth = 300;

// requestClose runs the cancel handler like Escape does; older browsers just close.
function requestClose(dialog: HTMLDialogElement | null): void {
  if (!dialog) return;
  if ('requestClose' in dialog) dialog.requestClose();
  else (dialog as HTMLDialogElement).close();
}

export function ArtifactModal({ taskId, artifact, canReview, onClose, onReviewed }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState<Draft>();
  const [draftComment, setDraftComment] = useState('');
  const [comment, setComment] = useState('');
  const { isBusy, error, run } = useAction();

  // The content takes focus so arrow keys scroll the artifact, not the close button.
  useEffect(() => {
    dialogRef.current?.showModal();
    scrollRef.current?.focus();
  }, []);

  // A past review is shown with its comments anchored to the passages they quote.
  useLayoutEffect(() => {
    if (canReview || !contentRef.current) return;
    const root = contentRef.current;
    setNotes((artifact.approval?.annotations ?? []).map((a) => ({ ...a, range: findTextRange(root, a.quote) })));
  }, [canReview, artifact.approval]);

  useEffect(() => {
    setHighlight('review-note', notes.flatMap((n) => (n.range ? [n.range] : [])));
    setHighlight('review-draft', draft ? [draft.range] : []);
  }, [notes, draft]);
  useEffect(
    () => () => {
      setHighlight('review-note', []);
      setHighlight('review-draft', []);
    },
    [],
  );

  const startDraft = () => {
    const selection = getSelection();
    const scroller = scrollRef.current;
    if (!canReview || !selection || selection.isCollapsed || !scroller || !contentRef.current) return;
    const range = selection.getRangeAt(0);
    const quote = normalizeQuote(selection.toString());
    if (!quote || !contentRef.current.contains(range.commonAncestorContainer)) return;
    const box = range.getBoundingClientRect();
    const host = scroller.getBoundingClientRect();
    const left = Math.min(Math.max(box.left - host.left, 8), host.width - popoverWidth - 8);
    setDraft({ quote, range: range.cloneRange(), top: box.bottom - host.top + scroller.scrollTop + 8, left });
    setDraftComment('');
    selection.removeAllRanges();
  };

  const addNote = () => {
    if (!draft || !draftComment.trim()) return;
    setNotes([...notes, { quote: draft.quote, comment: draftComment.trim(), range: draft.range }]);
    setDraft(undefined);
  };

  const onDraftKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) addNote();
  };

  // Escape first drops an open draft; leaving with unsent comments asks first.
  const onCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    if (draft) {
      event.preventDefault();
      setDraft(undefined);
      return;
    }
    if ((notes.length > 0 && canReview) || comment.trim()) {
      if (!confirm('Discard your review comments?')) event.preventDefault();
    }
  };

  const submit = (verdict: ReviewVerdict) =>
    run(async () => {
      const annotations = notes.map(({ quote, comment: text }) => ({ quote, comment: text }));
      const task = await api.review(taskId, artifact.id, {
        verdict,
        ...(comment.trim() && { comment }),
        ...(annotations.length > 0 && { annotations }),
      });
      onReviewed(task);
      dialogRef.current?.close();
    });

  const reveal = (note: Note) =>
    note.range?.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  return (
    <dialog ref={dialogRef} className="modal" onClose={onClose} onCancel={onCancel}>
      <header className="modal-header">
        <div>
          <h2>{artifact.title}</h2>
          <span className="muted">{artifact.kind}</span>
        </div>
        <button className="link close" aria-label="Close" onClick={() => requestClose(dialogRef.current)}>
          ✕
        </button>
      </header>
      <div className="modal-body">
        <div ref={scrollRef} className="modal-content" tabIndex={-1}>
          <div ref={contentRef} onMouseUp={startDraft} className={canReview ? 'selectable' : undefined}>
            <ArtifactContent kind={artifact.kind} content={artifact.content} />
          </div>
          {draft && (
            <div className="popover" style={{ top: draft.top, left: draft.left, width: popoverWidth }}>
              <textarea
                autoFocus
                rows={3}
                value={draftComment}
                onChange={(e) => setDraftComment(e.target.value)}
                onKeyDown={onDraftKey}
                placeholder="Comment on the selection"
              />
              <div className="actions">
                <button className="button primary small" disabled={!draftComment.trim()} onClick={addNote}>
                  Comment
                </button>
                <button className="link" onClick={() => setDraft(undefined)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
        <aside className="modal-rail">
          {!canReview && <ApprovalNote approval={artifact.approval} />}
          {notes.length > 0 ? (
            <ul className="notes">
              {notes.map((note, i) => (
                <li key={i}>
                  <button className="note-quote" onClick={() => reveal(note)} title="Show in text">
                    {note.quote}
                  </button>
                  <p>{note.comment}</p>
                  {canReview && (
                    <button className="link" onClick={() => setNotes(notes.filter((n) => n !== note))}>
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            canReview && <p className="muted">Select text to comment on it.</p>
          )}
          {canReview && (
            <div className="review-form">
              <textarea rows={4} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Overall comment" />
              <ErrorText message={error} />
              <div className="actions">
                <button className="button primary" disabled={isBusy} onClick={() => void submit('approved')}>
                  Approve
                </button>
                <button
                  className="button"
                  disabled={isBusy || (!comment.trim() && notes.length === 0)}
                  onClick={() => void submit('changes_requested')}
                >
                  Request changes
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>
    </dialog>
  );
}

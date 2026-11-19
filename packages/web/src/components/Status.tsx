import type { Approval, ReviewerNote, TaskStatus } from '@factory/core';
import { heartbeatInfo, statusLabel, type TaskView } from '../model.ts';
import { UserName } from './UserName.tsx';

export function StatusDot({ status }: { status: TaskStatus }) {
  return <span className={`dot status-${status}`} title={statusLabel(status)} aria-hidden />;
}

/** What the execution server is doing; details on hover. Renders nothing without an execution server. */
export function HeartbeatNote({ task, isCompact = false }: { task: Pick<TaskView, 'execution'>; isCompact?: boolean }) {
  const info = heartbeatInfo(task);
  // Cards stay quiet while the runner is alive; only a silent or paused one is worth the space.
  if (!info || (isCompact && !info.isStale && !info.isPaused)) return null;
  const compactText = info.isPaused ? 'usage limit' : 'no heartbeat';
  return (
    <span className={info.isStale || info.isPaused ? 'heartbeat heartbeat-stale' : 'heartbeat'} title={info.tooltip}>
      <span className="heartbeat-pulse" aria-hidden />
      <span className="heartbeat-text">{isCompact ? compactText : info.text}</span>
    </span>
  );
}

/** A small rotating ring in the surrounding text colour; renders nothing when not busy. */
export function Spinner({ isBusy, label }: { isBusy: boolean; label: string }) {
  if (!isBusy) return null;
  return <span className="spinner" role="status" title={label} aria-label={label} />;
}

export const specReviewLabel = 'Reviewer is checking the specification';
export const prReviewLabel = 'Reviewer is assessing this pull request';
export const inputReviewLabel = 'Reviewer is checking whether it can give this input itself';

export function StatusLabel({ status, isSpecUnderReview = false }: { status: TaskStatus; isSpecUnderReview?: boolean }) {
  return (
    <span className={`status status-${status}`}>
      <StatusDot status={status} />
      {statusLabel(status)}
      <Spinner isBusy={isSpecUnderReview} label={specReviewLabel} />
    </span>
  );
}

const approvalLabels: Record<Approval['status'], string> = {
  pending: 'Awaiting approval',
  approved: 'Approved',
  changes_requested: 'Changes requested',
};

function ApprovalBadge({ status }: { status: Approval['status'] }) {
  return <span className={`approval approval-${status}`}>{approvalLabels[status]}</span>;
}

export function ApprovalNote({ approval }: { approval: Approval | undefined }) {
  if (!approval) return null;
  return (
    <p className="approval-note">
      <ApprovalBadge status={approval.status} />
      {approval.comment && <span className="muted"> {approval.comment}</span>}
      {approval.byReviewer ? <ByReviewer note={approval.byReviewer} /> : approval.status !== 'pending' && <ByUser id={approval.reviewedBy} />}
    </p>
  );
}

/** Names the user who gave input; an engineer's input from before users existed shows as unattributed. */
export function ByUser({ id }: { id: string | undefined }) {
  return (
    <span className="by-user">
      by <UserName id={id} />
    </span>
  );
}

/** Marks a follow-up the control plane sent on its own, e.g. for a pull request review. */
export function BySystem() {
  return <span className="by-system">by the system</span>;
}

/** Marks input the reviewer gave instead of the engineer, with its reason; renders nothing for the engineer's own. */
export function ByReviewer({ note }: { note: ReviewerNote | undefined }) {
  if (!note) return null;
  return (
    <span className="by-reviewer" title={note.rationale}>
      by the reviewer: {note.rationale}
    </span>
  );
}

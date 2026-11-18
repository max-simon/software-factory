import {
  formatCost,
  formatDuration,
  formatTokens,
  hasStarted,
  isCancellable,
  isEditable,
  isRestartable,
  type Project,
  type SessionMetrics,
  type TaskChange,
  type TokenUsage,
} from '@factory/core';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { AgentConsoleModal } from '../components/AgentConsoleModal.tsx';
import { Changelog } from '../components/Changelog.tsx';
import { LiveActivity } from '../components/LiveActivity.tsx';
import { DependenciesSection } from '../components/Dependencies.tsx';
import { ErrorText } from '../components/ErrorText.tsx';
import { ArtifactModal } from '../components/ArtifactModal.tsx';
import { ArtifactApprovalRequest, DecisionApprovalForm, QuestionForm } from '../components/InputItems.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { PlanPipeline } from '../components/PlanPipeline.tsx';
import { PullRequestIndicator } from '../components/PullRequestIndicator.tsx';
import { HeartbeatNote, inputReviewLabel, prReviewLabel, Spinner, StatusLabel } from '../components/Status.tsx';
import { Timeline } from '../components/Timeline.tsx';
import { useAction, usePolling } from '../hooks.ts';
import { UserName } from '../components/UserName.tsx';
import {
  agentLabels,
  canSendFollowUp,
  describeChange,
  href,
  openInput,
  pullRequestNumber,
  relativeTime,
  repoName,
  timeline,
  totalTokens,
  type TaskView,
} from '../model.ts';

export function TaskDetail({ id, projects }: { id: string; projects: Project[] | undefined }) {
  const { data: task, error, set } = usePolling(() => api.getTask(id), id);
  const [openArtifactId, setOpenArtifactId] = useState<string>();
  const changes = useChanges(id, task?.updatedAt);

  useEffect(() => {
    if (task) document.title = `${task.title} · Factory`;
  }, [task?.title]);

  if (!task) return <p className="muted">{error ? error.message : 'Loading…'}</p>;
  const { questions, approvals } = openInput(task);
  const entries = timeline(task);
  const openArtifact = task.artifacts.find((a) => a.id === openArtifactId);

  return (
    <article className="task">
      <a className="back" href={href.project(task.projectId)}>
        ← {projects?.find((p) => p.id === task.projectId)?.title ?? 'Project'}
      </a>
      {error && <p className="banner">{error.message} Retrying…</p>}
      <Header task={task} onChange={set} />

      {task.failureReason && (
        <Section title="Failure" className="failure">
          <pre>{task.failureReason}</pre>
        </Section>
      )}

      {task.status === 'clarification_required' && <ClarificationNote task={task} onChange={set} />}

      {(task.dependsOn.length > 0 || !hasStarted(task.status)) && <DependenciesSection task={task} onChange={set} />}

      {task.pullRequests.length > 0 && (
        <Section title="Pull requests">
          <PullRequestList pullRequests={task.pullRequests} />
        </Section>
      )}

      {questions.length + approvals.length > 0 && (
        <Section
          title={
            <>
              Needs your input
              <Spinner isBusy={task.isInputUnderReview} label={inputReviewLabel} />
            </>
          }
          className="needs-input"
        >
          {questions.map((question) => (
            <QuestionForm key={question.id} taskId={task.id} question={question} onDone={set} />
          ))}
          {approvals.map((review) =>
            review.kind === 'decision' ? (
              <DecisionApprovalForm key={review.item.id} taskId={task.id} decision={review.item} onDone={set} />
            ) : (
              <ArtifactApprovalRequest key={review.item.id} artifact={review.item} onOpen={() => setOpenArtifactId(review.item.id)} />
            ),
          )}
        </Section>
      )}

      {task.plan.length > 0 && (
        <Section title="Plan">
          <PlanPipeline plan={task.plan} />
        </Section>
      )}

      {task.execution && <LiveActivity taskId={task.id} />}

      <details className="box spec" open={isEditable(task.status)}>
        <summary className="section-title">Specification</summary>
        <Markdown>{task.specification}</Markdown>
      </details>

      {entries.length > 0 && (
        <Section title="Timeline">
          <Timeline entries={entries} onOpenArtifact={setOpenArtifactId} />
        </Section>
      )}

      {canSendFollowUp(task) && <FollowUpForm task={task} onSent={set} />}

      {changes.length > 0 && (
        <Section title="Changelog" className="changelog-box">
          <Changelog changes={changes} describe={describeChange} />
        </Section>
      )}

      {task.metrics && <Consumption metrics={task.metrics} />}

      {openArtifact && (
        <ArtifactModal
          taskId={task.id}
          artifact={openArtifact}
          canReview={task.status === 'input_required' && openArtifact.approval?.status === 'pending'}
          onClose={() => setOpenArtifactId(undefined)}
          onReviewed={set}
        />
      )}
    </article>
  );
}

export function Header({ task, onChange }: { task: TaskView; onChange: (task: TaskView) => void }) {
  const { isBusy, error, run } = useAction();
  const [isConsoleOpen, setIsConsoleOpen] = useState(false);
  const [isRequestingClarification, setIsRequestingClarification] = useState(false);
  // Each confirmation names what is lost, since none of these can be undone.
  const runConfirmed = (question: string, action: () => Promise<void>) => {
    if (window.confirm(question)) void run(action);
  };
  return (
    <header className="task-header">
      <div className="task-heading">
        <h1>{task.title}</h1>
        <div className="actions">
          {task.agent === 'opencode' && task.execution?.consoleUrl && (
            <button className="button" onClick={() => setIsConsoleOpen(true)}>
              Open in OpenCode
            </button>
          )}
          {isEditable(task.status) && (
            <a className="button" href={href.edit(task.id)}>
              Edit
            </a>
          )}
          {task.status === 'draft' && (
            <button className="button" onClick={() => setIsRequestingClarification(true)}>
              Request clarification
            </button>
          )}
          {isCancellable(task.status) && (
            <button
              className="button"
              disabled={isBusy}
              onClick={() =>
                runConfirmed('Cancel this task? Its execution server is stopped and the task fails.', async () =>
                  onChange(await api.cancelTask(task.id)),
                )
              }
            >
              Cancel
            </button>
          )}
          {isRestartable(task.status) && (
            <button
              className="button"
              disabled={isBusy}
              onClick={() =>
                runConfirmed(
                  'Restart this task from its specification? Its execution server is stopped, and its plan, decisions, artifacts, questions and follow-ups are cleared. Pull requests it opened stay open on GitHub.',
                  async () => onChange(await api.restartTask(task.id)),
                )
              }
            >
              Restart
            </button>
          )}
          <button
            className="button danger"
            disabled={isBusy}
            onClick={() =>
              runConfirmed('Delete this task for good? A running execution server is stopped first.', async () => {
                await api.deleteTask(task.id);
                location.hash = href.project(task.projectId);
              })
            }
          >
            Delete
          </button>
          {isEditable(task.status) && (
            <button className="button primary" disabled={isBusy} onClick={() => void run(async () => onChange(await api.startTask(task.id)))}>
              Start
            </button>
          )}
        </div>
      </div>
      <p className="meta">
        <StatusLabel status={task.status} isSpecUnderReview={task.isSpecUnderReview} />
        <HeartbeatNote task={task} />
        {task.repoUrl ? (
          <a href={task.repoUrl} target="_blank" rel="noreferrer">
            {repoName(task.repoUrl)}
            {task.baseBranch && <span className="muted"> @ {task.baseBranch}</span>}
          </a>
        ) : (
          <span>No repository</span>
        )}
        <span>{task.autonomyMode}</span>
        <span>{task.model}</span>
        <span>{agentLabels[task.agent]}</span>
        {task.labels.map((label) => (
          <span key={label} className="label">
            {label}
          </span>
        ))}
        <span className="created-by">
          created by <UserName id={task.createdBy} />
        </span>
        <span title={task.updatedAt}>updated {relativeTime(task.updatedAt)}</span>
        <span className="mono">{task.id}</span>
      </p>
      <ErrorText message={error} />
      {isRequestingClarification && task.status === 'draft' && (
        <ClarificationForm
          taskId={task.id}
          onDone={(next) => {
            setIsRequestingClarification(false);
            onChange(next);
          }}
          onCancel={() => setIsRequestingClarification(false)}
        />
      )}
      {isConsoleOpen && <AgentConsoleModal taskId={task.id} onClose={() => setIsConsoleOpen(false)} />}
    </header>
  );
}

/**
 * The task's changelog, reloaded whenever the task changes: every change that
 * adds an entry also stamps `updatedAt`, so the changelog needs no polling of its own.
 */
function useChanges(id: string, updatedAt: string | undefined): TaskChange[] {
  const [loaded, setLoaded] = useState<{ id: string; changes: TaskChange[] }>();
  useEffect(() => {
    if (updatedAt === undefined) return;
    let isCancelled = false;
    // A failed load keeps the last changelog; the task poll already reports an unreachable control plane.
    api.listChanges(id).then(
      (changes) => {
        if (!isCancelled) setLoaded({ id, changes });
      },
      () => {},
    );
    return () => {
      isCancelled = true;
    };
  }, [id, updatedAt]);
  return loaded?.id === id ? loaded.changes : [];
}

function ClarificationNote({ task, onChange }: { task: TaskView; onChange: (task: TaskView) => void }) {
  const { isBusy, error, run } = useAction();
  return (
    <Section title="Needs clarification" className="needs-input">
      <Markdown>{task.clarification ?? ''}</Markdown>
      <p className="muted">Edit the task to clarify it, then start it or move it back to draft.</p>
      <ErrorText message={error} />
      <div className="actions">
        <button className="button" disabled={isBusy} onClick={() => void run(async () => onChange(await api.returnToDraft(task.id)))}>
          Back to draft
        </button>
      </div>
    </Section>
  );
}

function ClarificationForm({
  taskId,
  onDone,
  onCancel,
}: {
  taskId: string;
  onDone: (task: TaskView) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState('');
  const { isBusy, error, run } = useAction();
  return (
    <form
      className="box"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => onDone(await api.requestClarification(taskId, note)));
      }}
    >
      <h2 className="section-title">Request clarification</h2>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="What is unclear or missing in the specification?" />
      <ErrorText message={error} />
      <div className="actions">
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="button primary" disabled={isBusy || note.trim() === ''}>
          Request clarification
        </button>
      </div>
    </form>
  );
}

function FollowUpForm({ task, onSent }: { task: TaskView; onSent: (task: TaskView) => void }) {
  const [message, setMessage] = useState('');
  const { isBusy, error, run } = useAction();
  return (
    <form
      className="box follow-up"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          onSent(await api.sendFollowUp(task.id, message));
          setMessage('');
        });
      }}
    >
      <h2 className="section-title">Follow-up</h2>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={3}
        placeholder={
          task.status === 'in_progress' || task.status === 'input_required'
            ? 'Message for the agent; it gets it when its current turn ends'
            : 'Message for the agent; it resumes work on the task'
        }
      />
      <ErrorText message={error} />
      <div className="actions">
        <button className="button primary" disabled={isBusy || message.trim() === ''}>
          Send follow-up
        </button>
      </div>
    </form>
  );
}

/** Summed over every agent session of the task. */
export function Consumption({ metrics }: { metrics: SessionMetrics }) {
  const { tokens } = metrics;
  return (
    <Section title="Consumption">
      <dl className="consumption">
        <dt>Agent time</dt>
        <dd>{formatDuration(metrics.durationMs)}</dd>
        <dt>Cost</dt>
        <dd>
          {formatCost(metrics.costUsd)} <span className="muted">estimate at list prices, not a billed amount</span>
        </dd>
        <dt>Tokens</dt>
        {tokens ? (
          <dd>
            {formatTokens(totalTokens(tokens))} <span className="muted">{tokenBreakdown(tokens)}</span>
          </dd>
        ) : (
          // Tasks measured before tokens were tracked, or by an agent that reports none.
          <dd className="muted">not recorded</dd>
        )}
      </dl>
    </Section>
  );
}

const tokenBreakdown = (tokens: TokenUsage): string =>
  [
    `${formatTokens(tokens.inputTokens)} input`,
    `${formatTokens(tokens.outputTokens)} output`,
    `${formatTokens(tokens.cacheReadTokens)} cache read`,
    `${formatTokens(tokens.cacheCreationTokens)} cache write`,
  ].join(' · ');

export function PullRequestList({ pullRequests }: { pullRequests: TaskView['pullRequests'] }) {
  return (
    <ul className="plain">
      {pullRequests.map((pr) => (
        <li key={pr.url}>
          <a href={pr.url} target="_blank" rel="noreferrer">
            <span className="mono muted">{pullRequestNumber(pr.url)}</span> {pr.title}
          </a>
          <PullRequestIndicator pullRequest={pr} />
          <Spinner isBusy={pr.isUnderReview} label={prReviewLabel} />
        </li>
      ))}
    </ul>
  );
}

function Section({ title, className, children }: { title: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={className ? `box ${className}` : 'box'}>
      <h2 className="section-title">{title}</h2>
      {children}
    </section>
  );
}

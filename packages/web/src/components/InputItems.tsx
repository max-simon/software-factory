import type { Artifact, Decision, PullRequest, Question } from '@factory/core';
import { useState } from 'react';
import { api } from '../api.ts';
import { useAction } from '../hooks.ts';
import { CheckIcon } from './CheckIcon.tsx';
import { prReviewReasons, pullRequestNumber, type TaskView } from '../model.ts';
import { ErrorText } from './ErrorText.tsx';
import { Markdown } from './Markdown.tsx';

interface ItemProps {
  taskId: string;
  onDone: (task: TaskView) => void;
}

export function QuestionForm({ taskId, question, onDone }: ItemProps & { question: Question }) {
  const [text, setText] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const { isBusy, error, run } = useAction();
  const answer = question.type === 'text' ? [text] : chosen;
  const isComplete = question.type === 'text' ? text.trim() !== '' : question.type === 'checkbox' || chosen.length === 1;

  const toggle = (option: string) =>
    setChosen(question.type === 'radio' ? [option] : chosen.includes(option) ? chosen.filter((o) => o !== option) : [...chosen, option]);

  return (
    <form
      className="input-item"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => onDone(await api.answer(taskId, question.id, answer)));
      }}
    >
      <p className="input-kind">Question</p>
      <Markdown>{question.problem}</Markdown>
      {question.type === 'text' ? (
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Your answer" />
      ) : (
        <div className="choices">
          {question.options.map((option) => (
            <label key={option} className="choice">
              <input
                type={question.type}
                name={`${taskId}-${question.id}`}
                checked={chosen.includes(option)}
                onChange={() => toggle(option)}
              />
              {option}
            </label>
          ))}
        </div>
      )}
      <ErrorText message={error} />
      <div className="actions">
        <button className="button primary" disabled={isBusy || !isComplete}>
          Answer
        </button>
      </div>
    </form>
  );
}

export function DecisionApprovalForm({ taskId, decision, onDone }: ItemProps & { decision: Decision }) {
  const [comment, setComment] = useState('');
  const [chosen, setChosen] = useState(decision.chosen);
  const { isBusy, error, run } = useAction();
  const isOverride = chosen !== decision.chosen;
  const submit = (verdict: 'approved' | 'changes_requested') =>
    run(async () =>
      onDone(
        await api.review(taskId, decision.id, {
          verdict,
          ...(comment.trim() && { comment }),
          ...(verdict === 'approved' && isOverride && { chosen }),
        }),
      ),
    );

  return (
    <div className="input-item">
      <p className="input-kind">Approve decision</p>
      <DecisionBody decision={decision} choice={{ name: `${taskId}-${decision.id}`, chosen, onChoose: setChosen }} />
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={2}
        placeholder="Comment (required to request changes)"
      />
      <ErrorText message={error} />
      <div className="actions">
        <button type="button" className="button primary" disabled={isBusy} onClick={() => void submit('approved')}>
          {isOverride && chosen !== undefined ? `Approve option ${chosen + 1}` : 'Approve'}
        </button>
        <button type="button" className="button" disabled={isBusy || comment.trim() === ''} onClick={() => void submit('changes_requested')}>
          Request changes
        </button>
      </div>
    </div>
  );
}

/** The approval request points at the artifact; reviewing happens in the artifact's modal. */
export function ArtifactApprovalRequest({ artifact, onOpen }: { artifact: Artifact; onOpen: () => void }) {
  return (
    <div className="input-item">
      <p className="input-kind">Approve artifact</p>
      <div className="request-row">
        <button className="artifact-link" onClick={onOpen}>
          {artifact.title} <span className="muted">{artifact.kind}</span>
        </button>
        <button className="button primary" onClick={onOpen}>
          Review
        </button>
      </div>
    </div>
  );
}

/** Lets the engineer pick another option while the decision awaits approval. */
interface DecisionChoice {
  name: string;
  chosen: number | undefined;
  onChoose: (option: number) => void;
}

export function DecisionBody({ decision, choice }: { decision: Decision; choice?: DecisionChoice }) {
  const chosen = choice ? choice.chosen : (decision.approval?.chosen ?? decision.chosen);
  const isOverridden = chosen !== decision.chosen;
  return (
    <div className="decision">
      <p className="decision-problem">{decision.problem}</p>
      {decision.options.length > 0 && (
        <ol className="decision-options">
          {decision.options.map((option, i) => {
            const isChosen = i === chosen;
            // One span, so the note flows with the option text instead of becoming its own flex column.
            const text = (
              <span>
                {option}
                {isOverridden && i === decision.chosen && <span className="muted"> (agent's pick)</span>}
              </span>
            );
            return (
              <li key={i} className={isChosen ? 'decision-option decision-option-chosen' : 'decision-option'}>
                {choice ? (
                  <label className="choice">
                    <input type="radio" name={choice.name} checked={isChosen} onChange={() => choice.onChoose(i)} />
                    {text}
                  </label>
                ) : (
                  <>
                    <span className="bubble" aria-label={isChosen ? 'Chosen' : 'Not chosen'}>
                      {isChosen && <CheckIcon />}
                    </span>
                    {text}
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <p className="muted">{decision.reasoning}</p>
    </div>
  );
}

/** A pull request the PR review left open: the engineer reviews, merges or closes it on GitHub. */
export function PullRequestReviewRequest({ pullRequest }: { pullRequest: PullRequest }) {
  const outcome = pullRequest.prReview;
  return (
    <div className="input-item">
      <p className="input-kind">Review pull request</p>
      <div className="request-row">
        <a href={pullRequest.url} target="_blank" rel="noreferrer">
          <span className="mono muted">{pullRequestNumber(pullRequest.url)}</span> {pullRequest.title}
        </a>
      </div>
      {outcome && (
        <p className="muted">
          {outcome.risk && `${outcome.risk} risk · `}
          {prReviewReasons[outcome.result]}
        </p>
      )}
    </div>
  );
}

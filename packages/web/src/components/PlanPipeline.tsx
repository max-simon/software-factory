import type { PlanStep } from '@factory/core';
import { CheckIcon } from './CheckIcon.tsx';

const stepLabels: Record<PlanStep['status'], string> = { pending: 'Pending', in_progress: 'In progress', done: 'Done' };

/** The plan as connected stages; a stage's connector is green once the stage before it is done. */
export function PlanPipeline({ plan }: { plan: PlanStep[] }) {
  const current = plan.find((step) => step.status === 'in_progress');
  return (
    <>
      <ol className="pipeline">
        {plan.map((step, i) => (
          <li key={i} className={`stage stage-${step.status}`} title={`${step.title} · ${stepLabels[step.status]}`}>
            <span className="stage-track">
              <span className={`connector${i === 0 ? ' connector-none' : ''}`} />
              <span className="bubble" aria-label={stepLabels[step.status]}>
                {step.status === 'done' && <CheckIcon />}
              </span>
              <span className={`connector${i === plan.length - 1 ? ' connector-none' : ''}`} />
            </span>
            <span className="stage-title">{step.title}</span>
          </li>
        ))}
      </ol>
      {current?.nextStep && (
        <p className="pipeline-next">
          <span className="muted">Next:</span> {current.nextStep}
        </p>
      )}
    </>
  );
}

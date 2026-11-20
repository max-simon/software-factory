import { formatCost, formatDuration, formatTokens, type Project } from '@factory/core';
import { useEffect } from 'react';
import { api } from '../api.ts';
import { Markdown } from '../components/Markdown.tsx';
import { PullRequestIndicator } from '../components/PullRequestIndicator.tsx';
import { prReviewLabel, Spinner } from '../components/Status.tsx';
import { UserName } from '../components/UserName.tsx';
import { usePolling } from '../hooks.ts';
import {
  href,
  labelsByUsage,
  openPullRequests,
  projectMetrics,
  pullRequestNumber,
  relativeTime,
  repoName,
  type OpenPullRequest,
  type ProjectMetrics,
  type TaskView,
} from '../model.ts';
import { Board } from './Board.tsx';

const shownLabels = 10;

export function ProjectOverview({ id, labels }: { id: string; labels: string[] }) {
  const { data: project, error: projectError } = usePolling(() => api.getProject(id), `project-${id}`);
  const { data: tasks, error: tasksError, set: setTasks } = usePolling(() => api.listProjectTasks(id), `project-tasks-${id}`);
  const metrics = projectMetrics(tasks ?? []);

  useEffect(() => {
    if (!project) return;
    const prefix = metrics.needsInput > 0 ? `(${metrics.needsInput}) ` : '';
    document.title = `${prefix}${project.title} · Factory`;
  }, [project?.title, metrics.needsInput]);

  const error = projectError ?? tasksError;
  if (!project || !tasks) return <p className="muted">{error ? error.message : 'Loading…'}</p>;

  return (
    <article className="project">
      {error && <p className="banner">{error.message} Retrying…</p>}
      <ProjectHeader project={project} />

      <Metrics metrics={metrics} />

      <OpenPullRequests pullRequests={openPullRequests(tasks)} />

      {tasks.length === 0 ? (
        <div className="empty">
          <p>No tasks in this project yet.</p>
          <a href={href.newTask(id)}>Create the first task</a>
        </div>
      ) : (
        <>
          <LabelFilter id={id} tasks={tasks} active={labels} />
          <Board tasks={tasks} labels={labels} onMoved={setTasks} />
        </>
      )}
    </article>
  );
}

/**
 * Chips for the most used labels; each toggles a board filter kept in the URL.
 * Active labels always show, even unused ones, so every filter can be turned off.
 */
function LabelFilter({ id, tasks, active }: { id: string; tasks: readonly TaskView[]; active: readonly string[] }) {
  const popular = labelsByUsage(tasks).slice(0, shownLabels);
  const chips = [...active.filter((label) => !popular.includes(label)), ...popular];
  if (chips.length === 0) return null;
  const toggle = (label: string) => {
    const next = active.includes(label) ? active.filter((l) => l !== label) : [...active, label];
    // Replaces the entry, so the back button leaves the board instead of undoing each toggle.
    location.replace(href.project(id, next));
  };
  return (
    <div className="label-filter" role="group" aria-label="Filter by label">
      {chips.map((label) => (
        <button key={label} type="button" className="label" aria-pressed={active.includes(label)} onClick={() => toggle(label)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** Title, actions, who created the project and its description. */
export function ProjectHeader({ project }: { project: Project }) {
  return (
    <header className="task-header">
      <div className="task-heading">
        <h1>{project.title}</h1>
        <div className="actions">
          <a className="button" href={href.editProject(project.id)}>
            Edit
          </a>
          <a className="button primary" href={href.newTask(project.id)}>
            New task
          </a>
        </div>
      </div>
      <p className="meta">
        <span className="created-by">
          created by <UserName id={project.createdBy} />
        </span>
        <span title={project.createdAt}>{relativeTime(project.createdAt)}</span>
      </p>
      {project.description.trim() && (
        <div className="project-description">
          <Markdown>{project.description}</Markdown>
        </div>
      )}
    </header>
  );
}

// Status counts other than done live in the board's column headers, so tiles hold only totals.
function Metrics({ metrics }: { metrics: ProjectMetrics }) {
  const tiles: Array<{ label: string; value: string; detail?: string; isAlarming?: boolean; title?: string }> = [
    {
      label: 'Done',
      value: `${metrics.done} / ${metrics.tasks}`,
      ...(metrics.failed > 0 && { detail: `${metrics.failed} failed`, isAlarming: true }),
    },
    {
      label: 'Merged PRs',
      value: String(metrics.mergedPullRequests),
      ...(metrics.openPullRequests > 0 && { detail: `${metrics.openPullRequests} open` }),
    },
    {
      label: 'Agent time',
      value: formatDuration(metrics.durationMs),
      title: 'Wall-clock time of every agent session, summed over all tasks',
    },
    {
      label: 'Cost (est.)',
      value: formatCost(metrics.costUsd),
      detail: `${formatTokens(metrics.tokens)} tokens`,
      title: 'Estimate at list prices and tokens used, summed over all tasks; not a billed amount',
    },
  ];
  return (
    <dl className="metrics">
      {tiles.map((tile) => (
        <div key={tile.label} className="metric" title={tile.title}>
          <dt>{tile.label}</dt>
          <dd>
            {tile.value}
            {tile.detail && <span className={tile.isAlarming ? 'metric-detail failure' : 'metric-detail'}>{tile.detail}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function OpenPullRequests({ pullRequests }: { pullRequests: OpenPullRequest[] }) {
  if (pullRequests.length === 0) return null;
  return (
    <section className="box open-pull-requests">
      <h2 className="section-title">Open pull requests</h2>
      <ul className="plain">
        {pullRequests.map(({ pullRequest: pr, task }) => (
          <li key={pr.url}>
            <a href={pr.url} target="_blank" rel="noreferrer">
              <span className="mono muted">
                {repoName(pr.url.replace(/\/pull\/\d+$/, ''))} {pullRequestNumber(pr.url)}
              </span>{' '}
              {pr.title}
            </a>
            <PullRequestIndicator pullRequest={pr} />
            <Spinner isBusy={pr.isUnderReview} label={prReviewLabel} />
            <a className="open-pull-request-task muted" href={href.task(task.id)}>
              {task.title}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

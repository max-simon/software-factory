import { unmetDependencies } from '@factory/core';
import { useState, type DragEvent, type KeyboardEvent } from 'react';
import { api } from '../api.ts';
import { AssigneeBadges } from '../components/Assignees.tsx';
import { ErrorText } from '../components/ErrorText.tsx';
import { HeartbeatNote, Spinner, specReviewLabel, StatusDot } from '../components/Status.tsx';
import { useAction } from '../hooks.ts';
import {
  boardColumns,
  heartbeatInfo,
  href,
  inputSummary,
  moveToSlot,
  relativeTime,
  repoName,
  statusLabel,
  type BoardColumn,
  type TaskView,
} from '../model.ts';

const finishedPreview = 8;

type Move = (id: string, slot: number) => void;

/** Per queued task, how many of its dependencies are not done yet; absent when none. */
type Waiting = ReadonlyMap<string, number>;

function waitingCounts(tasks: readonly TaskView[]): Waiting {
  return new Map(
    tasks.flatMap((task) => {
      const count = task.status === 'queued' ? unmetDependencies(task, tasks).length : 0;
      return count > 0 ? [[task.id, count] as const] : [];
    }),
  );
}

/** One project's tasks in columns; `onMoved` receives the project's tasks in their new order. */
export function Board({ tasks, onMoved }: { tasks: readonly TaskView[]; onMoved: (tasks: TaskView[]) => void }) {
  const moving = useAction();
  const columns = boardColumns(tasks);
  const waiting = waitingCounts(tasks);

  const move = (column: BoardColumn, id: string, slot: number) => {
    const target = moveToSlot(column.tasks, id, slot);
    // A move computed from the order before a pending one finishes would land in the wrong place.
    if (target && !moving.isBusy) void moving.run(async () => onMoved(await api.moveTask(id, target)));
  };
  return (
    <>
      <ErrorText message={moving.error} />
      <div className="board">
        {columns.map((column) => (
          <Column key={column.key} column={column} waiting={waiting} onMove={(id, slot) => move(column, id, slot)} />
        ))}
      </div>
    </>
  );
}

function Column({ column, waiting, onMove }: { column: BoardColumn; waiting: Waiting; onMove: Move }) {
  const [drag, setDrag] = useState<{ id: string; slot: number }>();
  const [showAll, setShowAll] = useState(false);
  const isCollapsible = !column.isRanked && column.tasks.length > finishedPreview;
  const shown = isCollapsible && !showAll ? column.tasks.slice(0, finishedPreview) : column.tasks;
  // The drop line shows only where dropping would change the order.
  const dropSlot = drag && moveToSlot(column.tasks, drag.id, drag.slot) ? drag.slot : undefined;

  const trackSlot = (index: number) => (event: DragEvent<HTMLLIElement>) => {
    if (!drag) return;
    const { top, height } = event.currentTarget.getBoundingClientRect();
    const slot = event.clientY < top + height / 2 ? index : index + 1;
    if (slot !== drag.slot) setDrag({ ...drag, slot });
  };
  const drop = (event: DragEvent) => {
    if (!drag) return;
    event.preventDefault();
    onMove(drag.id, drag.slot);
    setDrag(undefined);
  };

  return (
    <section className={`column column-${column.key}`} aria-label={column.title}>
      <h2 className="section-title">
        {column.title} <span className="count">{column.tasks.length}</span>
      </h2>
      <ul
        className="cards"
        // Without preventDefault the browser refuses the drop; drags from other columns stay refused.
        onDragOver={(event) => drag && event.preventDefault()}
        onDrop={drop}
      >
        {shown.map((task, index) => (
          <li
            key={task.id}
            draggable={column.isRanked}
            className={[
              drag?.id === task.id && 'dragging',
              dropSlot === index && 'drop-before',
              dropSlot === index + 1 && index === shown.length - 1 && 'drop-after',
            ]
              .filter(Boolean)
              .join(' ')}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move';
              setDrag({ id: task.id, slot: index });
            }}
            onDragOver={trackSlot(index)}
            onDragEnd={() => setDrag(undefined)}
          >
            <TaskCard
              task={task}
              waitingFor={waiting.get(task.id)}
              onKeyDown={column.isRanked ? moveByKey(task.id, index, onMove) : undefined}
            />
          </li>
        ))}
      </ul>
      {isCollapsible && (
        <button className="link" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show fewer' : `Show all ${column.tasks.length}`}
        </button>
      )}
    </section>
  );
}

/** Alt+Up and Alt+Down move the focused card, so reordering works without a mouse. */
const moveByKey = (id: string, index: number, onMove: Move) => (event: KeyboardEvent) => {
  if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
  event.preventDefault();
  onMove(id, event.key === 'ArrowUp' ? index - 1 : index + 2);
};

function TaskCard({
  task,
  waitingFor,
  onKeyDown,
}: {
  task: TaskView;
  waitingFor: number | undefined;
  onKeyDown: ((event: KeyboardEvent) => void) | undefined;
}) {
  const summary = inputSummary(task);
  const heartbeat = heartbeatInfo(task);
  return (
    <a
      className="card"
      href={href.task(task.id)}
      onKeyDown={onKeyDown}
      {...(onKeyDown && { 'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown' })}
    >
      <span className="card-title">{task.title}</span>
      <span className="card-meta" title={heartbeat?.tooltip}>
        <StatusDot status={task.status} />
        {summary ? (
          <span className="attention">{summary}</span>
        ) : waitingFor ? (
          `Waiting for ${waitingFor} ${waitingFor === 1 ? 'task' : 'tasks'}`
        ) : (
          statusLabel(task.status)
        )}
        <Spinner isBusy={task.isSpecUnderReview} label={specReviewLabel} />
        <HeartbeatNote task={task} isCompact />
        <span className="card-time">{relativeTime(task.updatedAt)}</span>
        <AssigneeBadges assignees={task.assignees} />
      </span>
      {(task.repoUrl || task.labels.length > 0) && (
        <span className="card-meta">
          {task.repoUrl && <span>{repoName(task.repoUrl)}</span>}
          {task.labels.map((label) => (
            <span key={label} className="label">
              {label}
            </span>
          ))}
        </span>
      )}
    </a>
  );
}

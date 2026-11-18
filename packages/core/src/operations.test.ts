import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DomainError, type DomainErrorCode } from './errors.ts';
import {
  addArtifact,
  addDecision,
  addFollowUp,
  addPullRequest,
  addSessionMetrics,
  answerQuestion,
  askQuestion,
  cancelTask,
  hasOpenInput,
  reviewItem,
  createTask,
  detachExecution,
  editTask,
  isRestartable,
  markDone,
  markFailed,
  markInProgress,
  markReady,
  moveTask,
  nextRank,
  replacePlan,
  requestClarification,
  restartTask,
  returnToDraft,
  startTask,
  updatePullRequests,
  type NewQuestion,
} from './operations.ts';
import type { PullRequest, Question, Task, TaskStatus } from './task.ts';

const repoUrl = 'https://github.com/O/r.git';

const taskIn = (status: TaskStatus, overrides: Partial<Task> = {}): Task => ({
  ...createTask({ projectId: 'p1', title: 't', specification: 's', repoUrl }, { id: 'task-1', now: '2026-01-01T00:00:00Z', rank: 0 }),
  status,
  ...overrides,
});

const supervised = (status: TaskStatus, questions: Question[] = []): Task =>
  taskIn(status, { autonomyMode: 'supervised', questions });

const question = (id: string, type: Question['type'], options: string[] = [], answer?: string[]): Question => ({
  id,
  createdAt: '2026-01-01T00:00:00Z',
  problem: `problem ${id}`,
  type,
  options,
  ...(answer ? { answer } : {}),
});

const rejectsWith = (code: DomainErrorCode) => (error: unknown) =>
  error instanceof DomainError && error.code === code;

const frozen = (task: Task): Task => structuredClone(task);

const ada = { userId: 'u1' };

describe('createTask', () => {
  const meta = { id: 'abc', now: '2026-01-01T00:00:00Z', rank: 3 };

  it('applies defaults', () => {
    const task = createTask({ projectId: 'p1', title: 't', specification: 's', repoUrl }, meta);
    assert.equal(task.id, 'abc');
    assert.equal(task.projectId, 'p1');
    assert.equal(task.createdAt, meta.now);
    assert.equal(task.updatedAt, meta.now);
    assert.equal(task.autonomyMode, 'autonomous');
    assert.equal(task.model, 'opus');
    assert.equal(task.agent, 'claude');
    assert.deepEqual(task.labels, []);
    assert.equal(task.status, 'draft');
    assert.equal(task.rank, 3);
    assert.deepEqual(
      [task.plan, task.decisions, task.artifacts, task.questions, task.pullRequests, task.followUps],
      [[], [], [], [], [], []],
    );
    assert.equal('baseBranch' in task, false);
  });

  it('creates a task without repository', () => {
    const task = createTask({ projectId: 'p1', title: 't', specification: 's' }, meta);
    assert.equal('repoUrl' in task, false);
  });

  it('keeps explicit values', () => {
    const task = createTask(
      {
        projectId: 'p1',
        title: 't',
        specification: 's',
        repoUrl,
        labels: ['x'],
        autonomyMode: 'supervised',
        baseBranch: 'dev',
        model: 'sonnet',
        agent: 'opencode',
      },
      meta,
    );
    assert.deepEqual(task.labels, ['x']);
    assert.equal(task.autonomyMode, 'supervised');
    assert.equal(task.baseBranch, 'dev');
    assert.equal(task.model, 'sonnet');
    assert.equal(task.agent, 'opencode');
  });
});

describe('editTask', () => {
  it('edits a draft task and keeps unset fields', () => {
    const task = taskIn('draft');
    const edited = editTask(task, { title: 'new', labels: ['a'] }, []);
    assert.equal(edited.title, 'new');
    assert.equal(edited.specification, task.specification);
    assert.deepEqual(edited.labels, ['a']);
  });

  it('edits a task that awaits clarification', () => {
    assert.equal(editTask(taskIn('clarification_required'), { specification: 'clear' }, []).specification, 'clear');
  });

  it('rejects every queued or later status', () => {
    for (const status of ['queued', 'in_progress', 'input_required', 'ready', 'done', 'failed'] as const) {
      assert.throws(() => editTask(taskIn(status), { title: 'x' }, []), rejectsWith('not_editable'));
    }
  });

  it('changes only the dependencies of a queued task, and refuses content changes with them', () => {
    const dependency = taskIn('draft', { id: 'dep' });
    const task = taskIn('queued');
    assert.deepEqual(editTask(task, { dependsOn: ['dep'] }, [dependency, task]).dependsOn, ['dep']);
    assert.throws(() => editTask(task, { title: 'x', dependsOn: ['dep'] }, [dependency, task]), rejectsWith('not_editable'));
  });

  it('does not mutate its input', () => {
    const task = taskIn('draft');
    const before = frozen(task);
    editTask(task, { title: 'x' }, []);
    assert.deepEqual(task, before);
  });
});

describe('lifecycle', () => {
  it('startTask moves draft to queued', () => {
    assert.equal(startTask(taskIn('draft')).status, 'queued');
  });

  it('startTask queues a task that awaits clarification and drops the note', () => {
    const task = startTask(taskIn('clarification_required', { clarification: 'which API?' }));
    assert.equal(task.status, 'queued');
    assert.equal('clarification' in task, false);
  });

  it('startTask rejects queued or later statuses', () => {
    for (const status of ['queued', 'in_progress', 'failed', 'done'] as const) {
      assert.throws(() => startTask(taskIn(status)), rejectsWith('invalid_transition'), status);
    }
  });

  it('markInProgress sets token hash and execution id and marks the worker working', () => {
    const task = markInProgress(taskIn('queued'), { tokenHash: 'h', executionId: 'c' }, '2026-01-02T00:00:00Z');
    assert.equal(task.status, 'in_progress');
    assert.deepEqual(task.execution, { id: 'c', tokenHash: 'h', worker: { state: 'working', since: '2026-01-02T00:00:00Z' } });
  });

  it('markInProgress rejects every status but queued, so a cancelled task stays failed', () => {
    for (const status of ['draft', 'failed', 'ready'] as const) {
      assert.throws(
        () => markInProgress(taskIn(status), { tokenHash: 'h', executionId: 'c' }, '2026-01-02T00:00:00Z'),
        rejectsWith('invalid_transition'),
        status,
      );
    }
  });

  it('markReady moves in_progress to ready', () => {
    assert.equal(markReady(taskIn('in_progress')).status, 'ready');
  });

  it('markReady rejects input_required', () => {
    assert.throws(() => markReady(taskIn('input_required')), rejectsWith('invalid_transition'));
  });

  it('markDone moves ready to done', () => {
    assert.equal(markDone(taskIn('ready')).status, 'done');
  });

  it('markDone rejects in_progress', () => {
    assert.throws(() => markDone(taskIn('in_progress')), rejectsWith('invalid_transition'));
  });

  it('markFailed records the reason from every status that has started or is queued', () => {
    for (const status of ['queued', 'in_progress', 'input_required', 'ready'] as const) {
      const task = markFailed(taskIn(status), 'boom');
      assert.equal(task.status, 'failed');
      assert.equal(task.failureReason, 'boom');
    }
  });

  it('markFailed rejects drafts, done and failed', () => {
    for (const status of ['draft', 'clarification_required', 'done', 'failed'] as const) {
      assert.throws(() => markFailed(taskIn(status), 'x'), rejectsWith('invalid_transition'));
    }
  });

  it('does not mutate its input', () => {
    const task = taskIn('queued');
    const before = frozen(task);
    markInProgress(task, { tokenHash: 'h', executionId: 'c' }, '2026-01-02T00:00:00Z');
    markFailed(task, 'x');
    assert.deepEqual(task, before);
  });
});

describe('cancelTask', () => {
  it('fails a queued or running task with a reason and drops its token and execution', () => {
    for (const status of ['queued', 'in_progress', 'input_required', 'ready'] as const) {
      const execution = { id: 'c', tokenHash: 'h', worker: { state: 'working' as const, since: 'x' }, console: { url: 'u', password: 'p' } };
      const task = cancelTask(taskIn(status, { execution }));
      assert.equal(task.status, 'failed');
      assert.equal(task.failureReason, 'Cancelled by the engineer');
      assert.equal('execution' in task, false);
    }
  });

  it('rejects draft, done and failed tasks', () => {
    for (const status of ['draft', 'done', 'failed'] as const) {
      assert.throws(() => cancelTask(taskIn(status)), rejectsWith('invalid_transition'), status);
    }
  });
});

describe('clarification', () => {
  it('requestClarification holds a draft with the trimmed note', () => {
    const task = requestClarification(taskIn('draft'), '  which API?  ');
    assert.equal(task.status, 'clarification_required');
    assert.equal(task.clarification, 'which API?');
  });

  it('requestClarification needs a note', () => {
    assert.throws(() => requestClarification(taskIn('draft'), '  '), rejectsWith('invalid_clarification'));
  });

  it('requestClarification accepts drafts only', () => {
    for (const status of ['clarification_required', 'queued', 'in_progress', 'done'] as const) {
      assert.throws(() => requestClarification(taskIn(status), 'n'), rejectsWith('invalid_transition'), status);
    }
  });

  it('returnToDraft settles the clarification', () => {
    const task = returnToDraft(taskIn('clarification_required', { clarification: 'which API?' }));
    assert.equal(task.status, 'draft');
    assert.equal('clarification' in task, false);
  });

  it('returnToDraft rejects tasks that await no clarification', () => {
    for (const status of ['draft', 'queued'] as const) {
      assert.throws(() => returnToDraft(taskIn(status)), rejectsWith('invalid_transition'), status);
    }
  });

  it('a task awaiting clarification has not started, so it cannot be restarted', () => {
    assert.equal(isRestartable('clarification_required'), false);
  });
});

describe('restartTask', () => {
  const ran = (status: TaskStatus): Task =>
    taskIn(status, {
      rank: 3,
      plan: [{ title: 'p', status: 'done' }],
      decisions: [{ id: 'd1', createdAt: 'x', problem: 'p', options: [], reasoning: 'r' }],
      artifacts: [{ id: 'a1', createdAt: 'x', title: 't', kind: 'k', content: 'c' }],
      questions: [{ id: 'q1', createdAt: 'x', problem: 'p', type: 'text', options: [] }],
      pullRequests: [{ url: `${repoUrl}/pull/1`, title: 't', status: 'open' }],
      followUps: [{ id: 'f1', createdAt: 'x', message: 'm' }],
      failureReason: 'boom',
      metrics: { durationMs: 10, costUsd: 1 },
      execution: {
        id: 'c',
        tokenHash: 'h',
        worker: { state: 'idle', since: 'x' },
        workAcceptedAt: 'x',
        lastHeartbeat: { at: 'x', phase: 'working' },
        console: { url: 'http://127.0.0.1:1', password: 'pw' },
      },
    });

  it('queues a started task at its rank with its progress and execution cleared, keeping metrics', () => {
    for (const status of ['in_progress', 'input_required', 'ready', 'done', 'failed'] as const) {
      const before = ran(status);
      const task = restartTask(before);
      const { id, projectId, title, specification, labels, autonomyMode, model, agent, repoUrl: repo, rank, dependsOn, createdAt, updatedAt, metrics } = before;
      assert.deepEqual(task, {
        id,
        createdAt,
        updatedAt,
        projectId,
        title,
        specification,
        labels,
        autonomyMode,
        model,
        agent,
        repoUrl: repo,
        rank,
        dependsOn,
        metrics,
        status: 'queued',
        plan: [],
        decisions: [],
        artifacts: [],
        questions: [],
        pullRequests: [],
        followUps: [],
      });
    }
  });

  it('rejects draft and queued tasks', () => {
    for (const status of ['draft', 'queued'] as const) {
      assert.throws(() => restartTask(taskIn(status)), rejectsWith('invalid_transition'), status);
    }
  });
});

describe('detachExecution', () => {
  it('removes the execution with token, worker state and console and keeps the rest', () => {
    const task = taskIn('in_progress', { execution: { id: 'c', tokenHash: 'h', worker: { state: 'idle', since: '2026-01-02T00:00:00Z' } } });
    const detached = detachExecution(task);
    const { execution: _removed, ...rest } = task;
    assert.deepEqual(detached, rest);
    assert.equal(task.execution?.id, 'c');
  });
});

describe('addSessionMetrics', () => {
  it('starts the totals with the first report', () => {
    const task = taskIn('in_progress');
    assert.deepEqual(addSessionMetrics(task, { durationMs: 1500, costUsd: 0.25 }).metrics, { durationMs: 1500, costUsd: 0.25 });
    assert.equal('metrics' in task, false);
  });

  it('sums later reports', () => {
    const task = taskIn('in_progress', { metrics: { durationMs: 1000, costUsd: 0.5 } });
    assert.deepEqual(addSessionMetrics(task, { durationMs: 250, costUsd: 0.25 }).metrics, { durationMs: 1250, costUsd: 0.75 });
  });

  it('is accepted in every status and changes nothing else', () => {
    const statuses: TaskStatus[] = ['draft', 'queued', 'in_progress', 'input_required', 'ready', 'done', 'failed'];
    for (const status of statuses) {
      const task = taskIn(status);
      assert.deepEqual(addSessionMetrics(task, { durationMs: 1, costUsd: 0 }), { ...task, metrics: { durationMs: 1, costUsd: 0 } });
    }
  });
});

describe('reports', () => {
  const plan = [{ title: 'a', status: 'pending' as const }];
  const decision = { id: 'd1', createdAt: '2026-01-01T00:00:00Z', problem: 'p', options: ['x', 'y'], chosen: 0, reasoning: 'r' };
  const artifact = { id: 'a1', createdAt: '2026-01-01T00:00:00Z', title: 't', kind: 'md', content: 'c' };
  const reports: Record<string, (task: Task) => Task> = {
    replacePlan: (task) => replacePlan(task, plan),
    addDecision: (task) => addDecision(task, decision),
    addArtifact: (task) => addArtifact(task, artifact),
    addPullRequest: (task) => addPullRequest(task, { url: 'https://github.com/o/r/pull/1', title: 'pr' }),
  };

  for (const [name, report] of Object.entries(reports)) {
    it(`${name} works while active`, () => {
      for (const status of ['in_progress', 'input_required'] as const) {
        assert.doesNotThrow(() => report(taskIn(status)));
      }
    });

    it(`${name} is rejected when not active`, () => {
      for (const status of ['draft', 'queued', 'ready', 'done', 'failed'] as const) {
        assert.throws(() => report(taskIn(status)), rejectsWith('not_active'));
      }
    });

    it(`${name} does not mutate its input`, () => {
      const task = taskIn('in_progress');
      const before = frozen(task);
      report(task);
      assert.deepEqual(task, before);
    });
  }

  it('replacePlan replaces the previous plan', () => {
    const task = replacePlan(taskIn('in_progress', { plan: [{ title: 'old', status: 'done' }] }), plan);
    assert.deepEqual(task.plan, plan);
  });

  it('addDecision and addArtifact append', () => {
    const task = taskIn('in_progress');
    assert.deepEqual(addDecision(addDecision(task, decision), decision).decisions, [decision, decision]);
    assert.deepEqual(addArtifact(task, artifact).artifacts, [artifact]);
  });
});

describe('addPullRequest', () => {
  const active = taskIn('in_progress');
  const pr = (url: string) => ({ url, title: 'pr' });

  it('accepts a pull request of the task repository as open', () => {
    const task = addPullRequest(active, pr('https://github.com/o/r/pull/1'));
    assert.deepEqual(task.pullRequests, [{ ...pr('https://github.com/o/r/pull/1'), status: 'open' }]);
  });

  it('rejects any pull request on a task without repository', () => {
    const { repoUrl: _none, ...repoLess } = active;
    assert.throws(() => addPullRequest(repoLess, pr('https://github.com/o/r/pull/1')), rejectsWith('foreign_pull_request'));
  });

  it('ignores a duplicate URL', () => {
    const once = addPullRequest(active, pr('https://github.com/o/r/pull/1'));
    const twice = addPullRequest(once, { url: 'https://github.com/o/r/pull/1', title: 'other' });
    assert.deepEqual(twice.pullRequests, once.pullRequests);
  });

  it('rejects foreign pull requests', () => {
    for (const url of [
      'https://github.com/o/other/pull/1',
      'https://github.com/x/r/pull/1',
      'https://github.com/o/r/issues/1',
      'https://github.com/o/r/pull/abc',
      'https://github.com/o/r',
      'https://gitlab.com/o/r/pull/1',
      'not a url',
    ]) {
      assert.throws(() => addPullRequest(active, pr(url)), rejectsWith('foreign_pull_request'), url);
    }
  });
});

describe('updatePullRequests', () => {
  const first = { url: 'https://github.com/o/r/pull/1', title: 'One', status: 'open' as const };
  const second = { url: 'https://github.com/o/r/pull/2', title: 'Two', status: 'open' as const };
  const watched = (status: TaskStatus) => taskIn(status, { pullRequests: [first, second] });

  it('replaces title and status of the given pull requests and keeps the others and their order', () => {
    const merged = { ...second, title: 'Two, renamed', status: 'merged' as const };
    assert.deepEqual(updatePullRequests(watched('ready'), [merged]).pullRequests, [first, merged]);
  });

  it('keeps the recorded conflict state while the host has not computed it', () => {
    const conflicted = taskIn('ready', { pullRequests: [{ ...first, hasConflicts: true }, second] });
    const renamed = { ...first, title: 'One, renamed' };
    assert.deepEqual(updatePullRequests(conflicted, [renamed]).pullRequests[0], { ...renamed, hasConflicts: true });
    assert.equal(updatePullRequests(conflicted, [{ ...first, hasConflicts: false }]).pullRequests[0]!.hasConflicts, false);
    assert.equal('hasConflicts' in updatePullRequests(watched('ready'), [first]).pullRequests[0]!, false);
  });

  it('is accepted while the runner runs and rejected before dispatch and after the end', () => {
    for (const status of ['in_progress', 'input_required', 'ready', 'failed'] as const) {
      assert.doesNotThrow(() => updatePullRequests(watched(status), [first]));
    }
    for (const status of ['draft', 'queued', 'done'] as const) {
      assert.throws(() => updatePullRequests(watched(status), [first]), rejectsWith('not_active'));
    }
  });

  it('rejects a pull request the agent never reported', () => {
    const unknown = { ...first, url: 'https://github.com/o/r/pull/3' };
    assert.throws(() => updatePullRequests(watched('ready'), [unknown]), rejectsWith('unknown_pull_request'));
  });

  it('does not mutate its input', () => {
    const task = watched('ready');
    const before = frozen(task);
    updatePullRequests(task, [{ ...first, status: 'closed' }]);
    assert.deepEqual(task, before);
  });
});

describe('askQuestion', () => {
  const ask = (id: string): NewQuestion => ({ id, createdAt: '2026-01-01T00:00:00Z', problem: 'p', type: 'text', options: [] });

  it('is rejected on an autonomous task', () => {
    assert.throws(() => askQuestion(taskIn('in_progress'), ask('q1')), rejectsWith('questions_not_allowed'));
  });

  it('is rejected on a supervised task that is not active', () => {
    assert.throws(() => askQuestion(supervised('ready'), ask('q1')), rejectsWith('not_active'));
  });

  it('moves in_progress to input_required', () => {
    const task = askQuestion(supervised('in_progress'), ask('q1'));
    assert.equal(task.status, 'input_required');
    assert.deepEqual(task.questions, [ask('q1')]);
  });

  it('stays input_required for a second question', () => {
    const task = askQuestion(askQuestion(supervised('in_progress'), ask('q1')), ask('q2'));
    assert.equal(task.status, 'input_required');
    assert.deepEqual(task.questions.map((q) => q.id), ['q1', 'q2']);
  });

  it('does not mutate its input', () => {
    const task = supervised('in_progress');
    const before = frozen(task);
    askQuestion(task, ask('q1'));
    assert.deepEqual(task, before);
  });
});

describe('answerQuestion', () => {
  const inputRequired = (...questions: Question[]) => supervised('input_required', questions);

  it('stores the answer and returns to in_progress when none are open', () => {
    const task = answerQuestion(inputRequired(question('q1', 'text')), 'q1', ['yes'], ada);
    assert.deepEqual(task.questions[0]!.answer, ['yes']);
    assert.equal(task.questions[0]!.answeredBy, 'u1');
    assert.equal(task.status, 'in_progress');
  });

  it('stays input_required while another question is open', () => {
    const task = answerQuestion(inputRequired(question('q1', 'text'), question('q2', 'text')), 'q1', ['a'], ada);
    assert.equal(task.status, 'input_required');
    assert.equal(task.questions[1]!.answer, undefined);
  });

  it('returns to in_progress after answering the last open question', () => {
    const start = inputRequired(question('q1', 'text'), question('q2', 'text'));
    const task = answerQuestion(answerQuestion(start, 'q1', ['a'], ada), 'q2', ['b'], ada);
    assert.equal(task.status, 'in_progress');
  });

  it('accepts valid radio and checkbox answers', () => {
    const radio = inputRequired(question('q1', 'radio', ['a', 'b']));
    assert.deepEqual(answerQuestion(radio, 'q1', ['b'], ada).questions[0]!.answer, ['b']);
    const checkbox = inputRequired(question('q1', 'checkbox', ['a', 'b', 'c']));
    assert.deepEqual(answerQuestion(checkbox, 'q1', ['a', 'c'], ada).questions[0]!.answer, ['a', 'c']);
  });

  it('marks an answer the input reviewer gave with its rationale', () => {
    const task = answerQuestion(inputRequired(question('q1', 'text')), 'q1', ['yes'], { reviewer: { rationale: 'The spec says so.' } });
    assert.deepEqual(task.questions[0]!.byReviewer, { rationale: 'The spec says so.' });
    assert.equal('answeredBy' in task.questions[0]!, false);
    assert.equal(answerQuestion(inputRequired(question('q1', 'text')), 'q1', ['yes'], ada).questions[0]!.byReviewer, undefined);
  });

  it('accepts a checkbox answer with zero options', () => {
    const task = answerQuestion(inputRequired(question('q1', 'checkbox', ['a'])), 'q1', [], ada);
    assert.deepEqual(task.questions[0]!.answer, []);
    assert.equal(task.status, 'in_progress');
  });

  it('rejects an unknown question id', () => {
    assert.throws(() => answerQuestion(inputRequired(question('q1', 'text')), 'nope', ['x'], ada), rejectsWith('unknown_question'));
  });

  it('rejects an already answered question', () => {
    const task = inputRequired(question('q1', 'text', [], ['a']), question('q2', 'text'));
    assert.throws(() => answerQuestion(task, 'q1', ['b'], ada), rejectsWith('invalid_answer'));
  });

  it('rejects invalid answers', () => {
    const cases: Array<[string, Question, string[]]> = [
      ['empty text', question('q1', 'text'), ['  ']],
      ['no text element', question('q1', 'text'), []],
      ['two text elements', question('q1', 'text'), ['a', 'b']],
      ['radio with no answer', question('q1', 'radio', ['a', 'b']), []],
      ['radio with two answers', question('q1', 'radio', ['a', 'b']), ['a', 'b']],
      ['radio with unoffered option', question('q1', 'radio', ['a', 'b']), ['z']],
      ['checkbox with unoffered option', question('q1', 'checkbox', ['a', 'b']), ['a', 'z']],
      ['checkbox with repeated option', question('q1', 'checkbox', ['a', 'b']), ['a', 'a']],
    ];
    for (const [name, q, answer] of cases) {
      assert.throws(() => answerQuestion(inputRequired(q), 'q1', answer, ada), rejectsWith('invalid_answer'), name);
    }
  });

  it('rejects answering when the task is not input_required', () => {
    const task = supervised('in_progress', [question('q1', 'text')]);
    assert.throws(() => answerQuestion(task, 'q1', ['a'], ada), rejectsWith('invalid_transition'));
  });

  it('does not mutate its input or the answer array', () => {
    const task = inputRequired(question('q1', 'checkbox', ['a']));
    const before = frozen(task);
    const answer = ['a'];
    const result = answerQuestion(task, 'q1', answer, ada);
    answer.push('mutated');
    assert.deepEqual(task, before);
    assert.deepEqual(result.questions[0]!.answer, ['a']);
  });
});

describe('approval requests', () => {
  const decision = { id: 'd1', createdAt: '2026-01-01T00:00:00Z', problem: 'p', options: ['x', 'y'], chosen: 0, reasoning: 'r' };
  const artifact = { id: 'a1', createdAt: '2026-01-01T00:00:00Z', title: 't', kind: 'md', content: 'c' };

  it('are rejected on an autonomous task', () => {
    assert.throws(() => addDecision(taskIn('in_progress'), { ...decision, requestApproval: true }), rejectsWith('approvals_not_allowed'));
    assert.throws(() => addArtifact(taskIn('in_progress'), { ...artifact, requestApproval: true }), rejectsWith('approvals_not_allowed'));
  });

  it('are rejected on a supervised task that is not active', () => {
    assert.throws(() => addDecision(supervised('ready'), { ...decision, requestApproval: true }), rejectsWith('not_active'));
  });

  it('mark the item pending and move in_progress to input_required', () => {
    const task = addArtifact(addDecision(supervised('in_progress'), { ...decision, requestApproval: true }), {
      ...artifact,
      requestApproval: true,
    });
    assert.equal(task.status, 'input_required');
    assert.deepEqual(task.decisions, [{ ...decision, approval: { status: 'pending' } }]);
    assert.deepEqual(task.artifacts, [{ ...artifact, approval: { status: 'pending' } }]);
  });

  it('without the flag leave status and approval untouched', () => {
    const task = addDecision(supervised('in_progress'), { ...decision, requestApproval: false });
    assert.equal(task.status, 'in_progress');
    assert.deepEqual(task.decisions, [decision]);
  });
});

describe('reviewItem', () => {
  const pending = { status: 'pending' as const };
  const awaiting = (overrides: Partial<Task> = {}): Task =>
    taskIn('input_required', {
      autonomyMode: 'supervised',
      decisions: [{ id: 'd1', createdAt: '2026-01-01T00:00:00Z', problem: 'p', options: ['x'], chosen: 0, reasoning: 'r', approval: pending }],
      artifacts: [{ id: 'a1', createdAt: '2026-01-01T00:00:00Z', title: 't', kind: 'md', content: 'c', approval: pending }],
      ...overrides,
    });

  it('approves with an optional comment and stays input_required while another item is pending', () => {
    const task = reviewItem(awaiting(), 'd1', { verdict: 'approved', comment: ' ok ' }, ada);
    assert.deepEqual(task.decisions[0]!.approval, { status: 'approved', comment: 'ok', reviewedBy: 'u1' });
    assert.equal(task.status, 'input_required');
  });

  it('marks a review by the input reviewer with its rationale', () => {
    const task = reviewItem(awaiting(), 'd1', { verdict: 'approved' }, { reviewer: { rationale: 'Matches the spec.' } });
    assert.deepEqual(task.decisions[0]!.approval, { status: 'approved', byReviewer: { rationale: 'Matches the spec.' } });
  });

  it('returns to in_progress once nothing is open', () => {
    const once = reviewItem(awaiting(), 'd1', { verdict: 'approved' }, ada);
    const task = reviewItem(once, 'a1', { verdict: 'changes_requested', comment: 'shorter' }, ada);
    assert.deepEqual(task.artifacts[0]!.approval, { status: 'changes_requested', comment: 'shorter', reviewedBy: 'u1' });
    assert.equal(task.status, 'in_progress');
  });

  it('stays input_required while a question is open', () => {
    const task = reviewItem(awaiting({ artifacts: [], questions: [question('q1', 'text')] }), 'd1', { verdict: 'approved' }, ada);
    assert.equal(task.status, 'input_required');
  });

  it('stores annotations and accepts them instead of an overall comment when requesting changes', () => {
    const annotations = [{ quote: 'c', comment: 'expand this' }];
    const task = reviewItem(awaiting(), 'a1', { verdict: 'changes_requested', annotations }, ada);
    assert.deepEqual(task.artifacts[0]!.approval, { status: 'changes_requested', annotations, reviewedBy: 'u1' });
    annotations[0]!.comment = 'mutated';
    assert.equal(task.artifacts[0]!.approval!.annotations![0]!.comment, 'expand this');
  });

  it('records an approved decision with another option as an override', () => {
    const decisions = [{ id: 'd1', createdAt: '2026-01-01T00:00:00Z', problem: 'p', options: ['x', 'y'], chosen: 0, reasoning: 'r', approval: pending }];
    const task = reviewItem(awaiting({ decisions }), 'd1', { verdict: 'approved', chosen: 1 }, ada);
    assert.deepEqual(task.decisions[0]!.approval, { status: 'approved', chosen: 1, reviewedBy: 'u1' });
    assert.equal(task.decisions[0]!.chosen, 0);
  });

  it('records no override when the agent\'s own option is picked', () => {
    const task = reviewItem(awaiting(), 'd1', { verdict: 'approved', chosen: 0 }, ada);
    assert.deepEqual(task.decisions[0]!.approval, { status: 'approved', reviewedBy: 'u1' });
  });

  it('rejects a pick outside the options, on an artifact or with a change request', () => {
    for (const chosen of [1, -1, 0.5]) {
      assert.throws(() => reviewItem(awaiting(), 'd1', { verdict: 'approved', chosen }, ada), rejectsWith('invalid_review'));
    }
    assert.throws(() => reviewItem(awaiting(), 'a1', { verdict: 'approved', chosen: 0 }, ada), rejectsWith('invalid_review'));
    assert.throws(
      () => reviewItem(awaiting(), 'd1', { verdict: 'changes_requested', comment: 'no', chosen: 0 }, ada),
      rejectsWith('invalid_review'),
    );
  });

  it('requires a comment when requesting changes', () => {
    for (const comment of [undefined, '  ']) {
      assert.throws(
        () => reviewItem(awaiting(), 'd1', { verdict: 'changes_requested', ...(comment !== undefined && { comment }) }, ada),
        rejectsWith('invalid_review'),
      );
    }
  });

  it('rejects unknown, unrequested and already reviewed items', () => {
    assert.throws(() => reviewItem(awaiting(), 'nope', { verdict: 'approved' }, ada), rejectsWith('unknown_item'));
    const unrequested = awaiting({ decisions: [{ id: 'd1', createdAt: '2026-01-01T00:00:00Z', problem: 'p', options: ['x'], chosen: 0, reasoning: 'r' }] });
    assert.throws(() => reviewItem(unrequested, 'd1', { verdict: 'approved' }, ada), rejectsWith('invalid_review'));
    const reviewed = reviewItem(awaiting(), 'd1', { verdict: 'approved' }, ada);
    assert.throws(() => reviewItem(reviewed, 'd1', { verdict: 'approved' }, ada), rejectsWith('invalid_review'));
  });

  it('rejects a review when the task is not input_required', () => {
    assert.throws(() => reviewItem(awaiting({ status: 'failed' }), 'd1', { verdict: 'approved' }, ada), rejectsWith('invalid_transition'));
  });

  it('does not mutate its input', () => {
    const task = awaiting();
    const before = frozen(task);
    reviewItem(task, 'd1', { verdict: 'approved' }, ada);
    assert.deepEqual(task, before);
  });
});

describe('answerQuestion with pending approvals', () => {
  it('stays input_required while an approval is pending', () => {
    const task = taskIn('input_required', {
      autonomyMode: 'supervised',
      questions: [question('q1', 'text')],
      artifacts: [{ id: 'a1', createdAt: '2026-01-01T00:00:00Z', title: 't', kind: 'md', content: 'c', approval: { status: 'pending' } }],
    });
    const answered = answerQuestion(task, 'q1', ['yes'], ada);
    assert.equal(answered.status, 'input_required');
    assert.equal(hasOpenInput(answered), true);
  });
});

describe('nextRank and moveTask', () => {
  const ranked = (id: string, rank: number): Task => taskIn('draft', { id, rank });
  const board = () => [ranked('a', 0), ranked('b', 1), ranked('c', 2), ranked('d', 3)];
  const ranks = (tasks: Task[]) => tasks.map((t) => `${t.id}=${t.rank}`);

  it('ranks a new task below every other', () => {
    assert.equal(nextRank([]), 0);
    assert.equal(nextRank([ranked('a', 4), ranked('b', 1)]), 5);
  });

  it('moves a task up before another and returns only renumbered tasks', () => {
    assert.deepEqual(ranks(moveTask(board(), 'c', 'a')), ['c=0', 'a=1', 'b=2']);
  });

  it('moves a task down before another', () => {
    assert.deepEqual(ranks(moveTask(board(), 'a', 'd')), ['b=0', 'c=1', 'a=2']);
  });

  it('moves a task to the bottom without a target', () => {
    assert.deepEqual(ranks(moveTask(board(), 'b')), ['c=1', 'd=2', 'b=3']);
  });

  it('changes nothing when the task stays in place', () => {
    assert.deepEqual(moveTask(board(), 'b', 'b'), []);
    assert.deepEqual(moveTask(board(), 'b', 'c'), []);
  });

  it('renumbers ties and gaps by creation order', () => {
    const tied = [taskIn('draft', { id: 'y', rank: 0, createdAt: '2026-01-02' }), taskIn('draft', { id: 'x', rank: 0, createdAt: '2026-01-01' }), ranked('z', 7)];
    assert.deepEqual(ranks(moveTask(tied, 'z', 'y')), ['z=1', 'y=2']);
  });

  it('rejects unknown tasks', () => {
    assert.throws(() => moveTask(board(), 'missing'), rejectsWith('unknown_task'));
    assert.throws(() => moveTask(board(), 'a', 'missing'), rejectsWith('unknown_task'));
  });
});

describe('addFollowUp', () => {
  const followUp = (id: string, message = `message ${id}`) => ({
    id,
    createdAt: '2026-01-02T00:00:00Z',
    message,
  });
  // The agent session lives on the execution server, so follow-ups need one.
  const withServer = (task: Task): Task => ({
    ...task,
    execution: { id: 'c1', tokenHash: 'h1', worker: { state: 'idle', since: '2026-01-01T00:00:00Z' } },
  });

  it('appends a trimmed follow-up and keeps an in_progress task running', () => {
    const task = addFollowUp(withServer(taskIn('in_progress')), followUp('f1', '  also add tests \n'));
    assert.equal(task.status, 'in_progress');
    assert.deepEqual(task.followUps, [{ id: 'f1', createdAt: '2026-01-02T00:00:00Z', message: 'also add tests' }]);
  });

  it('moves a ready task back to in_progress', () => {
    assert.equal(addFollowUp(withServer(taskIn('ready')), followUp('f1')).status, 'in_progress');
  });

  it('moves a failed task back to in_progress and clears the failure reason', () => {
    const task = addFollowUp(withServer(taskIn('failed', { failureReason: 'boom' })), followUp('f1'));
    assert.equal(task.status, 'in_progress');
    assert.equal('failureReason' in task, false);
  });

  it('keeps a task awaiting input in input_required', () => {
    const task = addFollowUp(withServer(supervised('input_required', [question('q1', 'text')])), followUp('f1'));
    assert.equal(task.status, 'input_required');
    assert.deepEqual(task.followUps.map((f) => f.id), ['f1']);
  });

  it('appends in order', () => {
    const task = addFollowUp(addFollowUp(withServer(taskIn('in_progress')), followUp('f1')), followUp('f2'));
    assert.deepEqual(task.followUps.map((f) => f.id), ['f1', 'f2']);
  });

  it('rejects an empty message', () => {
    for (const message of ['', '  \n ']) {
      assert.throws(() => addFollowUp(taskIn('in_progress'), followUp('f1', message)), rejectsWith('invalid_follow_up'));
    }
  });

  it('is rejected before the task runs and once it is done', () => {
    for (const status of ['draft', 'queued', 'done'] as const) {
      assert.throws(() => addFollowUp(taskIn(status), followUp('f1')), rejectsWith('follow_up_not_allowed'), status);
    }
  });

  it('is rejected once the execution server is gone', () => {
    assert.throws(() => addFollowUp(taskIn('failed', { failureReason: 'boom' }), followUp('f1')), rejectsWith('no_execution'));
  });

  it('does not mutate its input', () => {
    const task = withServer(taskIn('failed', { failureReason: 'boom' }));
    const before = frozen(task);
    addFollowUp(task, followUp('f1'));
    assert.deepEqual(task, before);
  });
});

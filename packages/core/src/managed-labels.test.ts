import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  autonomyLabels,
  deletedCommentBody,
  deletedCommentKey,
  deletionLabelChanges,
  factoryLabel,
  mergeLabelChanges,
  modelLabels,
  parseManagedLabels,
  projectLabel,
  projectLabelChanges,
  statusLabel,
  statusLabelChanges,
} from './managed-labels.ts';
import type { TaskStatus } from './task.ts';

const allStatusLabels = [
  'factory:draft',
  'factory:clarification-required',
  'factory:queued',
  'factory:in-progress',
  'factory:input-required',
  'factory:ready',
  'factory:done',
  'factory:failed',
];

describe('parseManagedLabels', () => {
  it('applies the defaults to an issue without labels', () => {
    assert.deepEqual(parseManagedLabels([]), {
      isManaged: false,
      wantsStart: false,
      autonomyMode: 'autonomous',
      model: 'opus',
      contentLabels: [],
      conflicts: [],
    });
  });

  it('reads every class of label', () => {
    const parsed = parseManagedLabels([
      factoryLabel,
      projectLabel('p1'),
      'factory:queued',
      autonomyLabels.supervised,
      modelLabels.sonnet,
      'bug',
    ]);
    assert.deepEqual(parsed, {
      isManaged: true,
      wantsStart: true,
      autonomyMode: 'supervised',
      model: 'sonnet',
      contentLabels: ['bug'],
      conflicts: [],
    });
  });

  it('wants a start only for the queued status label', () => {
    for (const label of allStatusLabels.filter((label) => label !== 'factory:queued')) {
      assert.equal(parseManagedLabels([factoryLabel, label]).wantsStart, false, label);
    }
  });

  it('reads the explicit default config labels', () => {
    const parsed = parseManagedLabels([autonomyLabels.autonomous, modelLabels.opus]);
    assert.equal(parsed.autonomyMode, 'autonomous');
    assert.equal(parsed.model, 'opus');
    assert.deepEqual(parsed.conflicts, []);
  });

  it('names the autonomy labels under factory:mode', () => {
    assert.deepEqual(autonomyLabels, { autonomous: 'factory:mode:autonomous', supervised: 'factory:mode:supervised' });
    assert.equal(parseManagedLabels(['factory:supervised']).autonomyMode, 'autonomous');
  });

  it('matches factory labels case-insensitively', () => {
    const parsed = parseManagedLabels(['Factory', 'FACTORY:Queued', 'Factory:Mode:Supervised', 'factory:MODEL:sonnet']);
    assert.equal(parsed.isManaged, true);
    assert.equal(parsed.wantsStart, true);
    assert.equal(parsed.autonomyMode, 'supervised');
    assert.equal(parsed.model, 'sonnet');
  });

  it('keeps content labels in order, once each, exactly as written', () => {
    const parsed = parseManagedLabels(['ui', factoryLabel, 'Bug', 'ui', 'bug']);
    assert.deepEqual(parsed.contentLabels, ['ui', 'Bug', 'bug']);
  });

  it('ignores unknown factory labels and keeps them out of the content labels', () => {
    const parsed = parseManagedLabels(['factory:unknown', 'factory-ish', 'Factorytypo', 'factory:project:p1', 'feature']);
    assert.equal(parsed.isManaged, false);
    assert.deepEqual(parsed.contentLabels, ['feature']);
    assert.deepEqual(parsed.conflicts, []);
  });

  it('only marks the issue managed for the exact marker label', () => {
    assert.equal(parseManagedLabels(['factory:queued']).isManaged, false);
  });

  it('falls back to autonomous when both autonomy labels are set', () => {
    const parsed = parseManagedLabels([autonomyLabels.supervised, autonomyLabels.autonomous]);
    assert.equal(parsed.autonomyMode, 'autonomous');
    assert.equal(parsed.conflicts.length, 1);
    assert.match(parsed.conflicts[0]!, /factory:mode:autonomous and factory:mode:supervised/);
  });

  it('falls back to opus when both model labels are set', () => {
    const parsed = parseManagedLabels([modelLabels.sonnet, modelLabels.opus]);
    assert.equal(parsed.model, 'opus');
    assert.equal(parsed.conflicts.length, 1);
    assert.match(parsed.conflicts[0]!, /factory:model:opus and factory:model:sonnet/);
  });

  it('reports every conflict at once', () => {
    const parsed = parseManagedLabels([...Object.values(autonomyLabels), ...Object.values(modelLabels)]);
    assert.equal(parsed.conflicts.length, 2);
  });
});

describe('statusLabel', () => {
  const expected: Record<TaskStatus, string> = {
    draft: 'factory:draft',
    clarification_required: 'factory:clarification-required',
    queued: 'factory:queued',
    in_progress: 'factory:in-progress',
    input_required: 'factory:input-required',
    ready: 'factory:ready',
    done: 'factory:done',
    failed: 'factory:failed',
  };
  for (const [status, label] of Object.entries(expected)) {
    it(`labels ${status} as ${label}`, () => assert.equal(statusLabel(status as TaskStatus), label));
  }
});

describe('statusLabelChanges', () => {
  it('adds the status label to an issue without one', () => {
    assert.deepEqual(statusLabelChanges([factoryLabel, 'bug'], 'queued'), { add: ['factory:queued'], remove: [] });
  });

  it('changes nothing when the wanted label is already the only one', () => {
    assert.deepEqual(statusLabelChanges(['factory:ready', 'bug'], 'ready'), { add: [], remove: [] });
  });

  it('accepts the wanted label in another case', () => {
    assert.deepEqual(statusLabelChanges(['Factory:Ready'], 'ready'), { add: [], remove: [] });
  });

  it('replaces the previous status label', () => {
    assert.deepEqual(statusLabelChanges(['factory:queued', 'bug'], 'in_progress'), {
      add: ['factory:in-progress'],
      remove: ['factory:queued'],
    });
  });

  it('removes wrong status labels a human set, as written', () => {
    assert.deepEqual(statusLabelChanges(['factory:done', 'Factory:Queued', 'factory:input-required'], 'input_required'), {
      add: [],
      remove: ['factory:done', 'Factory:Queued'],
    });
  });

  it('never touches labels other than the status labels', () => {
    const changes = statusLabelChanges(
      [factoryLabel, autonomyLabels.supervised, modelLabels.sonnet, projectLabel('p1'), 'factory:bogus', 'factory:status:done', 'done'],
      'failed',
    );
    assert.deepEqual(changes, { add: ['factory:failed'], remove: [] });
  });
});

describe('projectLabelChanges', () => {
  it('adds the project label to an issue without one', () => {
    assert.deepEqual(projectLabelChanges([factoryLabel, 'bug'], 'p1'), { add: ['factory:project:p1'], remove: [] });
  });

  it('changes nothing when the label is already there, in any case', () => {
    assert.deepEqual(projectLabelChanges(['Factory:Project:P1'], 'p1'), { add: [], remove: [] });
  });

  it('corrects a project label a human changed or added, as written', () => {
    assert.deepEqual(projectLabelChanges(['Factory:Project:other', 'factory:project:p1', 'factory:queued'], 'p1'), {
      add: [],
      remove: ['Factory:Project:other'],
    });
    assert.deepEqual(projectLabelChanges(['factory:project:other'], 'p1'), {
      add: ['factory:project:p1'],
      remove: ['factory:project:other'],
    });
  });
});

describe('mergeLabelChanges', () => {
  it('joins the additions and the removals', () => {
    assert.deepEqual(mergeLabelChanges({ add: ['a'], remove: ['b'] }, { add: ['c'], remove: [] }), { add: ['a', 'c'], remove: ['b'] });
  });
});

describe('deletionLabelChanges', () => {
  it('removes the marker, every status label and the project label, adding nothing', () => {
    assert.deepEqual(deletionLabelChanges('p1'), {
      add: [],
      remove: [factoryLabel, ...allStatusLabels, 'factory:project:p1'],
    });
  });

  it('keeps the config labels', () => {
    const { remove } = deletionLabelChanges('p1');
    for (const kept of [...Object.values(autonomyLabels), ...Object.values(modelLabels)]) {
      assert.equal(remove.includes(kept), false, kept);
    }
  });
});

describe('the deletion comment', () => {
  it('has a key per task and tells how to import the issue again', () => {
    assert.equal(deletedCommentKey('t1'), 't1:task-deleted');
    assert.match(deletedCommentBody, /deleted in the factory/);
    assert.match(deletedCommentBody, /`factory` label again/);
  });
});

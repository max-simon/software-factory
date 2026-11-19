import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  autonomyLabels,
  factoryLabel,
  modelLabels,
  parseManagedLabels,
  projectLabelPrefix,
  startLabel,
  statusLabel,
  statusLabelChanges,
} from './managed-labels.ts';
import type { TaskStatus } from './task.ts';

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
      `${projectLabelPrefix}p1`,
      startLabel,
      autonomyLabels.supervised,
      modelLabels.sonnet,
      'bug',
      'factory:status:queued',
    ]);
    assert.deepEqual(parsed, {
      isManaged: true,
      projectId: 'p1',
      wantsStart: true,
      autonomyMode: 'supervised',
      model: 'sonnet',
      contentLabels: ['bug'],
      conflicts: [],
    });
  });

  it('reads the explicit default config labels', () => {
    const parsed = parseManagedLabels([autonomyLabels.autonomous, modelLabels.opus]);
    assert.equal(parsed.autonomyMode, 'autonomous');
    assert.equal(parsed.model, 'opus');
    assert.deepEqual(parsed.conflicts, []);
  });

  it('matches factory labels case-insensitively and keeps the project id as written', () => {
    const parsed = parseManagedLabels(['Factory', 'FACTORY:Start', 'Factory:Supervised', 'factory:MODEL:sonnet', 'Factory:Project:AbC1']);
    assert.equal(parsed.isManaged, true);
    assert.equal(parsed.wantsStart, true);
    assert.equal(parsed.autonomyMode, 'supervised');
    assert.equal(parsed.model, 'sonnet');
    assert.equal(parsed.projectId, 'AbC1');
  });

  it('keeps content labels in order, once each, exactly as written', () => {
    const parsed = parseManagedLabels(['ui', factoryLabel, 'Bug', 'ui', 'bug']);
    assert.deepEqual(parsed.contentLabels, ['ui', 'Bug', 'bug']);
  });

  it('ignores unknown factory labels and keeps them out of the content labels', () => {
    const parsed = parseManagedLabels(['factory:unknown', 'factory-ish', 'Factorytypo', 'factory:project:', 'feature']);
    assert.equal(parsed.isManaged, false);
    assert.equal(parsed.projectId, undefined);
    assert.deepEqual(parsed.contentLabels, ['feature']);
    assert.deepEqual(parsed.conflicts, []);
  });

  it('only marks the issue managed for the exact marker label', () => {
    assert.equal(parseManagedLabels(['factory:start']).isManaged, false);
  });

  it('falls back to autonomous when both autonomy labels are set', () => {
    const parsed = parseManagedLabels([autonomyLabels.supervised, autonomyLabels.autonomous]);
    assert.equal(parsed.autonomyMode, 'autonomous');
    assert.equal(parsed.conflicts.length, 1);
    assert.match(parsed.conflicts[0]!, /factory:autonomous and factory:supervised/);
  });

  it('falls back to opus when both model labels are set', () => {
    const parsed = parseManagedLabels([modelLabels.sonnet, modelLabels.opus]);
    assert.equal(parsed.model, 'opus');
    assert.equal(parsed.conflicts.length, 1);
    assert.match(parsed.conflicts[0]!, /factory:model:opus and factory:model:sonnet/);
  });

  it('uses no project when several project labels are set', () => {
    const parsed = parseManagedLabels([`${projectLabelPrefix}p1`, `${projectLabelPrefix}p2`]);
    assert.equal(parsed.projectId, undefined);
    assert.equal('projectId' in parsed, false);
    assert.equal(parsed.conflicts.length, 1);
    assert.match(parsed.conflicts[0]!, /p1, p2/);
  });

  it('treats a repeated project label as one', () => {
    const parsed = parseManagedLabels([`${projectLabelPrefix}p1`, `${projectLabelPrefix}p1`]);
    assert.equal(parsed.projectId, 'p1');
    assert.deepEqual(parsed.conflicts, []);
  });

  it('reports every conflict at once', () => {
    const parsed = parseManagedLabels([
      ...Object.values(autonomyLabels),
      ...Object.values(modelLabels),
      `${projectLabelPrefix}a`,
      `${projectLabelPrefix}b`,
    ]);
    assert.equal(parsed.conflicts.length, 3);
  });
});

describe('statusLabel', () => {
  const expected: Record<TaskStatus, string> = {
    draft: 'factory:status:draft',
    clarification_required: 'factory:status:clarification-required',
    queued: 'factory:status:queued',
    in_progress: 'factory:status:in-progress',
    input_required: 'factory:status:input-required',
    ready: 'factory:status:ready',
    done: 'factory:status:done',
    failed: 'factory:status:failed',
  };
  for (const [status, label] of Object.entries(expected)) {
    it(`labels ${status} as ${label}`, () => assert.equal(statusLabel(status as TaskStatus), label));
  }
});

describe('statusLabelChanges', () => {
  it('adds the status label to an issue without one', () => {
    assert.deepEqual(statusLabelChanges([factoryLabel, 'bug'], 'queued'), { add: ['factory:status:queued'], remove: [] });
  });

  it('changes nothing when the wanted label is already the only one', () => {
    assert.deepEqual(statusLabelChanges(['factory:status:ready', 'bug'], 'ready'), { add: [], remove: [] });
  });

  it('accepts the wanted label in another case', () => {
    assert.deepEqual(statusLabelChanges(['Factory:Status:Ready'], 'ready'), { add: [], remove: [] });
  });

  it('replaces the previous status label', () => {
    assert.deepEqual(statusLabelChanges(['factory:status:queued', 'bug'], 'in_progress'), {
      add: ['factory:status:in-progress'],
      remove: ['factory:status:queued'],
    });
  });

  it('removes wrong status labels a human set, as written', () => {
    assert.deepEqual(
      statusLabelChanges(['factory:status:done', 'Factory:Status:Bogus', 'factory:status:input-required'], 'input_required'),
      { add: [], remove: ['factory:status:done', 'Factory:Status:Bogus'] },
    );
  });

  it('never touches labels outside the status prefix', () => {
    const changes = statusLabelChanges([factoryLabel, startLabel, autonomyLabels.supervised, 'factory:project:p1', 'status:done'], 'failed');
    assert.deepEqual(changes, { add: ['factory:status:failed'], remove: [] });
  });
});

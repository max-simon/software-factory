import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DomainError } from './errors.ts';
import { assertTransition, transitions } from './status.ts';
import type { TaskStatus } from './task.ts';

const allStatuses = Object.keys(transitions) as TaskStatus[];

describe('assertTransition', () => {
  for (const from of allStatuses) {
    for (const to of allStatuses) {
      const isAllowed = transitions[from].includes(to);
      it(`${from} -> ${to} is ${isAllowed ? 'allowed' : 'rejected'}`, () => {
        if (isAllowed) {
          assert.doesNotThrow(() => assertTransition(from, to));
          return;
        }
        assert.throws(
          () => assertTransition(from, to),
          (error) => error instanceof DomainError && error.code === 'invalid_transition',
        );
      });
    }
  }

  it('has at least one disallowed target for every status', () => {
    for (const from of allStatuses) {
      assert.ok(allStatuses.some((to) => !transitions[from].includes(to)), from);
    }
  });
});

describe('transitions', () => {
  it('lets every started status go back to queued, for restarts', () => {
    assert.deepEqual(
      allStatuses.filter((from) => transitions[from].includes('queued')),
      ['draft', 'clarification_required', 'in_progress', 'input_required', 'ready', 'done', 'failed'],
    );
  });
});

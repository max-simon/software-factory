import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInputReview, parsePrReview, parseSpecReview } from './review.ts';

test('parseSpecReview accepts both verdicts and drops unknown fields', () => {
  assert.deepEqual(parseSpecReview({ verdict: 'ready', comment: '', extra: 1 }), { verdict: 'ready', comment: '' });
  assert.deepEqual(parseSpecReview({ verdict: 'needs_clarification', comment: '- Which repo?' }), {
    verdict: 'needs_clarification',
    comment: '- Which repo?',
  });
});

test('parseSpecReview rejects anything else', () => {
  assert.throws(() => parseSpecReview(null), /JSON object/);
  assert.throws(() => parseSpecReview({ verdict: 'maybe', comment: 'x' }), /got "maybe"/);
  assert.throws(() => parseSpecReview({ verdict: 'ready' }), /comment must be a string/);
  assert.throws(() => parseSpecReview({ verdict: 'needs_clarification', comment: '  ' }), /needs a comment/);
});

test('parsePrReview accepts every risk level and drops unknown fields', () => {
  for (const risk of ['low', 'medium', 'high']) {
    assert.deepEqual(parsePrReview({ risk, comment: 'why', extra: 1 }), { risk, comment: 'why' });
  }
});

test('parsePrReview rejects anything else', () => {
  assert.throws(() => parsePrReview(null), /JSON object/);
  assert.throws(() => parsePrReview({ risk: 'none', comment: 'x' }), /got "none"/);
  assert.throws(() => parsePrReview({ risk: 'low' }), /needs a comment/);
  assert.throws(() => parsePrReview({ risk: 'low', comment: ' ' }), /needs a comment/);
});

test('parseInputReview accepts every action, keeps an approval comment only when it has text, and drops unknown fields', () => {
  assert.deepEqual(
    parseInputReview({
      responses: [
        { id: 'q1', action: 'answer', answer: ['Postgres'], rationale: 'The project uses it.', extra: 1 },
        { id: 'd1', action: 'approve', comment: ' ', rationale: 'Matches the spec.' },
        { id: 'a1', action: 'request_changes', comment: 'Cover refunds too.', rationale: 'The spec names refunds.' },
        { id: 'q2', action: 'leave_to_human', answer: [], rationale: 'A product call.' },
      ],
    }),
    {
      responses: [
        { id: 'q1', action: 'answer', answer: ['Postgres'], rationale: 'The project uses it.' },
        { id: 'd1', action: 'approve', rationale: 'Matches the spec.' },
        { id: 'a1', action: 'request_changes', comment: 'Cover refunds too.', rationale: 'The spec names refunds.' },
        { id: 'q2', action: 'leave_to_human', rationale: 'A product call.' },
      ],
    },
  );
});

test('parseInputReview rejects anything else', () => {
  const one = (response: object) => ({ responses: [{ id: 'q1', rationale: 'why', ...response }] });
  assert.throws(() => parseInputReview({ responses: 'none' }), /must be an array/);
  assert.throws(() => parseInputReview(one({ action: 'skip' })), /unknown action "skip"/);
  assert.throws(() => parseInputReview(one({ action: 'approve', rationale: ' ' })), /needs a rationale/);
  assert.throws(() => parseInputReview(one({ action: 'answer', answer: 'yes' })), /without an array of strings/);
  assert.throws(() => parseInputReview(one({ action: 'request_changes' })), /without a comment/);
  assert.throws(() => parseInputReview(one({ action: 'approve', comment: 3 })), /comment that is not a string/);
  assert.throws(() => parseInputReview({ responses: [{ action: 'approve', rationale: 'why' }] }), /needs an id/);
});

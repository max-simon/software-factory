import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewTracker } from './review-tracker.ts';

test('a spec review is shown from its start until it finishes, per task', () => {
  const reviews = new ReviewTracker();
  assert.equal(reviews.isSpecUnderReview('t1'), false);
  reviews.startSpecReview('t1');
  assert.equal(reviews.isSpecUnderReview('t1'), true);
  assert.equal(reviews.isSpecUnderReview('t2'), false);
  reviews.finishSpecReview('t1');
  assert.equal(reviews.isSpecUnderReview('t1'), false);
});

test('a pull request review is shown from its start until it finishes, per url', () => {
  const reviews = new ReviewTracker();
  reviews.startPrReview('https://github.com/o/r/pull/1');
  assert.equal(reviews.isPrUnderReview('https://github.com/o/r/pull/1'), true);
  assert.equal(reviews.isPrUnderReview('https://github.com/o/r/pull/2'), false);
  assert.equal(reviews.isSpecUnderReview('https://github.com/o/r/pull/1'), false, 'spec and pull request reviews are apart');
  reviews.finishPrReview('https://github.com/o/r/pull/1');
  assert.equal(reviews.isPrUnderReview('https://github.com/o/r/pull/1'), false);
});

test('an input review is shown per task, apart from its spec review', () => {
  const reviews = new ReviewTracker();
  reviews.startInputReview('t1');
  assert.equal(reviews.isInputUnderReview('t1'), true);
  assert.equal(reviews.isInputUnderReview('t2'), false);
  assert.equal(reviews.isSpecUnderReview('t1'), false);
  reviews.finishInputReview('t1');
  assert.equal(reviews.isInputUnderReview('t1'), false);
});

test('overlapping reviews of the same thing stay shown until the last one finishes', () => {
  const reviews = new ReviewTracker();
  reviews.startPrReview('u');
  reviews.startPrReview('u');
  reviews.finishPrReview('u');
  assert.equal(reviews.isPrUnderReview('u'), true);
  reviews.finishPrReview('u');
  assert.equal(reviews.isPrUnderReview('u'), false);
});

test('finishing a review that never started changes nothing', () => {
  const reviews = new ReviewTracker();
  reviews.finishSpecReview('t1');
  assert.equal(reviews.isSpecUnderReview('t1'), false);
  reviews.startSpecReview('t1');
  assert.equal(reviews.isSpecUnderReview('t1'), true);
});

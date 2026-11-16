import type { ReviewState } from '@factory/core';

/**
 * The reviews running in this process. They die with it, so they are kept in
 * memory only. It records and triggers nothing. Counts, not flags: should two
 * reviews of the same thing overlap, the first to finish leaves the other shown.
 */
export class ReviewTracker implements ReviewState {
  readonly #specs = new Map<string, number>();
  readonly #inputs = new Map<string, number>();
  readonly #pullRequests = new Map<string, number>();

  startSpecReview(taskId: string): void {
    increment(this.#specs, taskId);
  }

  finishSpecReview(taskId: string): void {
    decrement(this.#specs, taskId);
  }

  startInputReview(taskId: string): void {
    increment(this.#inputs, taskId);
  }

  finishInputReview(taskId: string): void {
    decrement(this.#inputs, taskId);
  }

  startPrReview(url: string): void {
    increment(this.#pullRequests, url);
  }

  finishPrReview(url: string): void {
    decrement(this.#pullRequests, url);
  }

  isSpecUnderReview(taskId: string): boolean {
    return this.#specs.has(taskId);
  }

  isInputUnderReview(taskId: string): boolean {
    return this.#inputs.has(taskId);
  }

  isPrUnderReview(url: string): boolean {
    return this.#pullRequests.has(url);
  }
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function decrement(counts: Map<string, number>, key: string): void {
  const count = counts.get(key) ?? 0;
  if (count > 1) counts.set(key, count - 1);
  else counts.delete(key);
}

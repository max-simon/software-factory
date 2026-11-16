import type { ItemPrefix } from './task-store.ts';

/** Readable, predictable item ids for tests: `q1`, `q2`, `d1`, … counted per prefix across all tasks. */
export function sequentialItemIds(): (prefix: ItemPrefix) => string {
  const counts = new Map<ItemPrefix, number>();
  return (prefix) => {
    const count = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, count);
    return `${prefix}${count}`;
  };
}

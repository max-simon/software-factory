import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatCost, formatDuration } from './format.ts';

test('formats durations in the two largest units, truncated', () => {
  const cases: Array<[number, string]> = [
    [0, '0s'],
    [1, '<1s'],
    [999, '<1s'],
    [1000, '1s'],
    [45_000, '45s'],
    [59_900, '59s'],
    [60_000, '1m 00s'],
    [723_000, '12m 03s'],
    [3_599_000, '59m 59s'],
    [3_599_999, '59m 59s'],
    [3_600_000, '1h 00m'],
    [3_900_000, '1h 05m'],
    [90_000_000, '25h 00m'],
  ];
  for (const [ms, text] of cases) assert.equal(formatDuration(ms), text, String(ms));
});

test('formats costs in dollars, rounded to cents', () => {
  const cases: Array<[number, string]> = [
    [0, '$0.00'],
    [0.0008607700000000001, '<$0.01'],
    [0.00999, '<$0.01'],
    [0.01, '$0.01'],
    [0.014, '$0.01'],
    [0.016, '$0.02'],
    [0.999, '$1.00'],
    [1.23, '$1.23'],
    [1234.5, '$1234.50'],
  ];
  for (const [usd, text] of cases) assert.equal(formatCost(usd), text, String(usd));
});

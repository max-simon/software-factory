import type { Decision } from '@factory/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { DecisionApprovalForm, DecisionBody } from './InputItems.tsx';

const decision = (overrides: Partial<Decision> = {}): Decision => ({
  id: 'd1',
  createdAt: '2026-01-01T00:00:00.000Z',
  problem: 'Store rates?',
  options: ['table', 'config'],
  chosen: 0,
  reasoning: 'Rates change.',
  approval: { status: 'pending' },
  ...overrides,
});

test('a decision awaiting approval offers its options as radios with the agent pick checked', () => {
  const html = renderToStaticMarkup(<DecisionApprovalForm taskId="t1" decision={decision()} onDone={() => {}} />);
  expect(html.match(/type="radio"/g)).toHaveLength(2);
  expect(html.match(/checked=""/g)).toHaveLength(1);
  expect(html).toMatch(/checked=""\/><span>table<\/span>/);
});

test('a reviewed decision shows the engineer pick as chosen and marks the agent pick', () => {
  const html = renderToStaticMarkup(<DecisionBody decision={decision({ approval: { status: 'approved', chosen: 1 } })} />);
  expect(html).not.toContain('type="radio"');
  expect(html).toContain('<li class="decision-option decision-option-chosen"><span class="bubble" aria-label="Chosen">');
  expect(html).toContain('<span>table<span class="muted"> (agent&#x27;s pick)</span></span>');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resumePrompt } from './prompts.ts';
import { sampleTask } from './test-support.ts';

test('resumePrompt tells the agent which option the engineer picked over its own', () => {
  const decision = {
    id: 'd1',
    createdAt: 't',
    problem: 'Store rates?',
    options: ['table', 'config'],
    chosen: 0,
    reasoning: 'Rates change.',
    approval: { status: 'approved' as const, chosen: 1 },
  };
  const prompt = resumePrompt(sampleTask({ decisions: [decision] }), new Set(['d1']));
  assert.match(prompt, /- d1 \(decision: Store rates\?\): approved\n {2}Go with option 2 instead of yours: config\n/);
});

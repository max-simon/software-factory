import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resumePrompt, taskPrompt } from './prompts.ts';
import { sampleTask } from './test-support.ts';

const project = { id: 'p1', title: 'P', description: '', createdAt: 't', updatedAt: 't', autoMerge: false, taskProviders: [] };

test('taskPrompt names the issue of a managed task', () => {
  const external = { provider: 'github', url: 'https://github.com/o/r/issues/12', key: 'o/r#12' };
  assert.match(taskPrompt(sampleTask({ external }), project), /\nIssue: https:\/\/github\.com\/o\/r\/issues\/12 \(o\/r#12\)\n/);
  assert.doesNotMatch(taskPrompt(sampleTask(), project), /Issue:/);
});

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

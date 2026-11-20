// @vitest-environment jsdom
import type { NewTask as NewTaskInput } from '@factory/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api } from '../api.ts';
import { NewTask } from './TaskForm.tsx';

vi.mock('../api.ts', () => ({
  api: {
    listProjectTasks: vi.fn(async () => []),
    createTask: vi.fn(async (input: NewTaskInput) => ({ id: 't1', ...input })),
    startTask: vi.fn(async () => ({})),
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(api.createTask).mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<NewTask projectId="p1" project={undefined} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const shellCheckbox = (): HTMLInputElement => {
  const label = [...container.querySelectorAll('label.check')].find((l) => l.textContent?.includes('Allow a browser shell'));
  const input = label?.querySelector('input');
  if (!input) throw new Error('no shell checkbox');
  return input;
};

const saveDraft = async (): Promise<NewTaskInput | undefined> => {
  const field = (name: string) => container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!;
  field('title').value = 'Task';
  field('specification').value = 'Spec';
  await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save draft')!.click());
  return vi.mocked(api.createTask).mock.calls[0]?.[0];
};

test('a new task allows a browser shell by default', async () => {
  expect(shellCheckbox().checked).toBe(true);
  expect(await saveDraft()).toMatchObject({ shellEnabled: true });
});

test('a new task sends the unchecked shell option', async () => {
  act(() => shellCheckbox().click());
  expect(shellCheckbox().checked).toBe(false);
  expect(await saveDraft()).toMatchObject({ shellEnabled: false });
});


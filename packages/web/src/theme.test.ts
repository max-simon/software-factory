import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyTheme,
  getPreference,
  initTheme,
  parsePreference,
  resolveTheme,
  setPreference,
  type ThemeEnv,
} from './theme.ts';

const fakeDoc = () => {
  const meta = { content: 'dark light', setAttribute: (_: string, value: string) => (meta.content = value) };
  const doc = {
    documentElement: { dataset: {} as Record<string, string> },
    querySelector: (selector: string) => (selector === 'meta[name="color-scheme"]' ? meta : null),
  };
  return { doc, meta, env: doc as unknown as ThemeEnv['doc'] };
};

const fakeEnv = (stored: string | null, prefersLight = false) => {
  const { doc, meta, env: docEnv } = fakeDoc();
  const store = new Map<string, string>(stored === null ? [] : [['factory.theme', stored]]);
  const changeListeners: (() => void)[] = [];
  const media = {
    matches: prefersLight,
    addEventListener: (_: string, listener: () => void) => changeListeners.push(listener),
  };
  const env = {
    storage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) },
    media,
    doc: docEnv,
  } as unknown as ThemeEnv;
  const changeSystem = (light: boolean) => {
    media.matches = light;
    for (const listener of changeListeners) listener();
  };
  return { env, doc, meta, store, changeSystem };
};

test('parsePreference accepts light and dark and falls back to system', () => {
  assert.equal(parsePreference('light'), 'light');
  assert.equal(parsePreference('dark'), 'dark');
  assert.equal(parsePreference('system'), 'system');
  assert.equal(parsePreference(null), 'system');
  assert.equal(parsePreference('sepia'), 'system');
});

test('resolveTheme follows the system only for the system preference', () => {
  assert.equal(resolveTheme('system', true), 'light');
  assert.equal(resolveTheme('system', false), 'dark');
  assert.equal(resolveTheme('light', false), 'light');
  assert.equal(resolveTheme('dark', true), 'dark');
});

test('applyTheme sets the data attribute and the color-scheme meta', () => {
  const { doc, meta, env } = fakeDoc();
  applyTheme('light', env);
  assert.equal(doc.documentElement.dataset.theme, 'light');
  assert.equal(meta.content, 'light');
});

test('initTheme applies the stored preference and setPreference persists a new one', () => {
  const { env, doc, store } = fakeEnv('light');
  initTheme(env);
  assert.equal(getPreference(), 'light');
  assert.equal(doc.documentElement.dataset.theme, 'light');
  setPreference('dark');
  assert.equal(store.get('factory.theme'), 'dark');
  assert.equal(doc.documentElement.dataset.theme, 'dark');
});

test('the system preference follows media changes, an explicit one does not', () => {
  const { env, doc, changeSystem } = fakeEnv(null);
  initTheme(env);
  assert.equal(doc.documentElement.dataset.theme, 'dark');
  changeSystem(true);
  assert.equal(doc.documentElement.dataset.theme, 'light');
  setPreference('dark');
  changeSystem(false);
  changeSystem(true);
  assert.equal(doc.documentElement.dataset.theme, 'dark');
});

test('a throwing storage falls back to system and keeps choices for the session', () => {
  const { env, doc } = fakeEnv(null, true);
  const throwing = () => {
    throw new Error('SecurityError');
  };
  initTheme({ ...env, storage: { getItem: throwing, setItem: throwing } });
  assert.equal(getPreference(), 'system');
  assert.equal(doc.documentElement.dataset.theme, 'light');
  setPreference('dark');
  assert.equal(getPreference(), 'dark');
  assert.equal(doc.documentElement.dataset.theme, 'dark');
});

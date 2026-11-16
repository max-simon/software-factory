import { useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

export interface ThemeEnv {
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  media: Pick<MediaQueryList, 'matches' | 'addEventListener'>;
  doc: Pick<Document, 'documentElement' | 'querySelector'>;
}

const storageKey = 'factory.theme';

export const parsePreference = (raw: string | null): ThemePreference =>
  raw === 'light' || raw === 'dark' ? raw : 'system';

export const resolveTheme = (preference: ThemePreference, prefersLight: boolean): Theme =>
  preference === 'system' ? (prefersLight ? 'light' : 'dark') : preference;

export function applyTheme(theme: Theme, doc: ThemeEnv['doc'] = document) {
  doc.documentElement.dataset.theme = theme;
  doc.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
}

const browserEnv = (): ThemeEnv => ({
  // A getter, so a browser that blocks storage throws inside the try blocks below.
  get storage() {
    return localStorage;
  },
  media: matchMedia('(prefers-color-scheme: light)'),
  doc: document,
});

let env: ThemeEnv | undefined;
let preference: ThemePreference = 'system';
const listeners = new Set<() => void>();

const apply = () => {
  if (env) applyTheme(resolveTheme(preference, env.media.matches), env.doc);
};

export function initTheme(next: ThemeEnv = browserEnv()) {
  env = next;
  try {
    preference = parsePreference(next.storage.getItem(storageKey));
  } catch {
    preference = 'system';
  }
  apply();
  // Only changes anything while the preference is "system".
  next.media.addEventListener('change', apply);
}

export function setPreference(next: ThemePreference) {
  preference = next;
  try {
    env?.storage.setItem(storageKey, next);
  } catch {
    // Storage unavailable: the choice still holds for this session.
  }
  apply();
  for (const listener of listeners) listener();
}

export const getPreference = () => preference;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useThemePreference = () => useSyncExternalStore(subscribe, getPreference, getPreference);

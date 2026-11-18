import { useCallback, useEffect, useRef, useState } from 'react';
import { parseRoute, type Route } from './model.ts';

const pollIntervalMs = 3000;

export interface Polled<T> {
  data: T | undefined;
  error: Error | undefined;
  /** Replaces the data right away, e.g. with the task an action returned. */
  set: (data: T) => void;
  /** Loads again right away, e.g. after an action changed what it loads. */
  reload: () => void;
}

/**
 * Loads now and every few seconds while the page is visible. Keeps the last
 * good data on errors so a control-plane restart does not blank the screen.
 */
export function usePolling<T>(load: () => Promise<T>, key: string, intervalMs: number = pollIntervalMs): Polled<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const loadRef = useRef(load);
  loadRef.current = load;
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let isCancelled = false;
    setData(undefined);
    setError(undefined);
    const refresh = async () => {
      if (document.hidden) return;
      try {
        const next = await loadRef.current();
        if (isCancelled) return;
        setData(next);
        setError(undefined);
      } catch (cause) {
        if (!isCancelled) setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    };
    refreshRef.current = refresh;
    void refresh();
    const timer = setInterval(() => void refresh(), intervalMs);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      isCancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [key, intervalMs]);

  const set = useCallback((next: T) => setData(next), []);
  const reload = useCallback(() => void refreshRef.current(), []);
  return { data, error, set, reload };
}

const hashPath = (hash: string): string => hash.split('?')[0]!;

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  const pathRef = useRef(hashPath(location.hash));
  useEffect(() => {
    const update = () => {
      const path = hashPath(location.hash);
      // A changed query, such as a board filter, keeps the page: no new title, no jump to the top.
      if (path !== pathRef.current) {
        // Views that know a better title set it once they have rendered.
        document.title = 'Factory';
        window.scrollTo(0, 0);
      }
      pathRef.current = path;
      setRoute(parseRoute(location.hash));
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}

/** Runs one action at a time and keeps its error for display. */
export function useAction(): {
  isBusy: boolean;
  error: string | undefined;
  run: (action: () => Promise<void>) => Promise<void>;
} {
  const [isBusy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);
  return { isBusy, error, run };
}

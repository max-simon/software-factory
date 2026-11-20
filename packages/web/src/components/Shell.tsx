import type { FitAddon } from '@xterm/addon-fit';
import type { ITheme, Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import type { TaskView } from '../model.ts';
import { useThemePreference } from '../theme.ts';

type Connection = { state: 'connecting' } | { state: 'connected' } | { state: 'closed'; reason: string };

const stateLabels: Record<Connection['state'], string> = { connecting: 'Connecting…', connected: 'Connected', closed: 'Closed' };

interface LoadedTerminal {
  term: Terminal;
  fit: FitAddon;
}

// Loaded only when a panel opens, so xterm stays out of the main bundle. No
// clipboard or web-links add-on: the container's output is untrusted and must
// not reach the clipboard or turn into links.
async function createTerminal(): Promise<LoadedTerminal> {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/xterm/css/xterm.css'),
  ]);
  const term = new Terminal({ theme: terminalTheme(), fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: 12.5 });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return { term, fit };
}

function terminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const color = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: color('--raised'),
    foreground: color('--text'),
    cursor: color('--text'),
    cursorAccent: color('--raised'),
    selectionBackground: color('--line-strong'),
  };
}

const shellUrl = (taskId: string, { cols, rows }: Terminal) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/tasks/${encodeURIComponent(taskId)}/shell?cols=${cols}&rows=${rows}`;

/** A terminal into the task's execution server, connected while the panel is open. */
export function Shell({ task, onClose }: { task: Pick<TaskView, 'id' | 'execution'>; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [terminal, setTerminal] = useState<LoadedTerminal>();
  const [connection, setConnection] = useState<Connection>({ state: 'connecting' });
  const [attempt, setAttempt] = useState(0);
  const themePreference = useThemePreference();

  useEffect(() => {
    let isUnmounted = false;
    let loaded: LoadedTerminal | undefined;
    createTerminal().then(
      (created) => {
        if (isUnmounted || !containerRef.current) {
          created.term.dispose();
          return;
        }
        loaded = created;
        created.term.open(containerRef.current);
        setTerminal(created);
      },
      () => {
        if (!isUnmounted) setConnection({ state: 'closed', reason: 'The terminal failed to load.' });
      },
    );
    return () => {
      isUnmounted = true;
      loaded?.term.dispose();
    };
  }, []);

  useEffect(() => {
    if (terminal) terminal.term.options.theme = terminalTheme();
  }, [terminal, themePreference]);

  useEffect(() => {
    if (!terminal || !containerRef.current) return;
    const { term, fit } = terminal;
    fit.fit();
    setConnection({ state: 'connecting' });
    const socket = new WebSocket(shellUrl(task.id, term));
    socket.binaryType = 'arraybuffer';
    // The size the server knows: the one in the URL, then each resize sent.
    let sent = { cols: term.cols, rows: term.rows };
    const syncSize = () => {
      fit.fit();
      if (socket.readyState !== WebSocket.OPEN || (term.cols === sent.cols && term.rows === sent.rows)) return;
      sent = { cols: term.cols, rows: term.rows };
      socket.send(JSON.stringify({ type: 'resize', ...sent }));
    };
    socket.onopen = () => {
      setConnection({ state: 'connected' });
      syncSize();
    };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data instanceof ArrayBuffer) term.write(new Uint8Array(event.data));
    };
    socket.onclose = (event) => setConnection({ state: 'closed', reason: event.reason || 'The shell closed.' });
    const encoder = new TextEncoder();
    const input = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
    });
    const observer = new ResizeObserver(syncSize);
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      input.dispose();
      socket.onclose = null;
      socket.close();
    };
  }, [terminal, attempt, task.id]);

  return (
    <section className="box shell-panel">
      <div className="shell-header">
        <h2 className="section-title">Shell</h2>
        <span className={`shell-state ${connection.state}`}>{stateLabels[connection.state]}</span>
        <div className="actions">
          {connection.state === 'closed' && terminal && (
            <button className="button" onClick={() => setAttempt((n) => n + 1)}>
              Reconnect
            </button>
          )}
          <button className="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {task.execution?.worker.state === 'working' && <p className="banner">The agent is working in this container.</p>}
      {connection.state === 'closed' && <p className="shell-reason">{connection.reason}</p>}
      <div className="shell-terminal" ref={containerRef} />
      <p className="hint">While this shell is open, the task isn't finished and its execution server is kept.</p>
    </section>
  );
}

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TaskView } from '../model.ts';
import { Shell } from './Shell.tsx';

const fakes = vi.hoisted(() => {
  const fitted = { cols: 80, rows: 24 };

  class FakeTerminal {
    cols = 0;
    rows = 0;
    options: Record<string, unknown> = {};
    written: Uint8Array[] = [];
    isDisposed = false;
    onInput: (data: string) => void = () => {};
    open() {}
    loadAddon(addon: { term?: FakeTerminal }) {
      addon.term = this;
    }
    write(data: Uint8Array) {
      this.written.push(data);
    }
    onData(listener: (data: string) => void) {
      this.onInput = listener;
      return { dispose: () => {} };
    }
    dispose() {
      this.isDisposed = true;
    }
  }

  class FakeFitAddon {
    term?: FakeTerminal;
    fit() {
      Object.assign(this.term!, fitted);
    }
  }

  return { fitted, FakeTerminal, FakeFitAddon, terminals: [] as FakeTerminal[] };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: class extends fakes.FakeTerminal {
    constructor() {
      super();
      fakes.terminals.push(this);
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: fakes.FakeFitAddon }));

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  binaryType = 'blob';
  readyState = 0;
  sent: unknown[] = [];
  isClosed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { reason: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.isClosed = true;
  }
}

let resize: () => void = () => {};
class FakeResizeObserver {
  constructor(callback: () => void) {
    resize = callback;
  }
  observe() {}
  disconnect() {}
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  FakeWebSocket.instances = [];
  fakes.terminals.length = 0;
  Object.assign(fakes.fitted, { cols: 80, rows: 24 });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const working = { id: 'e1', worker: { state: 'working' as const, since: '2026-01-01T00:00:00.000Z' } };
const idle = { id: 'e1', worker: { state: 'idle' as const, since: '2026-01-01T00:00:00.000Z' } };

// The first dynamic import of a test file takes a while; the terminal exists once it settles.
const loaded = async () => {
  await vi.waitFor(() => expect(fakes.terminals).toHaveLength(1));
  await Promise.resolve();
};

const render = async (execution: TaskView['execution'] = idle, onClose = () => {}) => {
  act(() => root.render(<Shell task={{ id: 't1', execution }} onClose={onClose} />));
  await act(loaded);
};

const latestSocket = () => FakeWebSocket.instances.at(-1)!;
const openSocket = () =>
  act(() => {
    latestSocket().readyState = FakeWebSocket.OPEN;
    latestSocket().onopen?.();
  });
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label);

test('the panel connects with the fitted terminal size and binary frames', async () => {
  Object.assign(fakes.fitted, { cols: 120, rows: 40 });
  await render();
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(latestSocket().url).toBe(`ws://${location.host}/tasks/t1/shell?cols=120&rows=40`);
  expect(latestSocket().binaryType).toBe('arraybuffer');
  expect(container.textContent).toContain('Connecting…');
  await openSocket();
  expect(container.textContent).toContain('Connected');
});

test('typing is sent as a binary UTF-8 frame and output reaches the terminal', async () => {
  await render();
  await openSocket();
  fakes.terminals[0]!.onInput('ls é\r');
  expect(latestSocket().sent).toEqual([new TextEncoder().encode('ls é\r')]);
  latestSocket().onmessage?.({ data: new Uint8Array([104, 105]).buffer });
  expect(fakes.terminals[0]!.written).toEqual([new Uint8Array([104, 105])]);
});

test('a resize sends the control message only when the size changes', async () => {
  await render();
  await openSocket();
  resize();
  expect(latestSocket().sent).toEqual([]);
  Object.assign(fakes.fitted, { cols: 100, rows: 30 });
  resize();
  resize();
  expect(latestSocket().sent).toEqual([JSON.stringify({ type: 'resize', cols: 100, rows: 30 })]);
});

test('a close shows its reason and Reconnect opens a new connection', async () => {
  await render();
  await openSocket();
  act(() => latestSocket().onclose?.({ reason: 'the execution server stopped' }));
  expect(container.textContent).toContain('Closed');
  expect(container.textContent).toContain('the execution server stopped');
  act(() => button('Reconnect')!.click());
  expect(FakeWebSocket.instances).toHaveLength(2);
  expect(container.textContent).toContain('Connecting…');
  expect(button('Reconnect')).toBeUndefined();
});

test('a close without a reason shows a generic message', async () => {
  await render();
  act(() => latestSocket().onclose?.({ reason: '' }));
  expect(container.textContent).toContain('The shell closed.');
});

test('the working banner follows the worker state', async () => {
  const banner = 'The agent is working in this container.';
  await render(working);
  expect(container.textContent).toContain(banner);
  await render(idle);
  expect(container.textContent).not.toContain(banner);
  expect(container.textContent).toContain("While this shell is open, the task isn't finished and its execution server is kept.");
});

test('closing the panel calls onClose; unmounting closes the socket and disposes the terminal', async () => {
  const onClose = vi.fn();
  await render(idle, onClose);
  act(() => button('Close')!.click());
  expect(onClose).toHaveBeenCalledOnce();
  act(() => root.unmount());
  expect(latestSocket().isClosed).toBe(true);
  expect(fakes.terminals[0]!.isDisposed).toBe(true);
  root = createRoot(container);
});

test('unmounting before xterm loads opens no connection and disposes the terminal', async () => {
  act(() => root.render(<Shell task={{ id: 't1', execution: idle }} onClose={() => {}} />));
  act(() => root.unmount());
  await loaded();
  expect(FakeWebSocket.instances).toHaveLength(0);
  expect(fakes.terminals).toHaveLength(1);
  expect(fakes.terminals[0]!.isDisposed).toBe(true);
  root = createRoot(container);
});

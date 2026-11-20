import { parseShellControl, type ShellEndpoint } from '@factory/core';
import type { RawData, WebSocket } from 'ws';

/** Keystrokes and resizes are small; a paste larger than this arrives in several frames. */
export const browserMaxPayload = 64 * 1024;
export const runnerMaxPayload = 1024 * 1024;

const maxBufferedBytes = 1024 * 1024;
const pingIntervalMs = 30_000;
// The protocol caps a close reason at 123 bytes; `ws` throws on a longer one.
const maxReasonBytes = 123;

/** A WebSocket as the shell service sees it, so the service never imports `ws`. */
export class WebSocketEndpoint implements ShellEndpoint {
  readonly socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
    // `ws` closes the socket after every error, and that close ends the shell.
    socket.on('error', () => {});
  }

  close(code: number, reason: string): void {
    closeSocket(this.socket, code, reason);
  }

  onClose(listener: () => void): void {
    this.socket.on('close', () => listener());
  }
}

/**
 * Relays a browser and a runner until either closes. Binary frames are
 * terminal bytes both ways; text frames are control messages, which only the
 * browser sends. `onBrowserFrame` runs for every frame the browser sends.
 */
export function relay(browser: WebSocket, runner: WebSocket, onBrowserFrame: () => void): void {
  browser.on('message', (data, isBinary) => {
    onBrowserFrame();
    if (isBinary) return forward(data, browser, runner);
    // Re-serialized, so the runner only ever sees a control message as parsed here.
    const control = parseShellControl(data.toString());
    if (control) forward(JSON.stringify(control), browser, runner);
  });
  runner.on('message', (data, isBinary) => {
    if (isBinary) forward(data, runner, browser);
  });
  browser.on('close', (code, reason) => closeSocket(runner, sendableCode(code), reason.toString()));
  runner.on('close', (code, reason) => closeSocket(browser, sendableCode(code), reason.toString()));
  keepAlive(browser);
  keepAlive(runner);
  // Opened paused, so nothing the browser sent before the runner attached is lost.
  browser.resume();
}

/** Text goes out as a text frame, anything else as a binary frame. */
function forward(data: RawData | string, from: WebSocket, to: WebSocket): void {
  to.send(data, { binary: typeof data !== 'string' }, () => {
    if (from.isPaused && to.bufferedAmount <= maxBufferedBytes) from.resume();
  });
  if (to.bufferedAmount > maxBufferedBytes) from.pause();
}

function keepAlive(socket: WebSocket): void {
  let isAlive = true;
  socket.on('pong', () => (isAlive = true));
  const timer = setInterval(() => {
    // A paused socket reads no pongs; its partner is the slow one, and that one is pinged too.
    if (!isAlive && !socket.isPaused) return socket.terminate();
    isAlive = false;
    socket.ping();
  }, pingIntervalMs).unref();
  socket.on('close', () => clearInterval(timer));
}

/** Resumed first: a paused socket would not read the peer's close frame and hang until `ws` gives up on it. */
function closeSocket(socket: WebSocket, code: number, reason: string): void {
  socket.resume();
  socket.close(code, fitReason(reason));
}

/** 1005 (no code) and 1006 (connection lost) are reported locally but may not be sent. */
const sendableCode = (code: number): number => (code === 1005 || code === 1006 ? 1000 : code);

function fitReason(reason: string): string {
  let fitted = reason;
  while (Buffer.byteLength(fitted) > maxReasonBytes) fitted = fitted.slice(0, -1);
  return fitted;
}

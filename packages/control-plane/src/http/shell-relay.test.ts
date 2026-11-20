import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { relay } from './shell-relay.ts';

interface Connection {
  /** The test's end, standing in for the browser or the runner. */
  client: WebSocket;
  /** The control plane's end, which the relay pairs. */
  server: WebSocket;
}

/** A relayed browser and runner, plus how many frames the browser sent. */
async function startRelay(t: TestContext): Promise<{ browser: Connection; runner: Connection; frames: () => number }> {
  const sockets = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(sockets, 'listening');
  const url = `ws://127.0.0.1:${(sockets.address() as AddressInfo).port}`;
  const connect = async (): Promise<Connection> => {
    const accepted = once(sockets, 'connection');
    const client = new WebSocket(url);
    await once(client, 'open');
    const [server] = (await accepted) as [WebSocket];
    return { client, server };
  };
  const browser = await connect();
  const runner = await connect();
  t.after(() => {
    for (const socket of [browser.client, runner.client, browser.server, runner.server]) socket.terminate();
    sockets.close();
  });
  let frames = 0;
  relay(browser.server, runner.server, () => frames++);
  return { browser, runner, frames: () => frames };
}

const nextMessage = async (socket: WebSocket): Promise<{ data: string; isBinary: boolean }> => {
  const [data, isBinary] = (await once(socket, 'message')) as [Buffer, boolean];
  return { data: data.toString(), isBinary };
};

const closeOf = async (socket: WebSocket): Promise<{ code: number; reason: string }> => {
  const [code, reason] = (await once(socket, 'close')) as [number, Buffer];
  return { code, reason: reason.toString() };
};

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('relays binary frames both ways and counts the browser frames', async (t) => {
  const { browser, runner, frames } = await startRelay(t);
  browser.client.send(Buffer.from('ls\r'));
  assert.deepEqual(await nextMessage(runner.client), { data: 'ls\r', isBinary: true });
  runner.client.send(Buffer.from('file.txt\r\n'));
  assert.deepEqual(await nextMessage(browser.client), { data: 'file.txt\r\n', isBinary: true });
  assert.equal(frames(), 1);
});

test('passes a resize on to the runner as a text frame and drops other browser text', async (t) => {
  const { browser, runner, frames } = await startRelay(t);
  browser.client.send('{"type":"paste","text":"x"}');
  browser.client.send('{"type":"resize","cols":120,"rows":40}');
  assert.deepEqual(await nextMessage(runner.client), { data: '{"type":"resize","cols":120,"rows":40}', isBinary: false });
  assert.equal(frames(), 2);
});

test('drops text frames from the runner', async (t) => {
  const { browser, runner } = await startRelay(t);
  runner.client.send('{"type":"resize","cols":1,"rows":1}');
  runner.client.send(Buffer.from('after'));
  assert.deepEqual(await nextMessage(browser.client), { data: 'after', isBinary: true });
});

test('a close from the runner reaches the browser with its code and reason', async (t) => {
  const { browser, runner } = await startRelay(t);
  const closed = closeOf(browser.client);
  runner.client.close(1000, 'exit 0');
  assert.deepEqual(await closed, { code: 1000, reason: 'exit 0' });
});

test('a close from the browser reaches the runner with its code and reason', async (t) => {
  const { browser, runner } = await startRelay(t);
  const closed = closeOf(runner.client);
  browser.client.close(4001, 'bye');
  assert.deepEqual(await closed, { code: 4001, reason: 'bye' });
});

test('a lost connection closes the other side normally', async (t) => {
  const { browser, runner } = await startRelay(t);
  const closed = closeOf(browser.client);
  runner.client.terminate();
  assert.deepEqual(await closed, { code: 1000, reason: '' });
});

test('a slow receiver pauses the sender until it catches up', async (t) => {
  const { browser, runner } = await startRelay(t);
  runner.client.pause();
  const chunk = Buffer.alloc(64 * 1024, 'x');
  const chunks = 512;
  for (let i = 0; i < chunks; i++) browser.client.send(chunk);
  await waitFor(() => browser.server.isPaused);

  let received = 0;
  runner.client.on('message', (data: Buffer) => (received += data.length));
  runner.client.resume();
  await waitFor(() => received === chunks * chunk.length);
  assert.equal(browser.server.isPaused, false);
});

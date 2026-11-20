import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/** One frame a client sent: a text or binary message. */
export type ReceivedFrame = { text: string } | { binary: Buffer };

/** The server's side of one WebSocket connection. */
export interface TestConnection {
  request: IncomingMessage;
  frames: ReceivedFrame[];
  sendText(text: string): void;
  sendBinary(data: Buffer): void;
  close(code: number, reason: string): void;
  /** Resolves with the client's close frame, or when the socket ends without one. */
  closed: Promise<{ code?: number; reason?: string }>;
}

export interface TestWebSocketServer {
  /** `http://127.0.0.1:<port>`, as the control plane URL would be. */
  url: string;
  connections: TestConnection[];
  /** Resolves with the next connection, at once if one arrived unclaimed. */
  nextConnection(): Promise<TestConnection>;
  close(): Promise<void>;
}

const handshakeGuid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const opcodes = { text: 0x1, binary: 0x2, close: 0x8 } as const;

/**
 * Just enough of RFC 6455 for tests: unfragmented frames, client frames
 * masked, server frames under 64 KiB. Keeps `ws` out of the executor.
 */
export async function startTestWebSocketServer(): Promise<TestWebSocketServer> {
  const connections: TestConnection[] = [];
  let claimed = 0;
  let waiters: Array<() => void> = [];
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => response.writeHead(426).end());
  server.on('upgrade', (request: IncomingMessage, socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}${handshakeGuid}`).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    connections.push(serveConnection(request, socket));
    waiters.forEach((wake) => wake());
    waiters = [];
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const nextConnection = async (): Promise<TestConnection> => {
    while (claimed >= connections.length) await new Promise<void>((resolve) => waiters.push(resolve));
    return connections[claimed++]!;
  };
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    connections,
    nextConnection,
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function serveConnection(request: IncomingMessage, socket: Socket): TestConnection {
  const frames: ReceivedFrame[] = [];
  let pending = Buffer.alloc(0);
  let isClosing = false;
  let resolveClosed: (value: { code?: number; reason?: string }) => void = () => {};
  const closed = new Promise<{ code?: number; reason?: string }>((resolve) => (resolveClosed = resolve));
  const send = (opcode: number, payload: Buffer) => {
    if (!socket.writable) return;
    socket.write(Buffer.concat([encodeHeader(opcode, payload.length), payload]));
  };
  socket.on('end', () => resolveClosed({}));
  socket.on('close', () => resolveClosed({}));
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (let frame = readFrame(pending); frame; frame = readFrame(pending)) {
      pending = pending.subarray(frame.length);
      if (frame.opcode === opcodes.text) frames.push({ text: frame.payload.toString() });
      if (frame.opcode === opcodes.binary) frames.push({ binary: frame.payload });
      if (frame.opcode === opcodes.close) {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : undefined;
        resolveClosed({ ...(code !== undefined && { code }), reason: frame.payload.subarray(2).toString() });
        if (!isClosing) send(opcodes.close, frame.payload.subarray(0, 2));
        socket.end();
      }
    }
  });
  return {
    request,
    frames,
    sendText: (text) => send(opcodes.text, Buffer.from(text)),
    sendBinary: (data) => send(opcodes.binary, data),
    close: (code, reason) => {
      isClosing = true;
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2);
      send(opcodes.close, payload);
    },
    closed,
  };
}

function encodeHeader(opcode: number, length: number): Buffer {
  if (length < 126) return Buffer.from([0x80 | opcode, length]);
  const header = Buffer.from([0x80 | opcode, 126, 0, 0]);
  header.writeUInt16BE(length, 2);
  return header;
}

function readFrame(buffer: Buffer): { opcode: number; payload: Buffer; length: number } | undefined {
  if (buffer.length < 2) return undefined;
  const opcode = buffer[0]! & 0x0f;
  const isMasked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskOffset = offset;
  if (isMasked) offset += 4;
  if (buffer.length < offset + length) return undefined;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (isMasked) payload.forEach((byte, i) => (payload[i] = byte ^ buffer[maskOffset + (i % 4)]!));
  return { opcode, payload, length: offset + length };
}

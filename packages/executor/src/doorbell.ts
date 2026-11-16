import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** How the control plane tells an idle runner that work waits. */
export interface Doorbell {
  /** Forgets earlier rings: the work request that follows answers them. */
  reset(): void;
  /** Resolves true at the next ring, at once if one came since the last reset; false once closed. */
  wait(): Promise<boolean>;
}

export interface ManualDoorbell extends Doorbell {
  ring(): void;
  /** Ends every wait, now and later. */
  close(): void;
}

export function createDoorbell(): ManualDoorbell {
  let isRung = false;
  let isClosed = false;
  let waiters: Array<(isRung: boolean) => void> = [];
  const settle = (value: boolean): void => {
    waiters.forEach((resolve) => resolve(value));
    waiters = [];
  };
  return {
    ring: () => {
      isRung = true;
      settle(true);
    },
    close: () => {
      isClosed = true;
      settle(false);
    },
    reset: () => {
      isRung = false;
    },
    wait: () => {
      if (isClosed) return Promise.resolve(false);
      if (isRung) return Promise.resolve(true);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

export interface ServedDoorbell extends Doorbell {
  /** The port it listens on; differs from the requested one only for port 0. */
  port: number;
  close(): void;
}

/**
 * Serves a doorbell on `port`: `POST /nudge` rings it, anything else is 404.
 * Unauthenticated: a ring only makes the runner ask for work, which takes its token.
 */
export async function serveDoorbell(port: number): Promise<ServedDoorbell> {
  const doorbell = createDoorbell();
  const server = createServer((request, response) => {
    request.resume();
    const isNudge = request.method === 'POST' && request.url === '/nudge';
    if (isNudge) doorbell.ring();
    response.writeHead(isNudge ? 204 : 404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    reset: doorbell.reset,
    wait: doorbell.wait,
    close: () => {
      doorbell.close();
      server.close();
    },
  };
}

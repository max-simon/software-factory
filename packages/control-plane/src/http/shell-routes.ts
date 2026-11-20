import type { IncomingHttpHeaders } from 'node:http';
import { DomainError, type Principal } from '@factory/core';
import { WebSocketServer } from 'ws';
import type { AgentService } from '../agent-service.ts';
import type { ShellService } from '../shell-service.ts';
import { NotFoundError } from '../task-store.ts';
import { authenticateAgent, requireSession } from './authenticate.ts';
import { isLocalRequest } from './browser-guard.ts';
import { matchPath, UnauthorizedError, type Route, type UpgradeHandler } from './server.ts';
import { browserMaxPayload, relay, runnerMaxPayload, WebSocketEndpoint } from './shell-relay.ts';
import { parseShellQuery } from './validation.ts';

type Agent = Pick<AgentService, 'findByAgentToken'>;

/** The close code of a refusal, as the service uses for the ends it decides. */
const refusalCode = 4000;

/** `GET /agent/shells`: the runner's view of the shells waiting for it. */
export function shellRoutes(shells: ShellService, agent: Agent): Route[] {
  return [
    {
      method: 'GET',
      path: '/agent/shells',
      handle: ({ headers }) => ({ status: 200, body: { requests: shells.pendingFor(authenticateAgent(agent, headers)) } }),
    },
  ];
}

/** The two WebSocket ends of a shell: the engineer's browser and the task's runner. */
export function shellUpgrade(
  shells: ShellService,
  agent: Agent,
  authenticate: (headers: IncomingHttpHeaders) => Principal | undefined,
): UpgradeHandler {
  const browserSockets = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: browserMaxPayload });
  const runnerSockets = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: runnerMaxPayload });

  return (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const browserPath = matchPath('/tasks/:id/shell', url.pathname);
    if (browserPath) {
      // Browsers apply no CORS to WebSockets: this is what stops other sites from connecting.
      if (!isLocalRequest(req.headers)) {
        return { status: 403, body: { error: { code: 'forbidden', message: 'the shell accepts only connections from this machine' } } };
      }
      const principal = authenticate(req.headers);
      if (!principal) throw new UnauthorizedError('sign in first');
      const refusal = requireSession(principal);
      if (refusal) return refusal;
      const size = parseShellQuery(url.searchParams);
      // A session can end while the shell stays open; the service asks again on every sweep.
      const isAuthorized = () => authenticate(req.headers)?.userId === principal.userId;
      browserSockets.handleUpgrade(req, socket, head, (ws) => {
        ws.pause();
        const browser = new WebSocketEndpoint(ws);
        shells.open(principal, browserPath.id!, size, browser, isAuthorized).catch((error: unknown) => refuse(browser, error));
      });
      return undefined;
    }
    const runnerPath = matchPath('/agent/shells/:id', url.pathname);
    if (!runnerPath) throw new NotFoundError(`no WebSocket endpoint at ${url.pathname}`);
    const task = authenticateAgent(agent, req.headers);
    runnerSockets.handleUpgrade(req, socket, head, (ws) => {
      const runner = new WebSocketEndpoint(ws);
      try {
        const { browser, shellId } = shells.attach(task, runnerPath.id!, runner);
        if (!(browser instanceof WebSocketEndpoint)) throw new Error('shell browser endpoint is not a WebSocket');
        relay(browser.socket, ws, () => shells.recordInput(shellId));
      } catch (error) {
        refuse(runner, error);
      }
    });
    return undefined;
  };
}

/**
 * Browsers cannot read the body of a refused handshake, but they can read a
 * close reason, so a refusal after the upgrade travels as one.
 */
function refuse(endpoint: WebSocketEndpoint, error: unknown): void {
  if (error instanceof DomainError || error instanceof NotFoundError) return endpoint.close(refusalCode, error.message);
  console.error(error);
  endpoint.close(1011, 'internal error');
}

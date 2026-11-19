import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { TLSSocket } from 'node:tls';
import { DomainError, type DomainErrorCode, type Principal } from '@factory/core';
import { NotFoundError } from '../task-store.ts';
import { isLocalRequest } from './browser-guard.ts';
import type { StaticFile, StaticFiles } from './static-files.ts';
import { ValidationError } from './validation.ts';

export class UnauthorizedError extends Error {
  override name = 'UnauthorizedError';
}

export interface Request {
  params: Record<string, string>;
  headers: IncomingHttpHeaders;
  body: unknown;
  /** Who signed in, by session or token; set on every route outside `/agent/*` that is not public. */
  principal?: Principal;
  /** The socket's remote address. */
  clientAddress: string;
  /** Whether the request came over TLS. */
  secure: boolean;
}

export interface Response {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path with `:name` segments, e.g. `/tasks/:id`. */
  path: string;
  /** Reachable without a session, like the login. Routes under `/agent/` never need one: they check agent tokens. */
  public?: boolean;
  handle: (request: Request) => Response | Promise<Response>;
}

const maxBodyBytes = 1024 * 1024;

const domainStatus: Record<DomainErrorCode, number> = {
  invalid_transition: 409,
  not_editable: 409,
  externally_managed: 409,
  not_managed: 409,
  duplicate_external_link: 409,
  not_active: 409,
  questions_not_allowed: 409,
  approvals_not_allowed: 409,
  unknown_question: 404,
  invalid_answer: 400,
  unknown_item: 404,
  invalid_review: 400,
  foreign_pull_request: 400,
  unknown_pull_request: 404,
  unknown_task: 404,
  invalid_follow_up: 400,
  follow_up_not_allowed: 409,
  unknown_follow_up: 404,
  invalid_clarification: 400,
  invalid_dependencies: 400,
  has_waiting_dependents: 409,
  no_execution: 409,
  unknown_user: 404,
  user_disabled: 409,
  duplicate_username: 409,
  invalid_username: 400,
  invalid_display_name: 400,
  invalid_password: 400,
  invalid_token_name: 400,
  invalid_token_expiry: 400,
  issue_provider_failed: 502,
};

export interface ServerOptions {
  /**
   * Resolves the session or personal access token a request carries. Every
   * route outside `/agent/*` that is not public needs one, and so does `mcpPath`.
   */
  authenticate: (headers: IncomingHttpHeaders) => Principal | undefined;
  /** Serves the web UI for GET requests that match no route, signed in or not. */
  staticFiles?: StaticFiles;
  /** Handles every signed-in request to `mcpPath` from this machine. */
  mcp?: RequestListener;
}

export const mcpPath = '/mcp';

export function createServer(routes: readonly Route[], options: ServerOptions): Server {
  return createHttpServer((req, res) => {
    // The MCP transport reads the body and writes the response itself, so it
    // bypasses the JSON routes; non-local requests still get the 403 below.
    const path = URL.parse(req.url ?? '/', 'http://localhost')?.pathname;
    if (options.mcp && path === mcpPath && isLocalRequest(req.headers)) {
      let principal;
      try {
        principal = options.authenticate(req.headers);
      } catch (error) {
        return send(res, toFailure(error));
      }
      return principal ? options.mcp(req, res) : send(res, unauthorized());
    }
    dispatch(routes, options, req)
      .then((reply) => send(res, reply))
      .catch((error: unknown) => {
        console.error(error);
        res.destroy();
      });
  });
}

function send(res: ServerResponse, reply: Response | StaticFile): void {
  if ('content' in reply) {
    res.writeHead(200, { 'content-type': reply.contentType, 'x-content-type-options': 'nosniff' });
    res.end(reply.content);
    return;
  }
  const { status, body, headers = {} } = reply;
  res.writeHead(status, body === undefined ? headers : { ...headers, 'content-type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function dispatch(routes: readonly Route[], options: ServerOptions, req: IncomingMessage): Promise<Response | StaticFile> {
  try {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    // Agent routes authenticate by token and are called from execution servers under another host name.
    const isAgentPath = path.startsWith('/agent/');
    if (!isAgentPath && !isLocalRequest(req.headers)) {
      return failure(403, 'forbidden', 'the engineer API accepts only requests from this machine');
    }
    for (const route of routes) {
      const params = route.method === req.method ? matchPath(route.path, path) : undefined;
      if (!params) continue;
      let principal: Principal | undefined;
      if (!isAgentPath && !route.public) {
        principal = options.authenticate(req.headers);
        if (!principal) return unauthorized();
      }
      return await route.handle({
        params,
        headers: req.headers,
        body: await readJson(req),
        ...(principal && { principal }),
        clientAddress: req.socket.remoteAddress ?? '',
        secure: (req.socket as Partial<TLSSocket>).encrypted === true,
      });
    }
    // The web UI loads signed out so it can offer a login; anything else does
    // not tell a signed-out caller which paths exist.
    const file = req.method === 'GET' ? await options.staticFiles?.(path) : undefined;
    if (file) return file;
    if (!isAgentPath && !options.authenticate(req.headers)) return unauthorized();
    return failure(404, 'not_found', `no route for ${req.method} ${path}`);
  } catch (error) {
    return toFailure(error);
  }
}

function matchPath(pattern: string, path: string): Record<string, string> | undefined {
  const expected = pattern.split('/').filter(Boolean);
  const actual = path.split('/').filter(Boolean);
  if (expected.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (const [i, segment] of expected.entries()) {
    const value = decodeURIComponent(actual[i]!);
    if (segment.startsWith(':')) params[segment.slice(1)] = value;
    else if (segment !== value) return undefined;
  }
  return params;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new ValidationError(`request body exceeds ${maxBodyBytes} bytes`);
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('request body is not valid JSON');
  }
}

function toFailure(error: unknown): Response {
  if (error instanceof DomainError) return failure(domainStatus[error.code], error.code, error.message);
  if (error instanceof URIError) return failure(400, 'invalid_request', 'malformed URL');
  if (error instanceof ValidationError) return failure(400, 'invalid_request', error.message);
  if (error instanceof NotFoundError) return failure(404, 'not_found', error.message);
  if (error instanceof UnauthorizedError) return failure(401, 'unauthorized', error.message);
  console.error(error);
  return failure(500, 'internal', 'internal server error');
}

const unauthorized = (): Response => failure(401, 'unauthorized', 'sign in first');

const failure = (status: number, code: string, message: string): Response => ({
  status,
  body: { error: { code, message } },
});

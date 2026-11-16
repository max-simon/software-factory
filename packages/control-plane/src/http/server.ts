import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestListener,
  type Server,
} from 'node:http';
import { DomainError, type DomainErrorCode } from '@factory/core';
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
}

export interface Response {
  status: number;
  body?: unknown;
}

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path with `:name` segments, e.g. `/tasks/:id`. */
  path: string;
  handle: (request: Request) => Response | Promise<Response>;
}

const maxBodyBytes = 1024 * 1024;

const domainStatus: Record<DomainErrorCode, number> = {
  invalid_transition: 409,
  not_editable: 409,
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
};

export interface ServerOptions {
  /** Serves the web UI for GET requests that match no route. */
  staticFiles?: StaticFiles;
  /** Handles every request to `mcpPath` from this machine. */
  mcp?: RequestListener;
}

export const mcpPath = '/mcp';

export function createServer(routes: readonly Route[], options: ServerOptions = {}): Server {
  return createHttpServer((req, res) => {
    // The MCP transport reads the body and writes the response itself, so it
    // bypasses the JSON routes; non-local requests still get the 403 below.
    const path = URL.parse(req.url ?? '/', 'http://localhost')?.pathname;
    if (options.mcp && path === mcpPath && isLocalRequest(req.headers)) return options.mcp(req, res);
    dispatch(routes, options, req)
      .then((reply) => {
        if ('content' in reply) {
          res.writeHead(200, { 'content-type': reply.contentType, 'x-content-type-options': 'nosniff' });
          res.end(reply.content);
          return;
        }
        const { status, body } = reply;
        res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
        res.end(body === undefined ? undefined : JSON.stringify(body));
      })
      .catch((error: unknown) => {
        console.error(error);
        res.destroy();
      });
  });
}

async function dispatch(routes: readonly Route[], options: ServerOptions, req: IncomingMessage): Promise<Response | StaticFile> {
  try {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    // Agent routes authenticate by token and are called from execution servers under another host name.
    if (!path.startsWith('/agent/') && !isLocalRequest(req.headers)) {
      return failure(403, 'forbidden', 'the engineer API accepts only requests from this machine');
    }
    for (const route of routes) {
      const params = route.method === req.method ? matchPath(route.path, path) : undefined;
      if (params) return await route.handle({ params, headers: req.headers, body: await readJson(req) });
    }
    const file = req.method === 'GET' ? await options.staticFiles?.(path) : undefined;
    if (file) return file;
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

const failure = (status: number, code: string, message: string): Response => ({
  status,
  body: { error: { code, message } },
});

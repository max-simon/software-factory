import type { IncomingHttpHeaders } from 'node:http';

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The engineer API has no authentication and relies on listening on loopback.
 * A browser can still reach loopback on behalf of any website, so requests must
 * name a loopback host (defeats DNS rebinding) and, when a browser sends an
 * Origin, come from a loopback origin (defeats cross-site requests).
 */
export function isLocalRequest(headers: IncomingHttpHeaders): boolean {
  if (!isLoopback(headers.host)) return false;
  if (headers.origin === undefined) return true;
  const origin = URL.canParse(headers.origin) ? new URL(headers.origin) : undefined;
  return origin?.protocol === 'http:' && isLoopback(origin.host);
}

function isLoopback(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!;
  return loopbackHosts.has(hostname.toLowerCase());
}

import type { IncomingHttpHeaders } from 'node:http';

export const sessionCookieName = 'factory_session';

/** The session token from the `Cookie` header, if any. */
export function readSessionToken(headers: IncomingHttpHeaders): string | undefined {
  for (const pair of (headers.cookie ?? '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator !== -1 && pair.slice(0, separator).trim() === sessionCookieName) {
      return pair.slice(separator + 1).trim() || undefined;
    }
  }
  return undefined;
}

// HttpOnly keeps it from scripts; SameSite=Strict keeps other sites from sending it along.
const attributes = (secure: boolean): string => `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;

/** `Set-Cookie` for a new session; `secure` when it is served over HTTPS. */
export function sessionCookie(token: string, maxAgeMs: number, secure: boolean): string {
  return `${sessionCookieName}=${token}; Max-Age=${Math.floor(maxAgeMs / 1000)}; ${attributes(secure)}`;
}

/** `Set-Cookie` that removes the session cookie. */
export function clearedSessionCookie(secure: boolean): string {
  return `${sessionCookieName}=; Max-Age=0; ${attributes(secure)}`;
}

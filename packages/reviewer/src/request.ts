export class RequestError extends Error {
  override name = 'RequestError';
}

// Checks of the request read from stdin; each role checks only the fields its prompt uses.

export function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RequestError(`${what} must be an object`);
  return value as Record<string, unknown>;
}

export function string(value: unknown, what: string): void {
  if (typeof value !== 'string') throw new RequestError(`${what} must be a string`);
}

export function strings(value: unknown, what: string): void {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new RequestError(`${what} must be an array of strings`);
}

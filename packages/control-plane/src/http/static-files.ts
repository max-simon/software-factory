import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

export interface StaticFile {
  content: Buffer;
  contentType: string;
}

/** Resolves a URL path to a file below the root, or undefined when there is none. */
export type StaticFiles = (path: string) => Promise<StaticFile | undefined>;

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

export function staticFiles(root: string): StaticFiles {
  const base = resolve(root);
  return async (path) => {
    const file = resolve(base, `.${path === '/' ? '/index.html' : path}`);
    const contentType = contentTypes[extname(file)];
    if (!file.startsWith(base + sep) || !contentType) return undefined;
    try {
      return { content: await readFile(file), contentType };
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  };
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EISDIR');

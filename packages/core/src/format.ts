// Display helpers for the web UI.

/** `0s`, `<1s`, `45s`, `12m 03s`, `1h 05m`; truncates, so a time never shows longer than it was. */
export function formatDuration(ms: number): string {
  if (ms > 0 && ms < 1000) return '<1s';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${twoDigits(minutes % 60)}m`;
  if (minutes > 0) return `${minutes}m ${twoDigits(seconds % 60)}s`;
  return `${seconds}s`;
}

/** `$1.23`, rounded to cents; a cost below one cent shows as `<$0.01`. */
export function formatCost(usd: number): string {
  return usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

const twoDigits = (n: number): string => String(n).padStart(2, '0');

/** Strips secret values from text that is logged or stored, such as an adapter's error message. */
export function redact(text: string, secrets: readonly string[]): string {
  return secrets.filter(Boolean).reduce((result, secret) => result.replaceAll(secret, '[redacted]'), text);
}

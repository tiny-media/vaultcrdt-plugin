let debugEnabled = false;

export interface RingEntry { ts: string; level: 'warn' | 'error'; text: string }
const RING_MAX = 50;
const ring: RingEntry[] = [];
let secretProvider: () => string = () => '';

export function setSecretProvider(fn: () => string): void { secretProvider = fn; }
export function getRecentIssues(): RingEntry[] { return ring.slice(); }

export function redact(text: string, secret = secretProvider()): string {
  if (!secret) return text;
  return text.split(secret).join('(redacted)')
    .split(JSON.stringify(secret).slice(1, -1)).join('(redacted)');
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? String(value); }
  catch { return String(value); }
}

function textOf(args: unknown[]): string {
  return redact(args.map(a => typeof a === 'string' ? a
    : a instanceof Error ? `${a.name}: ${a.message}` : safeJson(a)).join(' '));
}

function record(level: RingEntry['level'], args: unknown[]): string {
  const text = textOf(args);
  ring.push({ ts: new Date().toISOString(), level, text: text.slice(0, 300) });
  if (ring.length > RING_MAX) ring.shift();
  return text;
}

/** Logs only when debug mode is enabled. Never records in the issue ring. */
export function log(...args: unknown[]): void {
  if (debugEnabled) console.debug(textOf(args));
}

export function warn(...args: unknown[]): void {
  console.warn(record('warn', args));
}

export function error(...args: unknown[]): void {
  console.error(record('error', args));
}

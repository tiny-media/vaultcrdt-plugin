let debugEnabled = false;

/** Logs only when debug mode is enabled. Silent in production. */
export function log(...args: unknown[]): void {
  if (debugEnabled) console.log(...args);
}

export function warn(...args: unknown[]): void {
  console.warn(...args);
}

export function error(...args: unknown[]): void {
  console.error(...args);
}

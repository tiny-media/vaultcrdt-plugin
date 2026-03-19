import { App } from 'obsidian';

/** Check if vvA covers all peers/counters in vvB (no gaps). */
export function vvCovers(vvA: string, vvB: string): boolean {
  try {
    const a = JSON.parse(vvA) as Record<string, number>;
    const b = JSON.parse(vvB) as Record<string, number>;
    return Object.entries(b).every(
      ([peer, counter]) => (a[peer] ?? 0) >= counter
    );
  } catch {
    return true; // Parse error → assume covered (safe default)
  }
}

/** Check if two VV JSON strings share any peer IDs (i.e. have common CRDT history). */
export function hasSharedHistory(clientVV: string, serverVV: string): boolean {
  try {
    const client = JSON.parse(clientVV) as Record<string, number>;
    const server = JSON.parse(serverVV) as Record<string, number>;
    return Object.keys(client).some(peer => peer in server);
  } catch {
    return true; // Parse error → assume shared (safe default, no fork)
  }
}

/** Generate a conflict file path with date and optional counter. */
export function conflictPath(app: App, path: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot) : '';
  const base = path.slice(0, path.length - ext.length);
  let candidate = `${base} (conflict ${date})${ext}`;
  let counter = 2;
  while (app.vault.getAbstractFileByPath(candidate)) {
    candidate = `${base} (conflict ${date} ${counter})${ext}`;
    counter++;
  }
  return candidate;
}

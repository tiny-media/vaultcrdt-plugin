import { App } from 'obsidian';

type VersionVector = Record<string, number>;

function parseVV(vv: string): VersionVector | null {
  try {
    const parsed = JSON.parse(vv) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed as Record<string, unknown>);
    for (const [peer, counter] of entries) {
      if (!peer || typeof counter !== 'number' || !Number.isFinite(counter) || counter < 0) {
        return null;
      }
    }
    return parsed as VersionVector;
  } catch {
    return null;
  }
}

/** Check if vvA covers all peers/counters in vvB (no gaps). */
export function vvCovers(vvA: string, vvB: string): boolean {
  const a = parseVV(vvA);
  const b = parseVV(vvB);
  if (!a || !b) return false; // Parse error → conservative: unknown VV never proves coverage.
  return Object.entries(b).every(
    ([peer, counter]) => (a[peer] ?? 0) >= counter
  );
}

/** Check if two VV JSON strings share any peer IDs (i.e. have common CRDT history). */
export function hasSharedHistory(clientVV: string, serverVV: string): boolean {
  const client = parseVV(clientVV);
  const server = parseVV(serverVV);
  if (!client || !server) return false; // Parse error → conservative: unknown history is not trusted.
  return Object.keys(client).some(peer => peer in server);
}

/** Check if two VV JSON strings represent the same version vector. */
export function vvEquals(vvA: string, vvB: string): boolean {
  const a = parseVV(vvA);
  const b = parseVV(vvB);
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => a[k] === b[k]) && keysB.every((k) => k in a);
}

/**
 * Fast FNV-1a 64-bit hash for content comparison. Not cryptographic.
 * Returns a 16-char lowercase hex string. 64-bit width (vs the old 32-bit
 * variant) removes the collision risk when the hash is used as a
 * content-identity key for the startup fast-path across thousands of files.
 */
export function fnv1aHash64(str: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
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

/** Path for a local file whose server doc is tombstoned: `<base> (deleted-remote)<ext>`, counter on collision. */
export function remoteDeletedPath(app: App, path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot) : '';
  const base = path.slice(0, path.length - ext.length);
  let candidate = `${base} (deleted-remote)${ext}`;
  let counter = 2;
  while (app.vault.getAbstractFileByPath(candidate)) {
    candidate = `${base} (deleted-remote ${counter})${ext}`;
    counter++;
  }
  return candidate;
}

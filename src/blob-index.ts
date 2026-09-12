import { blob_path_key } from '../wasm/vaultcrdt_wasm';

export type PendingDecision =
  | { kind: 'delete'; expectedHash: string; expectedSize: number; seq: number; generation: number }
  | { kind: 'republish'; seq: number; generation: number };

/**
 * Persistent attachment blob index (design §3). One entry per attachment path,
 * keyed by the vault-relative path; `key` is the canonical blob path key from
 * the WASM `blob_path_key` (paths without a key are not attachments and are
 * never indexed).
 *
 * Lives in plugin state (`state/blob-index.json`) like the inbox, so the
 * diagnostics export — which dumps settings verbatim — never sees it.
 */
export interface BlobIndexEntry {
  /** Canonical blob path key (key_version 1). */
  key: string;
  /** BLAKE3 hex of the bytes last hashed locally. */
  hash: string;
  size: number;
  generation: number;
  /** Server seq of the last accepted blob-path state. */
  seq: number;
  /** False when the server advertises content this device has not downloaded. */
  hydrated: boolean;
  /** Hash last confirmed by the server for this path — echo suppression. Null when never confirmed. */
  lastRemoteHash: string | null;
  /** Set when the file exceeded the type cap and was never read. */
  skipped?: boolean;
  /** Adapter mtime from the last successful upload/stat — sweep diff. */
  mtime?: number;
  pendingDecision?: PendingDecision;
}

interface BlobIndexFile {
  v: 2;
  c: number;
  paths: Record<string, BlobIndexEntry>;
}

export interface BlobIndexStorage {
  existsRaw(name: string): Promise<boolean>;
  readRaw(name: string): Promise<string | null>;
  writeRaw(name: string, text: string): Promise<void>;
  loadJson<T>(name: string): Promise<T | null>;
  saveJson(name: string, value: unknown): Promise<void>;
}

export const BLOB_INDEX_FILE = 'blob-index.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCandidate(value: unknown): value is Record<string, unknown> & { key: string; hash: string } {
  return isRecord(value) && typeof value.key === 'string' && typeof value.hash === 'string';
}

const BACKUP = 'blob-index.bak';
const QUARANTINE = 'blob-index.corrupt.json';
const emptyFile = (): BlobIndexFile => ({ v: 2, c: 0, paths: Object.create(null) as Record<string, BlobIndexEntry> });
const nonNegativeInteger = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= 0;
function validDecision(d: unknown): d is PendingDecision {
  if (!isRecord(d) || !nonNegativeInteger(d.seq) || !nonNegativeInteger(d.generation)) return false;
  if (d.kind === 'republish') return true;
  return d.kind === 'delete' && typeof d.expectedHash === 'string' && d.expectedHash.length > 0
    && nonNegativeInteger(d.expectedSize);
}
type Validation = { ok: true; file: BlobIndexFile } | { ok: false; reason: string };
export interface BlobIndexLoadOutcome {
  outcome: 'ok' | 'fresh' | 'recovered' | 'poisoned';
  reason?: string;
  quarantine?: string;
}

/** The same strict validator is used for admission and every write readback. */
export async function validateIndexFile(text: string, ready: () => Promise<void> = async () => {}): Promise<Validation> {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, reason: 'invalid JSON' }; }
  if (!isRecord(raw) || (raw.v !== 1 && raw.v !== 2) || !isRecord(raw.paths)
    || (raw.v === 1 ? typeof raw.maxSeq !== 'number' : !nonNegativeInteger(raw.c))) {
    return { ok: false, reason: 'invalid index envelope' };
  }
  const entries = Object.entries(raw.paths);
  for (const [path, e] of entries) {
    if (!isCandidate(e)) return { ok: false, reason: `invalid entry: ${path}` };
    if ('pendingDecision' in e && !validDecision(e.pendingDecision)) {
      return { ok: false, reason: `invalid pendingDecision: ${path}` };
    }
    for (const field of ['size', 'generation', 'seq', 'mtime']) {
      if (field in e && typeof e[field] !== 'number') return { ok: false, reason: `invalid ${field}: ${path}` };
    }
    for (const field of ['hydrated', 'skipped']) {
      if (field in e && typeof e[field] !== 'boolean') return { ok: false, reason: `invalid ${field}: ${path}` };
    }
    if ('lastRemoteHash' in e && e.lastRemoteHash !== null && typeof e.lastRemoteHash !== 'string') {
      return { ok: false, reason: `invalid lastRemoteHash: ${path}` };
    }
  }
  // Readiness failure propagates; empty/malformed startup stays lazy.
  if (entries.length) await ready();
  const file = emptyFile();
  file.c = raw.v === 2 ? raw.c as number : 0;
  for (const [path, value] of entries) {
    const e = value as Record<string, unknown> & { key: string; hash: string };
    const key = blob_path_key(path);
    if (!key || key !== e.key) return { ok: false, reason: `invalid path key: ${path}` };
    file.paths[path] = {
      key, hash: e.hash, size: (e.size as number | undefined) ?? 0,
      generation: (e.generation as number | undefined) ?? 0,
      seq: (e.seq as number | undefined) ?? 0,
      hydrated: (e.hydrated as boolean | undefined) ?? true,
      lastRemoteHash: 'lastRemoteHash' in e ? e.lastRemoteHash as string | null : '',
      ...('skipped' in e ? { skipped: e.skipped as boolean } : {}),
      ...('mtime' in e ? { mtime: e.mtime as number } : {}),
      ...('pendingDecision' in e ? { pendingDecision: e.pendingDecision as PendingDecision } : {}),
    };
  }
  return { ok: true, file };
}

export class BlobIndex {
  private file: BlobIndexFile = emptyFile();
  private writes: Promise<void> = Promise.resolve();

  constructor(private storage: BlobIndexStorage) {}

  private mutations = 0;
  // Only a validated restored snapshot clears poison; dismissing a Notice never does.
  private poison = false;
  lastPersistError: string | null = null;
  private retryTimer: number | undefined;
  private disposed = false;

  poisoned(): boolean { return this.poison; }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writes.then(task);
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Reload is itself exclusive, not merely awaiting a tail. A restarted plugin
   * has a new FIFO: its old instance/writer must already have stopped. */
  load(ready: () => Promise<void> = async () => {}): Promise<BlobIndexLoadOutcome> {
    const mutations = this.mutations;
    return this.enqueue(async () => {
      const raw = await this.storage.readRaw(BLOB_INDEX_FILE);
      const main = raw === null ? null : await validateIndexFile(raw, ready);
      let file = emptyFile();
      let result: BlobIndexLoadOutcome;
      let restoreFrom: string | null = null;
      if (main?.ok) {
        file = main.file;
        result = { outcome: 'ok' };
      } else {
        let quarantine: string | undefined;
        if (main && !main.ok) {
          console.error('[BlobIndex] corrupt main:', main.reason);
          try {
            await this.storage.writeRaw(QUARANTINE, raw!);
            quarantine = QUARANTINE;
          } catch (error) { console.warn('[BlobIndex] quarantine failed', error); }
        }
        const backupRaw = await this.storage.readRaw(BACKUP);
        const backup = backupRaw === null ? null : await validateIndexFile(backupRaw, ready);
        if (backup?.ok) {
          file = backup.file;
          result = { outcome: 'recovered', quarantine };
          restoreFrom = backupRaw!;
        } else if (!main && !backup && !this.poison) {
          result = { outcome: 'fresh' };
        } else {
          result = { outcome: 'poisoned', reason: main && !main.ok ? main.reason : 'no valid snapshot', quarantine };
        }
      }
      // PUBLISH FIRST (contract): recovery visibility is immediate, and a
      // mutation arriving during the repair I/O below composes onto the
      // recovered state instead of being lost together with it.
      if (result.outcome === 'poisoned') {
        // Poison overrides the discard guard, including all paths AND cursor.
        this.poison = true;
        this.file = emptyFile();
      } else if (this.mutations === mutations) {
        this.file = file;
        this.poison = false;
      }
      if (result.outcome === 'recovered') {
        // Inline repair AFTER publication, never append/await a descendant
        // FIFO task. Even a poisoned instance may repair from this
        // independently validated bak. A failed repair leaves the published
        // recovered memory standing and surfaces via lastPersistError.
        try {
          await this.writeVerified(BLOB_INDEX_FILE, restoreFrom!, 'main-restore', ready);
          this.succeeded();
        } catch (error) { this.failed(error); }
      }
      return result;
    });
  }

  /** Canonical key, or null when the path is not a syncable attachment. */
  keyFor(path: string): string | null {
    return blob_path_key(path) ?? null;
  }

  get(path: string): BlobIndexEntry | undefined {
    return this.file.paths[path];
  }

  /** First path whose entry carries this blob path key. */
  pathForKey(key: string): string | undefined {
    for (const [path, e] of Object.entries(this.file.paths)) if (e.key === key) return path;
    return undefined;
  }

  /** Snapshot of raw-path → entry. Index map keys are the vault path spelling. */
  entries(): Array<[string, BlobIndexEntry]> {
    return Object.entries(this.file.paths);
  }

  /** Move an entry to a new raw path (including case-only renames). */
  move(oldPath: string, newPath: string): BlobIndexEntry | null {
    if (this.refusePoison()) return null;
    if (oldPath === newPath) return this.file.paths[oldPath] ?? null;
    const entry = this.file.paths[oldPath];
    if (!entry) return null;
    const key = this.keyFor(newPath);
    if (!key) return null;
    delete this.file.paths[oldPath];
    const next: BlobIndexEntry = { ...entry, key };
    this.file.paths[newPath] = next;
    this.persist();
    return next;
  }

  remove(path: string): void {
    if (this.refusePoison()) return;
    if (!(path in this.file.paths)) return;
    delete this.file.paths[path];
    this.persist();
  }

  /**
   * Merge `patch` into the entry for `path`. Returns null (and writes nothing)
   * when the path has no blob path key.
   */
  update(path: string, patch: Partial<BlobIndexEntry>): BlobIndexEntry | null {
    if (this.refusePoison()) return null;
    const key = this.keyFor(path);
    if (!key) return null;
    const prev: BlobIndexEntry = this.file.paths[path]
      ?? { key, hash: '', size: 0, generation: 0, seq: 0, hydrated: true, lastRemoteHash: '' };
    const next: BlobIndexEntry = { ...prev, ...patch, key };
    this.file.paths[path] = next;
    this.persist();
    return next;
  }

  /** Last certified catch-up position, independent of per-path acknowledgements. */
  cursor(): number {
    return this.file.c;
  }

  advanceCursor(f: number): void {
    if (this.refusePoison()) return;
    if (f <= this.file.c) return;
    this.file.c = f;
    this.persist();
  }

  private refusePoison(): boolean {
    if (this.poison) console.warn('[BlobIndex] mutation/persist refused: poisoned');
    return this.poison;
  }

  private persist(): void {
    if (this.refusePoison()) return;
    this.mutations++;
    const snapshot = JSON.stringify(this.file); // Capture synchronously, preserving FIFO newest state.
    void this.enqueue(() => this.step(snapshot));
  }

  private async writeVerified(name: string, text: string, stage: string, ready?: () => Promise<void>): Promise<void> {
    try {
      await this.storage.writeRaw(name, text);
      const actual = await this.storage.readRaw(name);
      if (actual === null || !(await validateIndexFile(actual, ready)).ok || actual !== text) {
        throw new Error('readback invalid or unequal');
      }
    } catch (error) { throw new Error(`${stage}: ${String(error)}`, { cause: error }); }
  }

  private async step(snapshot: string): Promise<void> {
    if (this.refusePoison()) return;
    try {
      const raw = await this.storage.readRaw(BLOB_INDEX_FILE);
      const main = raw === null ? null : await validateIndexFile(raw);
      if (main?.ok) {
        // Torn bak leaves intact main; torn main leaves verified bak. Bak
        // receives only bytes read back as valid main (also after restore).
        await this.writeVerified(BACKUP, raw!, 'bak');
      } else if (raw === null && !await this.storage.existsRaw(BACKUP)) {
        // A torn FIRST write has no backup yet: restart must poison, not reset.
      } else {
        const backupRaw = await this.storage.readRaw(BACKUP);
        if (backupRaw === null || !(await validateIndexFile(backupRaw)).ok) throw new Error('no-valid-snapshot');
        await this.writeVerified(BLOB_INDEX_FILE, backupRaw, 'main-restore');
        await this.writeVerified(BACKUP, backupRaw, 'bak');
      }
      await this.writeVerified(BLOB_INDEX_FILE, snapshot, 'main');
      this.succeeded();
    } catch (error) { this.failed(error); }
  }

  private succeeded(): void {
    this.lastPersistError = null;
    if (this.retryTimer !== undefined) window.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private failed(error: unknown): void {
    this.lastPersistError = String(error);
    console.warn('[BlobIndex] persist failed', this.lastPersistError);
    if (this.disposed) return;
    if (this.retryTimer !== undefined) window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      void this.retry().catch(error => console.warn('[BlobIndex] retry failed', error));
    }, 30_000);
  }

  private retry(): Promise<void> {
    // Capture when enqueued, not when executed: a later persist must win.
    const snapshot = JSON.stringify(this.file);
    return this.enqueue(async () => {
      if (this.lastPersistError) await this.step(snapshot);
      if (this.lastPersistError) throw new Error(this.lastPersistError);
    });
  }

  async flush(): Promise<void> {
    const tail = this.writes;
    await tail;
    if (this.lastPersistError) await this.retry();
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== undefined) window.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}

import type { App } from 'obsidian';
import { nextRequestId, OWNERSHIP_CACHE_FILE } from './ownership-cache';

const STATE_DIR = '.obsidian/plugins/vaultcrdt/state';

export interface VVCacheEntry {
  vv: string;
  /** FNV-1a 64-bit hash (16-char hex) of file content at last sync. Used for fast skip. */
  contentHash: string;
}

/** One delete-journal entry. `acked` means we already emitted `doc_delete` (or saw confirmation); reconnects must not resend it. */
export interface DeleteJournalEntry {
  path: string;
  acked: boolean;
  intent_id: string;
  token: { kind: 'owned'; value: number } | { kind: 'unresolved' } | { kind: 'pinned'; value: number | null };
  attempted?: boolean;
  /** Case-only rename intents MUST preserve the local doc during crash replay. Missing means false. */
  skip_cleanup?: boolean;
}

/**
 * Persists CRDT snapshots as `.loro` files under `.obsidian/plugins/vaultcrdt/state/`.
 * One file per vault document — URI-encoded path ensures collision-free keys.
 */
export class StateStorage {
  private dirEnsured = false;

  constructor(private app: App) {}

  /** `notes/daily/2026-03-16.md` → `notes%2Fdaily%2F2026-03-16.md.loro` */
  stateKey(filePath: string): string {
    return encodeURIComponent(filePath) + '.loro';
  }

  private statePath(filePath: string): string {
    return `${STATE_DIR}/${this.stateKey(filePath)}`;
  }

  /** Load persisted snapshot bytes, or null if none exists. */
  async load(filePath: string): Promise<Uint8Array | null> {
    const path = this.statePath(filePath);
    const adapter = this.app.vault.adapter;
    try {
      const exists = await adapter.exists(path);
      if (!exists) return null;
      const buf = await adapter.readBinary(path);
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  }

  /** Save snapshot bytes for a file. Creates the state directory if needed. */
  async save(filePath: string, snapshot: Uint8Array): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!this.dirEnsured) {
      const dirExists = await adapter.exists(STATE_DIR);
      if (!dirExists) {
        await adapter.mkdir(STATE_DIR);
      }
      this.dirEnsured = true;
    }
    // Ensure we write only the actual slice (WASM may return a view into a larger buffer)
    const buf = snapshot.buffer.byteLength === snapshot.byteLength
      ? snapshot.buffer as ArrayBuffer
      : snapshot.slice().buffer;
    await adapter.writeBinary(this.statePath(filePath), buf);
  }

  /** Move persisted state when the vault path changes without changing doc identity. */
  async move(oldPath: string, newPath: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const oldStatePath = this.statePath(oldPath);
    const newStatePath = this.statePath(newPath);
    try {
      const exists = await adapter.exists(oldStatePath);
      if (!exists) return;
      const buf = await adapter.readBinary(oldStatePath);
      if (!this.dirEnsured) {
        const dirExists = await adapter.exists(STATE_DIR);
        if (!dirExists) await adapter.mkdir(STATE_DIR);
        this.dirEnsured = true;
      }
      await adapter.writeBinary(newStatePath, buf);
      if (oldStatePath !== newStatePath) await adapter.remove(oldStatePath);
    } catch {
      // ignore — subsequent sync can rebuild state if needed
    }
  }

  /** Remove persisted state for a deleted file. */
  async remove(filePath: string): Promise<void> {
    const path = this.statePath(filePath);
    const adapter = this.app.vault.adapter;
    try {
      const exists = await adapter.exists(path);
      if (exists) await adapter.remove(path);
    } catch {
      // ignore — file may already be gone
    }
  }

  /** List all stored state keys (filenames without the base path). */
  async list(): Promise<string[]> {
    const adapter = this.app.vault.adapter;
    try {
      const exists = await adapter.exists(STATE_DIR);
      if (!exists) return [];
      const result = await adapter.list(STATE_DIR);
      return result.files.map((f) => f.replace(`${STATE_DIR}/`, ''));
    } catch {
      return [];
    }
  }

  /** Get sizes of all .loro state files. Returns array of [stateKey, bytes]. */
  async sizes(): Promise<Array<[string, number]>> {
    const adapter = this.app.vault.adapter;
    try {
      const exists = await adapter.exists(STATE_DIR);
      if (!exists) return [];
      const result = await adapter.list(STATE_DIR);
      const entries: Array<[string, number]> = [];
      for (const f of result.files) {
        const stat = await adapter.stat(f);
        if (stat) entries.push([f.replace(`${STATE_DIR}/`, ''), stat.size]);
      }
      return entries;
    } catch {
      return [];
    }
  }

  // ── Orphan cleanup ──────────────────────────────────────────────────────

  /**
   * Remove .loro files that don't match any known doc path.
   * validPaths should contain all file paths that are either local or on the server.
   * Returns the number of orphans removed.
   */
  async cleanOrphans(validPaths: Set<string>): Promise<number> {
    const validKeys = new Set<string>();
    for (const p of validPaths) validKeys.add(this.stateKey(p));

    const allKeys = await this.list();
    const adapter = this.app.vault.adapter;
    let removed = 0;

    for (const key of allKeys) {
      if (key === 'vv-cache.json') continue;
      if (key === 'delete-journal.json' || key === OWNERSHIP_CACHE_FILE) continue;
      if (key === 'inbox.json') continue;
      if (key === 'blob-index.json' || key === 'blob-index.bak' || key === 'blob-index.corrupt.json') continue;
      if (validKeys.has(key)) continue;
      try {
        await adapter.remove(`${STATE_DIR}/${key}`);
        removed++;
      } catch {
        // ignore — file may already be gone
      }
    }
    return removed;
  }

  /** Raw index reads distinguish absence from adapter failures. */
  existsRaw(name: string): Promise<boolean> {
    return this.app.vault.adapter.exists(`${STATE_DIR}/${name}`);
  }

  async readRaw(name: string): Promise<string | null> {
    if (!await this.existsRaw(name)) return null;
    return this.app.vault.adapter.read(`${STATE_DIR}/${name}`);
  }

  async writeRaw(name: string, text: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!this.dirEnsured) {
      if (!await adapter.exists(STATE_DIR)) await adapter.mkdir(STATE_DIR);
      this.dirEnsured = true;
    }
    await adapter.write(`${STATE_DIR}/${name}`, text);
  }

  // ── Generic JSON state ────────────────────────────────────────────────────

  /**
   * Persist an arbitrary JSON document under `state/<name>`. Used by state
   * that must NOT live in settings (diagnostics dumps settings verbatim),
   * e.g. `inbox.json`.
   */
  async saveJson(name: string, value: unknown): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!this.dirEnsured) {
      const dirExists = await adapter.exists(STATE_DIR);
      if (!dirExists) await adapter.mkdir(STATE_DIR);
      this.dirEnsured = true;
    }
    await adapter.write(`${STATE_DIR}/${name}`, JSON.stringify(value));
  }

  /** Load a JSON document written by saveJson(). Returns null when absent/corrupt. */
  async loadJson<T>(name: string): Promise<T | null> {
    const adapter = this.app.vault.adapter;
    try {
      const path = `${STATE_DIR}/${name}`;
      const exists = await adapter.exists(path);
      if (!exists) return null;
      return JSON.parse(await adapter.read(path)) as T;
    } catch {
      return null;
    }
  }

  // ── VV Cache ──────────────────────────────────────────────────────────────

  private vvCachePath = `${STATE_DIR}/vv-cache.json`;

  /**
   * Persist the shared VV/content-hash cache used by initialSync fast-path
   * decisions. Device-local dirty state is stored separately.
   */
  async saveVVCache(map: Map<string, VVCacheEntry>): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!this.dirEnsured) {
      const dirExists = await adapter.exists(STATE_DIR);
      if (!dirExists) await adapter.mkdir(STATE_DIR);
      this.dirEnsured = true;
    }
    const obj: Record<string, VVCacheEntry | number> = { _version: 5 };
    for (const [k, v] of map) obj[k] = v;
    await adapter.write(this.vvCachePath, JSON.stringify(obj));
  }

  /**
   * Load the shared VV/content-hash cache.
   *
   * Accepts ONLY v5, the first schema that stores 64-bit (16-char hex) content
   * hashes. v3/v4 caches held 32-bit numeric hashes; loading them would let a
   * 32-bit collision silently skip a real change, so they are rejected (null)
   * and the next startup does a full, safe re-sync. Older legacy schemas are
   * likewise treated as reset/null.
   */
  async loadVVCache(): Promise<Map<string, VVCacheEntry> | null> {
    const adapter = this.app.vault.adapter;
    try {
      const exists = await adapter.exists(this.vvCachePath);
      if (!exists) return null;
      const raw = await adapter.read(this.vvCachePath);
      const obj = JSON.parse(raw) as Record<string, unknown>;
      if (obj._version !== 5) return null;

      const result = new Map<string, VVCacheEntry>();
      for (const [k, v] of Object.entries(obj)) {
        if (k === '_version') continue;
        const entry = v as Partial<VVCacheEntry> & { dirty?: boolean };
        result.set(k, {
          vv: typeof entry.vv === 'string' ? entry.vv : '',
          contentHash: typeof entry.contentHash === 'string' ? entry.contentHash : '',
        });
      }
      return result;
    } catch {
      return null;
    }
  }

  // ── Delete Journal ────────────────────────────────────────────────────────

  private deleteJournalPath = `${STATE_DIR}/delete-journal.json`;

  /**
   * Persist outstanding delete intents. Survives plugin restart so offline
   * (unacked) deletes cannot be lost. Version 2 stores `{ path, acked }` so
   * reconnects can resend only unacked entries.
   */
  async saveDeleteJournal(entries: DeleteJournalEntry[]): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!this.dirEnsured) {
      const dirExists = await adapter.exists(STATE_DIR);
      if (!dirExists) await adapter.mkdir(STATE_DIR);
      this.dirEnsured = true;
    }
    await adapter.write(
      this.deleteJournalPath,
      JSON.stringify({ _version: 2, entries }),
    );
  }

  /** Load the delete journal. v1 `{ paths }` is treated as all-unacked. */
  async loadDeleteJournal(): Promise<DeleteJournalEntry[]> {
    const adapter = this.app.vault.adapter;
    try {
      const exists = await adapter.exists(this.deleteJournalPath);
      if (!exists) return [];
      const raw = await adapter.read(this.deleteJournalPath);
      const obj = JSON.parse(raw) as { paths?: unknown; entries?: unknown };
      if (Array.isArray(obj.entries)) {
        const loaded: DeleteJournalEntry[] = [];
        for (const item of obj.entries) {
          if (item === null || typeof item !== 'object') continue;
          const rec = item as Partial<DeleteJournalEntry>;
          if (typeof rec.path !== 'string') continue;
          loaded.push({
            path: rec.path, acked: rec.acked === true,
            intent_id: typeof rec.intent_id === 'string' ? rec.intent_id : nextRequestId(),
            token: rec.token ?? { kind: 'unresolved' },
            attempted: rec.attempted === true,
            skip_cleanup: rec.skip_cleanup === true,
          });
        }
        return loaded;
      }
      if (Array.isArray(obj.paths)) {
        return obj.paths
          .filter((p): p is string => typeof p === 'string')
          .map((path) => ({ path, acked: false, intent_id: nextRequestId(), token: { kind: 'unresolved' }, attempted: false, skip_cleanup: false }));
      }
      return [];
    } catch {
      return [];
    }
  }

  /** Delete all persisted state (full reset). */
  async clear(): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      const exists = await adapter.exists(STATE_DIR);
      if (!exists) return;
      const result = await adapter.list(STATE_DIR);
      await Promise.all(result.files.map((f) => adapter.remove(f)));
    } catch {
      // ignore
    }
  }
}

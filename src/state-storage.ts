import type { App } from 'obsidian';

const STATE_DIR = '.obsidian/plugins/vaultcrdt/state';

export interface VVCacheEntry {
  vv: string;
  /** FNV-1a hash of file content at last sync. Used for fast skip. */
  contentHash: number;
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
      : snapshot.slice().buffer as ArrayBuffer;
    await adapter.writeBinary(this.statePath(filePath), buf);
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
      if (key === 'delete-journal.json') continue;
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

  // ── VV Cache ──────────────────────────────────────────────────────────────

  private vvCachePath = `${STATE_DIR}/vv-cache.json`;

  /** Persist VV cache with content hashes for fast skip on next startup. */
  async saveVVCache(map: Map<string, VVCacheEntry>): Promise<void> {
    const adapter = this.app.vault.adapter;
    const obj: Record<string, VVCacheEntry | number> = { _version: 3 };
    for (const [k, v] of map) obj[k] = v;
    await adapter.write(this.vvCachePath, JSON.stringify(obj));
  }

  /** Load persisted VV cache. Migrates old formats (v1/v2) to sentinel entries. */
  async loadVVCache(): Promise<Map<string, VVCacheEntry> | null> {
    const adapter = this.app.vault.adapter;
    try {
      const exists = await adapter.exists(this.vvCachePath);
      if (!exists) return null;
      const raw = await adapter.read(this.vvCachePath);
      const obj = JSON.parse(raw) as Record<string, unknown>;

      const result = new Map<string, VVCacheEntry>();

      if (obj._version === 3) {
        // Current format: entries have { vv, contentHash }
        for (const [k, v] of Object.entries(obj)) {
          if (k === '_version') continue;
          result.set(k, v as VVCacheEntry);
        }
      } else if (obj._version === 2) {
        // v2 format had mtime/size → extract vv, use sentinel hash
        for (const [k, v] of Object.entries(obj)) {
          if (k === '_version') continue;
          const entry = v as { vv: string };
          result.set(k, { vv: entry.vv, contentHash: 0 });
        }
      } else {
        // v1 format: values are plain VV strings
        for (const [k, v] of Object.entries(obj)) {
          result.set(k, { vv: v as string, contentHash: 0 });
        }
      }
      return result;
    } catch {
      return null;
    }
  }

  // ── Delete Journal ────────────────────────────────────────────────────────

  private deleteJournalPath = `${STATE_DIR}/delete-journal.json`;

  /**
   * Persist the set of paths that have an outstanding (unsent or unacknowledged)
   * delete intent. Survives plugin restart so offline deletes cannot be lost.
   */
  async saveDeleteJournal(paths: string[]): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!this.dirEnsured) {
      const dirExists = await adapter.exists(STATE_DIR);
      if (!dirExists) await adapter.mkdir(STATE_DIR);
      this.dirEnsured = true;
    }
    await adapter.write(
      this.deleteJournalPath,
      JSON.stringify({ _version: 1, paths }),
    );
  }

  /** Load the offline delete journal. Returns [] if the file doesn't exist. */
  async loadDeleteJournal(): Promise<string[]> {
    const adapter = this.app.vault.adapter;
    try {
      const exists = await adapter.exists(this.deleteJournalPath);
      if (!exists) return [];
      const raw = await adapter.read(this.deleteJournalPath);
      const obj = JSON.parse(raw) as { paths?: unknown };
      if (!Array.isArray(obj.paths)) return [];
      return obj.paths.filter((p): p is string => typeof p === 'string');
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

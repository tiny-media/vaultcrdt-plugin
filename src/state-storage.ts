import type { App } from 'obsidian';

const STATE_DIR = '.obsidian/plugins/vaultcrdt/state';

/**
 * Persists CRDT snapshots as `.loro` files under `.obsidian/plugins/vaultcrdt/state/`.
 * One file per vault document — path-safe encoding replaces `/` with `_`.
 */
export class StateStorage {
  private dirEnsured = false;

  constructor(private app: App) {}

  /** `notes/daily/2026-03-16.md` → `notes_daily_2026-03-16.loro` */
  stateKey(filePath: string): string {
    return filePath.replace(/\//g, '_').replace(/\.md$/, '') + '.loro';
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

import { App } from 'obsidian';
import { createDocument, type WasmSyncDocument } from './wasm-bridge';
import { StateStorage, type VVCacheEntry } from './state-storage';
import { error } from './logger';

export class DocumentManager {
  private documents = new Map<string, WasmSyncDocument>();
  private storage: StateStorage;

  constructor(app: App, private peerId: string) {
    this.storage = new StateStorage(app);
  }

  get(filePath: string): WasmSyncDocument | undefined {
    return this.documents.get(filePath);
  }

  /** Load from in-memory cache, or create new doc and restore persisted CRDT state. */
  async getOrLoad(filePath: string): Promise<WasmSyncDocument> {
    const cached = this.documents.get(filePath);
    if (cached) return cached;

    // Pass docUuid + stable peerId so the Loro doc commits its own ops on a
    // single per-device VV line (see derive_peer_id in vaultcrdt-crdt). Tests
    // mock createDocument and ignore the args, but production correctness
    // depends on this.
    const doc = createDocument(filePath, this.peerId);
    const saved = await this.storage.load(filePath);
    if (saved) {
      doc.import_snapshot(saved);
    }
    this.documents.set(filePath, doc);
    return doc;
  }

  /** Persist the CRDT snapshot for one file. */
  async persist(filePath: string): Promise<void> {
    const doc = this.documents.get(filePath);
    if (!doc) return;
    try {
      const snapshot = doc.export_snapshot();
      await this.storage.save(filePath, snapshot);
    } catch (err) {
      error('[VCRDT] persist failed:', filePath, err);
    }
  }

  /** Persist all in-memory documents (called on plugin stop). */
  async persistAll(): Promise<void> {
    for (const [path] of this.documents) {
      await this.persist(path);
    }
  }

  /** Remove from memory and delete persisted state. */
  async removeAndClean(filePath: string): Promise<void> {
    this.documents.delete(filePath);
    await this.storage.remove(filePath);
  }

  has(filePath: string): boolean {
    return this.documents.has(filePath);
  }

  remove(filePath: string): void {
    this.documents.delete(filePath);
  }

  paths(): string[] {
    return [...this.documents.keys()];
  }

  entries(): IterableIterator<[string, WasmSyncDocument]> {
    return this.documents.entries();
  }

  size(): number {
    return this.documents.size;
  }

  async getStorageSizes(): Promise<Array<[string, number]>> {
    return this.storage.sizes();
  }

  async loadPersistedSnapshot(filePath: string): Promise<Uint8Array | null> {
    return this.storage.load(filePath);
  }

  async cleanOrphans(validPaths: Set<string>): Promise<number> {
    return this.storage.cleanOrphans(validPaths);
  }

  async saveVVCache(map: Map<string, VVCacheEntry>): Promise<void> {
    return this.storage.saveVVCache(map);
  }

  async loadVVCache(): Promise<Map<string, VVCacheEntry> | null> {
    return this.storage.loadVVCache();
  }

  async saveDeleteJournal(paths: string[]): Promise<void> {
    return this.storage.saveDeleteJournal(paths);
  }

  async loadDeleteJournal(): Promise<string[]> {
    return this.storage.loadDeleteJournal();
  }
}

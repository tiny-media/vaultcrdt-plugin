import type { VaultCRDTSettings } from './settings';
import type { DocumentManager } from './document-manager';
import type { EditorIntegration } from './editor-integration';
import type { WasmSyncDocument } from './wasm-bridge';
import { log, warn, error } from './logger';

export class PushHandler {
  private pushDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingDeletes = new Set<string>();

  constructor(
    private docs: DocumentManager,
    private editor: EditorIntegration,
    private send: (msg: object) => void,
    private settings: VaultCRDTSettings,
    private lastRemoteWrite: Map<string, string>,
    private lastServerVV: Map<string, string>,
    private setStatus: (s: 'syncing') => void,
    private isWsOpen: () => boolean,
    private tag: string,
  ) {}

  onFileChanged(path: string): void {
    const existing = this.pushDebounceTimers.get(path);
    if (existing) clearTimeout(existing);
    this.pushDebounceTimers.set(
      path,
      setTimeout(() => {
        this.pushDebounceTimers.delete(path);
        const freshContent = this.editor.readCurrentContent(path);
        if (freshContent !== null) {
          this.pushFileDelta(path, freshContent);
        }
      }, Math.max(this.settings.debounceMs, 300)),
    );
  }

  onFileChangedImmediate(path: string, content: string): void {
    this.pushFileDelta(path, content);
  }

  onFileDeleted(path: string): void {
    void this.docs.removeAndClean(path);
    this.lastServerVV.delete(path);
    // Add to the in-memory journal *synchronously* — the disk write is
    // fire-and-forget so callers (and tests) see the send happen on the
    // same tick. If the WS is open we also remove the path right after
    // send succeeded. Either way the final persistJournal() reflects the
    // resulting in-memory state.
    this.pendingDeletes.add(path);
    if (this.isWsOpen()) {
      this.send({ type: 'doc_delete', doc_uuid: path, peer_id: this.settings.peerId });
      this.pendingDeletes.delete(path);
    }
    void this.persistJournal();
  }

  onFileRenamed(oldPath: string, newPath: string, content: string): void {
    this.onFileDeleted(oldPath);
    this.pushFileDelta(newPath, content);
  }

  /** Standalone delete for the unsyncable-transition case in main.ts. */
  deleteOnly(path: string): void {
    this.onFileDeleted(path);
  }

  /** True if `path` has an outstanding offline/unacknowledged delete. */
  hasPendingDelete(path: string): boolean {
    return this.pendingDeletes.has(path);
  }

  /** Snapshot of the pending delete set. */
  pendingDeletePaths(): string[] {
    return [...this.pendingDeletes];
  }

  /** Load the persistent delete journal into memory. Call during plugin start. */
  async loadPendingDeletesFromJournal(): Promise<void> {
    const paths = await this.docs.loadDeleteJournal();
    for (const p of paths) this.pendingDeletes.add(p);
  }

  private async persistJournal(): Promise<void> {
    try {
      await this.docs.saveDeleteJournal([...this.pendingDeletes]);
    } catch (err) {
      warn(`${this.tag} delete journal persist failed`, { err });
    }
  }

  /** Flush pending debounce edits into CRDT before merging broadcast. */
  async flushPendingEdits(path: string): Promise<void> {
    const timer = this.pushDebounceTimers.get(path);
    if (!timer) return;
    clearTimeout(timer);
    this.pushDebounceTimers.delete(path);
    const freshContent = this.editor.readCurrentContent(path);
    if (freshContent !== null) {
      const doc = await this.docs.getOrLoad(path);
      if (!doc.text_matches(freshContent)) {
        const vvBefore = doc.export_vv_json();
        doc.sync_from_disk(freshContent);
        // Push flushed ops to server immediately — otherwise these local ops
        // never reach the server, breaking the causal chain for subsequent deltas.
        try {
          const delta = doc.export_delta_since_vv_json(vvBefore);
          if (delta.length > 0) {
            this.send({ type: 'sync_push', doc_uuid: path, delta, peer_id: this.settings.peerId });
            log(`${this.tag} flushed + pushed pending edits`, { path, deltaLen: delta.length });
          }
        } catch (err) {
          warn(`${this.tag} flush push failed`, { path, err });
        }
      }
    }
  }

  pushDocCreate(filePath: string, doc: WasmSyncDocument): void {
    try {
      const snapshot = doc.export_snapshot();
      log(`${this.tag} doc_create`, { path: filePath, version: doc.version(), snapshotLen: snapshot.length });
      this.send({
        type: 'doc_create',
        doc_uuid: filePath,
        snapshot,
        peer_id: this.settings.peerId,
      });
    } catch (err) {
      error(`${this.tag} export_snapshot failed:`, filePath, err);
    }
  }

  /**
   * Flush queued offline deletes synchronously (keeps the WS FIFO in order
   * with whatever the caller sends next). Journal persistence runs in the
   * background.
   */
  flushPendingDeletes(): void {
    if (this.pendingDeletes.size === 0) return;
    for (const path of this.pendingDeletes) {
      log(`${this.tag} flushing offline delete`, { path });
      this.send({ type: 'doc_delete', doc_uuid: path, peer_id: this.settings.peerId });
    }
    this.pendingDeletes.clear();
    void this.persistJournal();
  }

  stopAllTimers(): void {
    for (const timer of this.pushDebounceTimers.values()) clearTimeout(timer);
    this.pushDebounceTimers.clear();
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private pushFileDelta(path: string, content: string): void {
    void this.pushFileDeltaAsync(path, content);
  }

  private async pushFileDeltaAsync(path: string, content: string): Promise<void> {
    // Prefer fresh editor content over potentially stale disk content.
    const freshEditorContent = this.editor.readCurrentContent(path);
    if (freshEditorContent !== null) content = freshEditorContent;

    // Suppress echo: if content matches what we just wrote from remote, skip
    const lastRemote = this.lastRemoteWrite.get(path);
    if (lastRemote !== undefined && lastRemote === content) {
      this.lastRemoteWrite.delete(path);
      return;
    }
    this.lastRemoteWrite.delete(path);

    const doc = await this.docs.getOrLoad(path);
    if (doc.text_matches(content)) return;

    // Capture VV before applying disk change
    const vvBefore = doc.export_vv_json();
    doc.sync_from_disk(content);
    this.setStatus('syncing');

    // Export delta since the VV before this edit
    try {
      const delta = doc.export_delta_since_vv_json(vvBefore);
      log(`${this.tag} sync_push`, { path, version: doc.version(), deltaLen: delta.length });
      this.send({
        type: 'sync_push',
        doc_uuid: path,
        delta,
        peer_id: this.settings.peerId,
      });
    } catch (err) {
      error(`${this.tag} export_delta failed, falling back to doc_create:`, path, err);
      this.pushDocCreate(path, doc);
    }
    await this.docs.persist(path);
  }
}

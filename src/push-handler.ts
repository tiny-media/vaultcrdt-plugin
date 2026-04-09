import type { VaultCRDTSettings } from './settings';
import type { DocumentManager } from './document-manager';
import type { EditorIntegration } from './editor-integration';
import type { WasmSyncDocument } from './wasm-bridge';
import { log, warn, error } from './logger';

/**
 * Delete-Journal invariant (see gpt-audit archive-2026-04-07 follow-up):
 *
 * - Entries are ADDED only in onFileDeleted() when the user deletes a path.
 * - Entries are REMOVED only by reconcilePendingDeletes() after runInitialSync
 *   observed the server's truth via request_doc_list: either the path is
 *   tombstoned on the server (confirmed), or the server does not know the
 *   path at all (tombstone-expiry / never existed — also safe to clear).
 * - Paths that are still active on the server stay in the journal and are
 *   retried on the next reconnect.
 * - A successful send() is NOT confirmation. The WS may die between send and
 *   server commit; only the next reconcile can decide.
 * - The journal may therefore grow during a long session; it shrinks on the
 *   next reconnect-triggered initial sync.
 */
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
    private tracePath: (event: string, path: string, data?: Record<string, unknown>) => void,
  ) {}

  onFileChanged(path: string): void {
    const existing = this.pushDebounceTimers.get(path);
    if (existing) clearTimeout(existing);
    const delayMs = Math.max(this.settings.debounceMs, 300);
    this.tracePath('push.debounce.schedule', path, { delayMs });
    this.pushDebounceTimers.set(
      path,
      setTimeout(() => {
        this.pushDebounceTimers.delete(path);
        const freshContent = this.editor.readCurrentContent(path);
        this.tracePath('push.debounce.fire', path, {
          hasEditorContent: freshContent !== null,
          contentLen: freshContent?.length ?? 0,
        });
        if (freshContent !== null) {
          this.pushFileDelta(path, freshContent);
        }
      }, delayMs),
    );
  }

  onFileChangedImmediate(path: string, content: string): void {
    this.tracePath('push.immediate', path, { contentLen: content.length });
    this.pushFileDelta(path, content);
  }

  onFileDeleted(path: string): void {
    void this.docs.removeAndClean(path);
    this.lastServerVV.delete(path);
    // Journal = intent list. We add unconditionally, send if online, and
    // leave the entry in place until reconcilePendingDeletes() clears it
    // based on the server's doc_list view on the next initial sync.
    this.pendingDeletes.add(path);
    if (this.isWsOpen()) {
      this.send({ type: 'doc_delete', doc_uuid: path, peer_id: this.settings.peerId });
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
    this.tracePath('push.flush.begin', path, {
      hasEditorContent: freshContent !== null,
      contentLen: freshContent?.length ?? 0,
    });
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
            const wsOpen = this.isWsOpen();
            if (wsOpen) {
              this.send({ type: 'sync_push', doc_uuid: path, delta, peer_id: this.settings.peerId });
              this.tracePath('push.flush.sent', path, { deltaLen: delta.length });
              log(`${this.tag} flushed + pushed pending edits`, { path, deltaLen: delta.length });
            } else {
              this.tracePath('push.flush.deferred-offline', path, { deltaLen: delta.length });
              log(`${this.tag} flushed pending edits locally (WS closed)`, { path, deltaLen: delta.length });
            }
          }
        } catch (err) {
          this.tracePath('push.flush.error', path, { message: err instanceof Error ? err.message : String(err) });
          warn(`${this.tag} flush push failed`, { path, err });
        }
      } else {
        this.tracePath('push.flush.skip-text-match', path);
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
   * Resend all pending-delete entries as `doc_delete` messages. Idempotent
   * on the server side (tombstone upsert + delete no-op). Does NOT modify
   * the journal — clearing happens only via reconcilePendingDeletes() after
   * request_doc_list has confirmed the outcome.
   */
  resendPendingDeletes(): void {
    if (this.pendingDeletes.size === 0) return;
    for (const path of this.pendingDeletes) {
      log(`${this.tag} resending pending delete`, { path });
      this.send({ type: 'doc_delete', doc_uuid: path, peer_id: this.settings.peerId });
    }
  }

  /**
   * Reconcile the delete journal against the server's current doc_list view.
   *
   * - tombstoneSet: paths the server reports as tombstoned → confirmed delete,
   *   remove from journal.
   * - activeSet: paths the server still lists as live → our delete has not
   *   (yet) landed; keep the entry so the next reconnect resends it. Logged
   *   at warn level because within one connection, WS FIFO guarantees the
   *   server saw our resend before producing the doc_list response, so a
   *   still-active path is unexpected.
   * - neither: path gone entirely. Valid real case because the server runs
   *   a periodic tombstone-expiry task (default 90 days, see
   *   vaultcrdt-server/src/main.rs). Also catches "path never existed
   *   server-side". Safe to clear.
   *
   * Builds a new Set instead of mutating during iteration.
   */
  reconcilePendingDeletes(
    tombstoneSet: ReadonlySet<string>,
    activeSet: ReadonlySet<string>,
  ): void {
    if (this.pendingDeletes.size === 0) return;
    const nextPending = new Set<string>();
    const confirmed: string[] = [];
    const stillPending: string[] = [];
    const unknown: string[] = [];
    for (const path of this.pendingDeletes) {
      if (tombstoneSet.has(path)) {
        confirmed.push(path);
      } else if (activeSet.has(path)) {
        stillPending.push(path);
        nextPending.add(path);
      } else {
        unknown.push(path);
      }
    }
    this.pendingDeletes = nextPending;
    log(`${this.tag} delete reconcile`, {
      confirmed: confirmed.length,
      stillPending: stillPending.length,
      unknown: unknown.length,
    });
    if (stillPending.length > 0) {
      warn(`${this.tag} deletes not yet landed on server — will retry on next reconnect`, {
        paths: stillPending,
      });
    }
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
    this.tracePath('push.delta.begin', path, {
      fromEditor: freshEditorContent !== null,
      contentLen: content.length,
    });

    // Suppress echo: if content matches what we just wrote from remote, skip
    const lastRemote = this.lastRemoteWrite.get(path);
    if (lastRemote !== undefined && lastRemote === content) {
      this.lastRemoteWrite.delete(path);
      this.tracePath('push.delta.skip-echo', path, { contentLen: content.length });
      return;
    }
    this.lastRemoteWrite.delete(path);

    const doc = await this.docs.getOrLoad(path);
    if (doc.text_matches(content)) {
      this.tracePath('push.delta.skip-text-match', path, { contentLen: content.length });
      return;
    }

    // Capture VV before applying disk change
    const vvBefore = doc.export_vv_json();
    doc.sync_from_disk(content);
    this.setStatus('syncing');

    // Export delta since the VV before this edit
    try {
      const delta = doc.export_delta_since_vv_json(vvBefore);
      const wsOpen = this.isWsOpen();
      if (wsOpen) {
        this.tracePath('push.delta.sent', path, { deltaLen: delta.length });
        log(`${this.tag} sync_push`, { path, version: doc.version(), deltaLen: delta.length });
        this.send({
          type: 'sync_push',
          doc_uuid: path,
          delta,
          peer_id: this.settings.peerId,
        });
      } else {
        this.tracePath('push.delta.deferred-offline', path, { deltaLen: delta.length });
        log(`${this.tag} local delta queued implicitly via CRDT state (WS closed)`, {
          path,
          version: doc.version(),
          deltaLen: delta.length,
        });
      }
    } catch (err) {
      this.tracePath('push.delta.error', path, { message: err instanceof Error ? err.message : String(err) });
      error(`${this.tag} export_delta failed, falling back to doc_create:`, path, err);
      this.pushDocCreate(path, doc);
    }
    await this.docs.persist(path);
  }
}

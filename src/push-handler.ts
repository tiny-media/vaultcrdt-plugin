import type { VaultCRDTSettings } from './settings';
import type { DocumentManager } from './document-manager';
import type { EditorIntegration } from './editor-integration';
import type { WasmSyncDocument } from './wasm-bridge';
import { log, warn, error } from './logger';
import { isCaseOnlyPathRename, isExcalidrawPath } from './path-policy';
import { fnv1aHash64, vvCovers } from './conflict-utils';
import type { DeleteJournalEntry } from './state-storage';
import { nextRequestId, type OwnershipCache } from './ownership-cache';
import type { SyncDeltaResponse } from './sync-broker';

/**
 * Delete-Journal invariant:
 *
 * - Entries are ADDED in onFileDeleted() and in the case-only rename path
 *   (server-intent only — no local removeAndClean).
 * - Entries are also ADDED by markRecreateIntent() (remote delete kept locally; no doc_delete is sent).
 * - Each entry carries `acked`: true after we emitted `doc_delete` on an open
 *   socket (or saw a doc_deleted confirmation). The journal's resend list is
 *   unacked (typically offline) deletes only. Acking at send is intentional:
 *   a lost delete reappears as a restored file (user deletes again); a replay
 *   would kill a resurrection (data loss).
 * - Entries are REMOVED by reconcilePendingDeletes() after runInitialSync
 *   observed the server's truth via request_doc_list: tombstoned (confirmed),
 *   live-again after an acked delete (peer resurrected — must not replay),
 *   or unknown (tombstone-expiry / never existed).
 * - Unacked paths that are still live on the server stay in the journal and
 *   are retried after reconcile, never before request_doc_list.
 * - Recreate intents (local file still present) are never resent as deletes.
 */
/**
 * How long an editor keystroke burst is held before the push is sent.
 * Replaces the former user-facing `debounceMs` setting (same value, 300 ms):
 * the timing is a product decision, not a knob.
 */
export const EDIT_DEBOUNCE_MS = 300;

/** Upper bound on how long an unsynced burst of edits may sit locally.
 * Without it, a trailing debounce that resets on every keystroke never fires
 * during continuous typing while incoming edits keep arriving immediately. */
export const PUSH_MAX_WAIT_MS = 2_000;

export class PushHandler {
  private pushDebounceTimers = new Map<string, number>();
  /** First unsynced edit per path; bounds how long a burst may stay unsynced. */
  private pushFirstChangeAt = new Map<string, number>();
  private pendingDeletes = new Map<string, DeleteJournalEntry>();
  private runningDeletes = new Set<string>();
  /**
   * Paths the server reported as tombstoned in the last doc_list. The delete
   * journal entry is dropped on reconcile once the tombstone is confirmed, so
   * without this set a later re-create of the same path would go out as a plain
   * sync_push and be refused. Consulted by the branch choice in
   * pushFileDeltaAsync; an entry is consumed by the doc_create it triggers.
   */
  private serverTombstones = new Set<string>();
  /**
   * Sent-but-unacknowledged pushes (session-state only, never persisted).
   * A send() into a half-dead socket counts as sent client-side but may
   * never reach the server (no per-push ack correlation). Keeps the delete
   * keep-guard armed until the next successful initial sync reconciles
   * server truth (clearSentUnacked).
   */
  private sentUnacked = new Set<string>();
  /** Serialize journal writes so an older snapshot cannot overwrite a newer one. */
  private journalPersistChain: Promise<void> = Promise.resolve();
  /**
   * SyncEngine: conflict-copy the local drawing and adopt the remote doc.
   * Return true when the local edit must not enter the CRDT.
   */
  onExcalidrawConcurrent: ((path: string, localContent: string) => Promise<boolean>) | null = null;

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
    readonly ownership: OwnershipCache,
    private deleteIncarnationCapable: () => 'unknown' | boolean,
    private resolveDelete: (path: string, vv: null) => Promise<SyncDeltaResponse>,
  ) {}

  onFileChanged(path: string): void {
    const now = Date.now();
    const firstChange = this.pushFirstChangeAt.get(path) ?? now;
    this.pushFirstChangeAt.set(path, firstChange);
    const existing = this.pushDebounceTimers.get(path);
    if (existing) window.clearTimeout(existing);
    const debounceMs = EDIT_DEBOUNCE_MS;
    // Never hold an edit longer than PUSH_MAX_WAIT_MS after the first unsynced
    // change of the burst, even while typing keeps resetting the debounce.
    const delayMs = Math.min(
      debounceMs,
      Math.max(0, firstChange + PUSH_MAX_WAIT_MS - now),
    );
    this.tracePath('push.debounce.schedule', path, { delayMs });
    this.pushDebounceTimers.set(
      path,
      window.setTimeout(() => {
        this.pushDebounceTimers.delete(path);
        this.pushFirstChangeAt.delete(path);
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
    const entry = this.newIntent(path);
    this.pendingDeletes.set(path, entry);
    void this.sendDocDelete(entry);
  }

  onFileRenamed(oldPath: string, newPath: string, content: string): void {
    if (isCaseOnlyPathRename(oldPath, newPath)) {
      this.tracePath('push.rename.case-only', newPath, { oldPath, contentLen: content.length });
      const vv = this.lastServerVV.get(oldPath);
      if (vv !== undefined) {
        this.lastServerVV.delete(oldPath);
        this.lastServerVV.set(newPath, vv);
      }
      // Server still has the old-case path as a separate identity — send
      // doc_delete intent only. Do NOT call onFileDeleted: removeAndClean
      // would drop the in-memory doc before movePath can relocate it.
      const entry = this.newIntent(oldPath);
      entry.skip_cleanup = true;
      this.pendingDeletes.set(oldPath, entry);
      void this.sendDocDelete(entry);
      void this.docs.movePath(oldPath, newPath);
      this.pushFileDelta(newPath, content);
      return;
    }

    this.onFileDeleted(oldPath);
    this.pushFileDelta(newPath, content);
  }

  /** Standalone delete for the unsyncable-transition case in main.ts. */
  deleteOnly(path: string): void {
    this.onFileDeleted(path);
  }

  /** Remove a pending delete because the same path is being explicitly recreated. */
  consumePendingDeleteForRecreate(path: string): boolean {
    if (!this.pendingDeletes.delete(path)) return false;
    this.lastServerVV.delete(path);
    this.persistJournalInBackground();
    this.tracePath('push.delete.recreate-consume', path);
    return true;
  }

  /** Admission MUST invalidate before file reads and content-equality shortcuts. */
  admitRecreation(path: string): void {
    if (this.consumePendingDeleteForRecreate(path)) this.serverTombstones.add(path);
  }

  /** True if `path` has an outstanding offline/unacknowledged delete. */
  hasPendingDelete(path: string): boolean {
    return this.pendingDeletes.has(path);
  }

  /** Mark a previously sent delete as confirmed (doc_deleted / tombstone ack). */
  ackPendingDelete(path: string): void {
    const entry = this.pendingDeletes.get(path);
    if (!entry || entry.acked) return;
    entry.acked = true;
    this.persistJournalInBackground();
    this.tracePath('push.delete.acked', path);
  }

  /** True while a debounced editor push for `path` is scheduled but not yet fired. */
  hasPendingEdits(path: string): boolean {
    return this.pushDebounceTimers.has(path);
  }

  /** True if a push for `path` was sent but not yet reconciled by an initial sync. */
  hasUnackedEdit(path: string): boolean {
    return this.sentUnacked.has(path);
  }

  /** Clear all sent-unacked entries — initial-sync end reconciles server truth. */
  clearSentUnacked(): void {
    this.sentUnacked.clear();
  }

  /** Number of sent-but-unacknowledged pushes (diagnostics). */
  sentUnackedCount(): number {
    return this.sentUnacked.size;
  }

  /**
   * Register `path` as a recreate intent WITHOUT sending doc_delete: the server
   * already tombstoned it (remote delete) and the local file is kept on purpose.
   * The existing recreate machinery then pushes a replace-tombstone doc_create:
   * online on the next edit (pushFileDeltaAsync), offline on the next initial
   * sync (recreateFiles).
   */
  markRecreateIntent(path: string): void {
    this.pendingDeletes.set(path, this.newIntent(path));
    this.tracePath('push.delete.recreate-intent', path);
    this.persistJournalInBackground();
  }

  /** Snapshot of the pending delete set. */
  /** Record the tombstone set of the latest doc_list (called by initial sync). */
  noteServerTombstones(paths: Iterable<string>): void {
    this.serverTombstones = new Set(paths);
  }

  pendingDeletePaths(): string[] {
    return [...this.pendingDeletes.keys()];
  }

  /** Load the persistent delete journal into memory. Call during plugin start. */
  async loadPendingDeletesFromJournal(): Promise<void> {
    const entries = await this.docs.loadDeleteJournal();
    for (const e of entries) this.pendingDeletes.set(e.path, e);
  }

  private persistJournal(attempt?: DeleteJournalEntry): Promise<void> {
    const write = this.journalPersistChain.then(async () => {
      await this.docs.saveDeleteJournal([...this.pendingDeletes.values()].map(entry => ({
        ...entry, token: { ...entry.token },
        attempted: entry === attempt ? true : entry.attempted,
      })));
      if (attempt && this.ownsIntent(attempt)) attempt.attempted = true;
    });
    this.journalPersistChain = write.catch(() => {});
    return write;
  }

  private persistJournalInBackground(): void {
    void this.persistJournal().catch(err => warn(`${this.tag} delete journal persist failed`, { err }));
  }

  /** Cancel disjoint local edits without sending them to the server. */
  cancelPendingEdits(path: string): void {
    const timer = this.pushDebounceTimers.get(path);
    if (timer !== undefined) window.clearTimeout(timer);
    this.pushDebounceTimers.delete(path);
    this.pushFirstChangeAt.delete(path);
  }

  /** Flush pending debounce edits into CRDT before merging broadcast.
   *  Returns true when an excalidraw concurrent conflict was adopted (caller must abort the merge). */
  async flushPendingEdits(path: string): Promise<boolean> {
    // Read first: a null leaf walk (plausible on mobile) must not drop a
    // still-scheduled fire, and with no timer armed we still fold if the
    // editor differs from the CRDT (debounce already fired, getOrLoad still
    // in flight).
    const freshContent = this.editor.readCurrentContent(path);
    if (freshContent === null) return false;
    const timer = this.pushDebounceTimers.get(path);
    if (timer !== undefined) window.clearTimeout(timer);
    this.pushDebounceTimers.delete(path);
    this.pushFirstChangeAt.delete(path);
    this.tracePath('push.flush.begin', path, {
      hasEditorContent: true,
      contentLen: freshContent.length,
    });
    const doc = await this.docs.getOrLoad(path);
    if (doc.text_matches(freshContent)) {
      this.tracePath('push.flush.skip-text-match', path);
      return false;
    }
    if (await this.holdExcalidrawConcurrent(path, doc, freshContent)) return true;
    const vvBefore = doc.export_vv_json();
    doc.sync_from_disk(freshContent);
    // Push flushed ops to server immediately — otherwise these local ops
    // never reach the server, breaking the causal chain for subsequent deltas.
    try {
      const delta = doc.export_delta_since_vv_json(vvBefore);
      if (delta.length > 0) {
        const wsOpen = this.isWsOpen();
        if (wsOpen) {
          this.send({ type: 'sync_push', request_id: this.writeRequestId(path), doc_uuid: path, delta, peer_id: this.settings.peerId });
          this.sentUnacked.add(path);
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
    return false;
  }

  pushDocCreate(filePath: string, doc: WasmSyncDocument, options: { replaceTombstone?: boolean } = {}): void {
    try {
      const snapshot = doc.export_snapshot();
      log(`${this.tag} doc_create`, {
        path: filePath,
        version: doc.version(),
        snapshotLen: snapshot.length,
        replaceTombstone: options.replaceTombstone === true,
      });
      this.send({
        type: 'doc_create',
        request_id: this.writeRequestId(filePath),
        doc_uuid: filePath,
        snapshot,
        peer_id: this.settings.peerId,
        replace_tombstone: options.replaceTombstone === true,
      });
      this.sentUnacked.add(filePath);
      this.serverTombstones.delete(filePath);
    } catch (err) {
      error(`${this.tag} export_snapshot failed:`, filePath, err);
    }
  }

  /**
   * Resend unacked pending-delete entries as `doc_delete` messages. Acked
   * entries (already emitted or confirmed) are never resent. Recreate paths
   * (`skipPaths`) are also skipped — U37. After a send, the entry is marked
   * acked so a later reconnect cannot replay it over a resurrection.
   */
  resendPendingDeletes(skipPaths: ReadonlySet<string> = new Set()): void {
    if (this.pendingDeletes.size === 0) return;
    for (const [path, state] of this.pendingDeletes) {
      if (state.acked || state.attempted) continue;
      if (skipPaths.has(path)) {
        log(`${this.tag} skip pending delete resend for local recreate`, { path });
        continue;
      }
      log(`${this.tag} resending pending delete`, { path });
      void this.sendDocDelete(state);
    }
  }

  /**
   * Reconcile the delete journal against the server's current doc_list view.
   * Called AFTER request_doc_list and BEFORE resendPendingDeletes.
   *
   * - tombstoneSet: confirmed delete → remove from journal.
   * - activeSet + acked: live again after we already sent/confirmed the delete
   *   (peer resurrected via replaceTombstone) → drop; do not replay.
   * - activeSet + unacked: our offline delete has not landed; keep so we resend.
   * - neither: tombstone-expiry / never existed → clear.
   *
   * Recreate intents (local file present) are snapshotted by the caller before
   * this runs (U37); dropping a tombstoned recreate entry here is safe.
   */
  reconcilePendingDeletes(
    tombstoneSet: ReadonlySet<string>,
    activeSet: ReadonlySet<string>,
  ): void {
    void this.ownership.reconcile(activeSet).catch(err => warn(`${this.tag} ownership persist failed`, { err }));
    if (this.pendingDeletes.size === 0) return;
    const nextPending = new Map<string, DeleteJournalEntry>();
    const confirmed: string[] = [];
    const stillPending: string[] = [];
    const resurrected: string[] = [];
    const unknown: string[] = [];
    for (const [path, state] of this.pendingDeletes) {
      if (tombstoneSet.has(path)) {
        confirmed.push(path);
      } else if (activeSet.has(path)) {
        if (state.acked) {
          resurrected.push(path);
        } else {
          stillPending.push(path);
          nextPending.set(path, state);
        }
      } else {
        unknown.push(path);
      }
    }
    this.pendingDeletes = nextPending;
    log(`${this.tag} delete reconcile`, {
      confirmed: confirmed.length,
      stillPending: stillPending.length,
      resurrected: resurrected.length,
      unknown: unknown.length,
    });
    if (stillPending.length > 0) {
      warn(`${this.tag} deletes not yet landed on server — will retry on next reconnect`, {
        paths: stillPending,
      });
    }
    this.persistJournalInBackground();
  }

  stopAllTimers(): void {
    for (const timer of this.pushDebounceTimers.values()) window.clearTimeout(timer);
    this.pushDebounceTimers.clear();
    this.pushFirstChangeAt.clear();
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  /**
   * Emit doc_delete and mark the journal entry acked so reconnects will not replay it.
   * Intentional trade: a lost in-flight delete reappears as a restored file
   * (the user deletes again); replaying it would kill a resurrection (data loss).
   */
  writeRequestId(path: string): string {
    const id = nextRequestId();
    this.ownership.track(id, path);
    return id;
  }

  private newIntent(path: string): DeleteJournalEntry {
    const owned = this.ownership.ownedTokens.get(path);
    return { path, acked: false, intent_id: nextRequestId(), attempted: false,
      token: owned === undefined ? { kind: 'unresolved' } : { kind: 'owned', value: owned } };
  }

  private ownsIntent(entry: DeleteJournalEntry): boolean {
    return this.pendingDeletes.get(entry.path)?.intent_id === entry.intent_id;
  }

  async retireRejectedDelete(path: string, intentId: unknown): Promise<void> {
    const entry = this.pendingDeletes.get(path);
    if (typeof intentId !== 'string' || entry?.intent_id !== intentId) {
      warn(`${this.tag} ignoring unmatched delete_rejected`, { path });
      return;
    }
    this.pendingDeletes.delete(path);
    warn(`${this.tag} delete_rejected; retired exact intent`, { path, intentId });
    await this.persistJournal();
  }

  private async sendDocDelete(entry: DeleteJournalEntry, sendAllowed = this.isWsOpen()): Promise<void> {
    if (entry.acked || entry.attempted || this.runningDeletes.has(entry.intent_id)) return;
    this.runningDeletes.add(entry.intent_id);
    const path = entry.path;
    try {
      await this.persistJournal();
      if (!this.ownsIntent(entry)) return;
      if (!sendAllowed || !this.isWsOpen()) return;
      const capability = this.deleteIncarnationCapable();
      // Socket OPEN does not authorize legacy deletes. AuthOk MUST negotiate first.
      if (capability === 'unknown') return;
      if (entry.token.kind !== 'pinned') {
        let expected: number | null;
        if (capability === false) expected = null;
        else if (entry.token.kind === 'owned') expected = entry.token.value;
        else {
          const resolved = await this.resolveDelete(path, null);
          if (!this.ownsIntent(entry)) return;
          if (resolved !== null && typeof resolved.incarnation !== 'number') {
            throw new Error('capable server omitted delete incarnation');
          }
          expected = resolved === null ? 0 : resolved.incarnation!;
        }
        entry.token = { kind: 'pinned', value: expected };
      }
      await this.persistJournal(entry);
      if (!this.ownsIntent(entry)) return;
      if (entry.skip_cleanup !== true) {
        await this.docs.removeAndClean(path);
        if (!this.ownsIntent(entry)) return;
        this.lastServerVV.delete(path);
      }
      await this.ownership.remove(path);
      if (!this.ownsIntent(entry)) return;
      this.send({ type: 'doc_delete', doc_uuid: path, peer_id: this.settings.peerId,
        expected_incarnation: entry.token.value, intent_id: entry.intent_id,
        request_id: this.writeRequestId(path) });
      entry.acked = true;
      await this.persistJournal();
      if (!this.ownsIntent(entry)) return;
    } catch (err) {
      if (this.ownsIntent(entry)) warn(`${this.tag} delete deferred after failure`, { path, err });
    } finally {
      this.runningDeletes.delete(entry.intent_id);
    }
  }

  /**
   * Concurrent excalidraw: the server VV has ops this doc has not seen.
   * Do not sync_from_disk — that would CRDT-merge compressed payloads.
   * Returns true when the caller must skip the local edit / abort the merge.
   */
  private async holdExcalidrawConcurrent(
    path: string,
    doc: WasmSyncDocument,
    content: string,
  ): Promise<boolean> {
    if (!isExcalidrawPath(path)) return false;
    const serverVV = this.lastServerVV.get(path);
    if (serverVV === undefined) return false;
    if (vvCovers(doc.export_vv_json(), serverVV)) return false;
    this.cancelPendingEdits(path);
    this.tracePath('push.excalidraw-concurrent', path);
    if (this.onExcalidrawConcurrent) {
      return await this.onExcalidrawConcurrent(path, content);
    }
    warn(`${this.tag} excalidraw concurrent edit held out of CRDT`, { path });
    return true;
  }

  private pushFileDelta(path: string, content: string): void {
    void this.pushFileDeltaAsync(path, content);
  }

  private async pushFileDeltaAsync(path: string, content: string): Promise<void> {
    this.admitRecreation(path);
    // Prefer fresh editor content over potentially stale disk content.
    const freshEditorContent = this.editor.readCurrentContent(path);
    if (freshEditorContent !== null) content = freshEditorContent;
    this.tracePath('push.delta.begin', path, {
      fromEditor: freshEditorContent !== null,
      contentLen: content.length,
    });

    // Suppress echo: if content matches what we just wrote from remote, skip.
    // The map holds fnv1aHash64(content); hash only when an entry exists.
    const lastRemote = this.lastRemoteWrite.get(path);
    if (lastRemote !== undefined) {
      this.lastRemoteWrite.delete(path);
      if (lastRemote === fnv1aHash64(content)) {
        this.tracePath('push.delta.skip-echo', path, { contentLen: content.length });
        return;
      }
    }

    const doc = await this.docs.getOrLoad(path);
    if (doc.text_matches(content)) {
      this.tracePath('push.delta.skip-text-match', path, { contentLen: content.length });
      return;
    }

    if (await this.holdExcalidrawConcurrent(path, doc, content)) return;

    const recreatePendingDelete = this.pendingDeletes.has(path) || this.serverTombstones.has(path);

    // Capture VV before applying disk change
    const vvBefore = doc.export_vv_json();
    doc.sync_from_disk(content);
    this.setStatus('syncing');

    if (recreatePendingDelete && this.isWsOpen()) {
      this.consumePendingDeleteForRecreate(path);
      this.tracePath('push.delta.recreate-doc-create', path, { contentLen: content.length });
      this.pushDocCreate(path, doc, { replaceTombstone: true });
      await this.docs.persist(path);
      return;
    }

    // Export delta since the VV before this edit
    try {
      const delta = doc.export_delta_since_vv_json(vvBefore);
      const wsOpen = this.isWsOpen();
      if (wsOpen) {
        this.tracePath('push.delta.sent', path, { deltaLen: delta.length });
        log(`${this.tag} sync_push`, { path, version: doc.version(), deltaLen: delta.length });
        this.send({
          type: 'sync_push',
          request_id: this.writeRequestId(path),
          doc_uuid: path,
          delta,
          peer_id: this.settings.peerId,
        });
        this.sentUnacked.add(path);
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

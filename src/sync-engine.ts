import { App, TFile, MarkdownView, requestUrl } from 'obsidian';
import { encode, decode } from '@msgpack/msgpack';
import type { VaultCRDTSettings } from './settings';
import { createDocument, type WasmSyncDocument } from './wasm-bridge';
import { StateStorage } from './state-storage';

export type SyncStatus = 'connected' | 'syncing' | 'offline' | 'error';
export type SyncMode = 'pull' | 'push' | 'merge';

// ── Types mirroring ws.rs ────────────────────────────────────────────────────

interface DocEntry {
  doc_uuid: string;
  updated_at: string;
  server_vv: Uint8Array;
}

const HEARTBEAT_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
const WS_REQUEST_TIMEOUT_MS = 60_000;
const PARALLEL_DOWNLOADS = 5;

// ── DocumentManager ───────────────────────────────────────────────────────────

class DocumentManager {
  private documents = new Map<string, WasmSyncDocument>();
  private storage: StateStorage;

  constructor(app: App) {
    this.storage = new StateStorage(app);
  }

  get(filePath: string): WasmSyncDocument | undefined {
    return this.documents.get(filePath);
  }

  /** Load from in-memory cache, or create new doc and restore persisted CRDT state. */
  async getOrLoad(filePath: string): Promise<WasmSyncDocument> {
    const cached = this.documents.get(filePath);
    if (cached) return cached;

    const doc = createDocument();
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
      console.error('[VCRDT] persist failed:', filePath, err);
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
}

// ── SyncEngine ───────────────────────────────────────────────────────────────

export class SyncEngine {
  private docs: DocumentManager;
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private writingFromRemote = new Set<string>();
  private pendingPromises = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pushDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private backoffMs = 1_000;
  private hasConnected = false;
  private initialSyncRunning = false;
  private queuedBroadcasts: Record<string, unknown>[] = [];
  /** Stores the server VV (JSON string) per doc after last successful sync. */
  private lastServerVV = new Map<string, string>();
  /** Tracks docs currently doing a VV-gap catch-up to prevent duplicates. */
  private catchUpInProgress = new Set<string>();
  /** Queued deletes that happened while offline — flushed on reconnect. */
  private pendingDeletes = new Set<string>();
  /** Content hash of last remote write — suppresses echo pushes. */
  private lastRemoteWrite = new Map<string, string>();
  /** Guard: paths currently being updated via editor.setValue() from remote delta. */
  private updatingEditorFromRemote = new Set<string>();
  /** Serialized broadcast processing queue — prevents concurrent CRDT mutations. */
  private broadcastQueue: Promise<void> = Promise.resolve();
  /** Set to true after stop() — prevents reconnect after intentional close. */
  private stopped = false;

  statusCallback: ((s: SyncStatus) => void) | null = null;
  /** Called on WS open instead of auto-starting initialSync — allows main.ts to show onboarding modal. */
  onInitialSync: ((engine: SyncEngine) => void) | null = null;

  constructor(
    private app: App,
    private settings: VaultCRDTSettings,
  ) {
    this.docs = new DocumentManager(app);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.stopped = false;
    await this.auth();
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const timer of this.pushDebounceTimers.values()) clearTimeout(timer);
    this.pushDebounceTimers.clear();
    this.lastRemoteWrite.clear();
    this.updatingEditorFromRemote.clear();
    this.ws?.close();
    this.ws = null;
    await this.docs.persistAll();
  }

  // ── Server communication ────────────────────────────────────────────────────

  private httpBase(): string {
    return this.settings.serverUrl
      .replace(/^ws:\/\//, 'http://')
      .replace(/^wss:\/\//, 'https://');
  }

  private async auth(): Promise<void> {
    const resp = await requestUrl({
      url: `${this.httpBase()}/auth/verify`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vault_id: this.settings.vaultId,
        api_key: this.settings.apiKey,
        registration_key: this.settings.registrationKey,
      }),
    });
    this.token = resp.json.token as string;
  }

  private wsUrl(): string {
    return (
      this.settings.serverUrl
        .replace(/^http:\/\//, 'ws://')
        .replace(/^https:\/\//, 'wss://') + '/ws'
    );
  }

  private connect(): void {
    const url = `${this.wsUrl()}?token=${this.token ?? ''}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = 1_000;
      this.startHeartbeat();
      this.hasConnected = true;
      if (this.onInitialSync) {
        this.onInitialSync(this);
      } else {
        this.initialSync().catch((err) =>
          console.error(`${this.tag} initialSync error:`, err)
        );
      }
    };

    ws.onmessage = (ev: MessageEvent) => {
      this.onMessage(ev.data as ArrayBuffer);
    };

    ws.onclose = () => {
      this.setStatus('offline');
      this.stopHeartbeat();
      this.rejectAllPending('WebSocket closed');
      if (!this.stopped) this.scheduleReconnect();
    };

    ws.onerror = () => {
      this.setStatus('error');
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      void this.auth()
        .then(() => this.connect())
        .catch(() => this.scheduleReconnect());
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'ping' });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Initial sync ───────────────────────────────────────────────────────────

  async initialSync(onProgress?: (done: number, total: number) => void, mode: SyncMode = 'merge'): Promise<void> {
    this.setStatus('syncing');
    this.initialSyncRunning = true;
    this.queuedBroadcasts = [];

    try {
      // Capture local state BEFORE any network IO to prevent broadcast races
      const localFiles = this.app.vault.getMarkdownFiles() as TFile[];
      const localContents = new Map<string, string>();
      for (const file of localFiles) {
        localContents.set(file.path, await this.app.vault.read(file));
      }

      const { docs: serverDocs, tombstones } = await this.requestDocList();
      const tombstoneSet = new Set(tombstones);
      const serverDocMap = new Map(serverDocs.map((d) => [d.doc_uuid, d]));
      const localPathSet = new Set(localContents.keys());
      console.log(`${this.tag} initialSync start`, {
        serverDocs: serverDocs.length,
        localFiles: localFiles.length,
        tombstones,
      });

      // 1. Server-only docs — request delta (no local VV)
      const serverOnlyUuids = [...serverDocMap.keys()].filter(
        (uuid) => !tombstoneSet.has(uuid) && !localPathSet.has(uuid)
      );
      const overlappingFiles = localFiles.filter(
        (f) => !tombstoneSet.has(f.path) && serverDocMap.has(f.path)
      );
      const localOnlyFiles = localFiles.filter(
        (f) => !tombstoneSet.has(f.path) && !serverDocMap.has(f.path)
      );
      const totalSteps = serverOnlyUuids.length + overlappingFiles.length + localOnlyFiles.length;
      let stepsDone = 0;

      let downloadOk = 0;
      let downloadFail = 0;
      if (mode !== 'push') {
        console.log(`${this.tag} downloading ${serverOnlyUuids.length} server-only docs (parallel=${PARALLEL_DOWNLOADS})`);
        // Parallel downloads with sliding window
        let wsAbortError: Error | null = null;
        const downloadOne = async (uuid: string): Promise<void> => {
          // Resumable: skip docs that already have persisted CRDT state
          const existing = await this.docs.getOrLoad(uuid);
          if (existing.version() > 0) {
            downloadOk++;
            stepsDone++;
            onProgress?.(stepsDone, totalSteps);
            return;
          }

          try {
            const result = await this.requestSyncStart(uuid, null);
            if (result) {
              const doc = await this.docs.getOrLoad(uuid);
              doc.import_snapshot(result.delta);
              this.lastServerVV.set(uuid, result.serverVV);
              await this.writeToVault(uuid, doc.get_text());
              await this.docs.persist(uuid);
              downloadOk++;
            }
          } catch (err) {
            downloadFail++;
            console.warn(`${this.tag} download failed for ${uuid}:`, err);
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
              wsAbortError = err as Error;
            }
          }
          stepsDone++;
          onProgress?.(stepsDone, totalSteps);
        };

        // Sliding window: keep up to PARALLEL_DOWNLOADS in flight
        const inFlight = new Set<Promise<void>>();
        for (const uuid of serverOnlyUuids) {
          if (wsAbortError) break;
          const p = downloadOne(uuid).then(() => { inFlight.delete(p); });
          inFlight.add(p);
          if (inFlight.size >= PARALLEL_DOWNLOADS) {
            await Promise.race(inFlight);
          }
        }
        await Promise.all(inFlight);

        if (wsAbortError) {
          console.warn(`${this.tag} WS closed during download, aborting (${downloadOk} ok, ${downloadFail} fail)`);
          throw wsAbortError;
        }
      } else {
        // Push mode: skip downloads, just advance progress
        stepsDone += serverOnlyUuids.length;
        onProgress?.(stepsDone, totalSteps);
      }
      console.log(`${this.tag} download complete: ${downloadOk} ok, ${downloadFail} fail of ${serverOnlyUuids.length}`);

      // 2. Overlapping docs — send local VV, import delta, push own ops if needed
      for (const file of localFiles) {
        if (tombstoneSet.has(file.path)) continue;
        if (!serverDocMap.has(file.path)) continue;

        const doc = await this.docs.getOrLoad(file.path);
        const localContent = localContents.get(file.path) ?? '';
        const hadPersistedState = doc.version() > 0;

        // Concurrent-create conflict detection: file created offline without CRDT history
        if (!hadPersistedState && localContent.trim() !== '') {
          const result = await this.requestSyncStart(file.path, null);
          if (result && result.delta.length > 0) {
            const tempDoc = createDocument();
            tempDoc.import_snapshot(result.delta);
            const serverText = tempDoc.get_text();

            if (serverText.trim() !== '' && serverText !== localContent) {
              // Concurrent create — fork local content to conflict file
              const cPath = this.conflictPath(file.path);
              console.warn(`${this.tag} concurrent create conflict`, { path: file.path, conflictPath: cPath });
              await this.app.vault.create(cPath, localContent);

              // Adopt server version
              doc.import_snapshot(result.delta);
              this.lastServerVV.set(file.path, result.serverVV);
              await this.writeToVault(file.path, doc.get_text());
              await this.docs.persist(file.path);
              continue;
            }
          }
        }

        // Detect external disk changes (edits outside Obsidian while it was closed).
        // hadLocalDiskChange is only true for genuine external edits — normal Obsidian
        // edits persist the CRDT state on every sync, so text_matches() returns true.
        const hadLocalDiskChange = !doc.text_matches(localContent) && localContent.trim() !== '';

        // Sync local disk changes into CRDT before computing VV
        if (hadLocalDiskChange) {
          doc.sync_from_disk(localContent);
        }

        const clientVV = doc.export_vv_json();
        const result = await this.requestSyncStart(file.path, clientVV);

        if (result) {
          // Concurrent external-edit conflict detection: if local file was edited
          // externally AND server has new changes, a CRDT merge would interleave
          // characters (both sides did text diffs independently). Reconstruct the
          // pure server text and compare — if different from local, create conflict.
          if (result.delta.length > 0 && hadLocalDiskChange) {
            const persistedSnapshot = await this.docs.loadPersistedSnapshot(file.path);
            const tempDoc = createDocument();
            if (persistedSnapshot) tempDoc.import_snapshot(persistedSnapshot);
            tempDoc.import_snapshot(result.delta);
            const serverText = tempDoc.get_text();

            if (serverText.trim() !== '' && serverText !== localContent) {
              const cPath = this.conflictPath(file.path);
              console.warn(`${this.tag} concurrent external edit conflict`, { path: file.path, conflictPath: cPath });
              await this.app.vault.create(cPath, localContent);

              // Adopt server version: request full snapshot (our delta is VV-relative)
              await this.docs.removeAndClean(file.path);
              const freshDoc = await this.docs.getOrLoad(file.path);
              const fullResult = await this.requestSyncStart(file.path, null);
              if (fullResult && fullResult.delta.length > 0) {
                freshDoc.import_snapshot(fullResult.delta);
                this.lastServerVV.set(file.path, fullResult.serverVV);
              }
              await this.writeToVault(file.path, freshDoc.get_text());
              await this.docs.persist(file.path);
              continue;
            }
          }

          // Disjoint-VV conflict detection: if both sides have content but no shared
          // CRDT history (no common peer IDs), merging would interleave characters.
          // Fork local content and adopt server state cleanly instead.
          if (
            result.delta.length > 0 &&
            clientVV !== '{}' &&
            !this.hasSharedHistory(clientVV, result.serverVV)
          ) {
            const tempDoc = createDocument();
            tempDoc.import_snapshot(result.delta);
            const serverText = tempDoc.get_text();

            if (serverText.trim() !== '' && localContent.trim() !== '' && serverText !== localContent) {
              const cPath = this.conflictPath(file.path);
              console.warn(`${this.tag} disjoint VV conflict`, { path: file.path, conflictPath: cPath });
              await this.app.vault.create(cPath, localContent);

              // Reset CRDT state and adopt server version cleanly
              await this.docs.removeAndClean(file.path);
              const freshDoc = await this.docs.getOrLoad(file.path);
              freshDoc.import_snapshot(result.delta);
              this.lastServerVV.set(file.path, result.serverVV);
              await this.writeToVault(file.path, freshDoc.get_text());
              await this.docs.persist(file.path);
              continue;
            }
          }

          // Import server delta
          if (result.delta.length > 0) {
            doc.import_snapshot(result.delta);
          }
          this.lastServerVV.set(file.path, result.serverVV);

          const serverContent = doc.get_text();

          if (localContent.trim() === '' && serverContent.trim() !== '') {
            // Empty local, adopt server
            console.log(`${this.tag} overlapping: empty local, adopting server`, { path: file.path });
            await this.writeToVault(file.path, serverContent);
          } else {
            // Push our ops if server doesn't have them (VV-based, not content-based).
            // Content can match even when the client has unpushed ops (e.g. offline edits
            // that the server never received — the CRDT text is already correct locally,
            // but the server still has the old state).
            const clientVVAfterMerge = doc.export_vv_json();
            if (!this.vvCovers(result.serverVV, clientVVAfterMerge)) {
              const delta = doc.export_delta_since_vv_json(result.serverVV);
              if (delta.length > 0) {
                console.log(`${this.tag} overlapping push delta (VV gap)`, { path: file.path, deltaLen: delta.length });
                this.send({
                  type: 'sync_push',
                  doc_uuid: file.path,
                  delta,
                  peer_id: this.settings.peerId,
                });
              }
            } else {
              console.log(`${this.tag} overlapping match`, { path: file.path });
            }

            // Write merged content to vault if different from disk
            if (localContent !== serverContent) {
              await this.writeToVault(file.path, serverContent);
            }
          }
        }
        await this.docs.persist(file.path);
        stepsDone++;
        onProgress?.(stepsDone, totalSteps);
      }

      // 3. Local-only docs — push full snapshot via doc_create (skip in pull mode)
      if (mode !== 'pull') {
        for (const file of localFiles) {
          if (tombstoneSet.has(file.path) || serverDocMap.has(file.path)) continue;
          const content = localContents.get(file.path) ?? '';
          console.log(`${this.tag} local-only push`, { path: file.path, contentLen: content.length });
          const doc = await this.docs.getOrLoad(file.path);
          doc.sync_from_disk(content);
          this.pushDocCreate(file.path, doc);
          await this.docs.persist(file.path);
          stepsDone++;
          onProgress?.(stepsDone, totalSteps);
        }
      } else {
        stepsDone += localOnlyFiles.length;
        onProgress?.(stepsDone, totalSteps);
      }

      // 4. Flush queued offline deletes
      for (const path of this.pendingDeletes) {
        console.log(`${this.tag} flushing offline delete`, { path });
        this.send({ type: 'doc_delete', doc_uuid: path, peer_id: this.settings.peerId });
      }
      this.pendingDeletes.clear();

      // 5. Tombstones — trash local files (skip if server also has the doc — create-after-delete)
      for (const uuid of tombstoneSet) {
        if (serverDocMap.has(uuid)) continue;
        const f = this.app.vault.getAbstractFileByPath(uuid);
        if (f instanceof TFile) {
          this.writingFromRemote.add(uuid);
          try {
            await this.app.vault.trash(f, true);
          } finally {
            setTimeout(() => this.writingFromRemote.delete(uuid), 500);
          }
        }
      }
    } finally {
      this.initialSyncRunning = false;

      // Process any broadcasts that arrived during initialSync (even on error —
      // already-synced docs should still receive updates)
      for (const queued of this.queuedBroadcasts) {
        const type = queued.type as string;
        if (type === 'delta_broadcast') {
          await this.onDeltaBroadcast(queued);
        } else if (type === 'doc_deleted') {
          await this.onDocDeleted(queued.doc_uuid as string);
        }
      }
      this.queuedBroadcasts = [];

      this.setStatus('connected');
    }
  }

  // ── Message handling ────────────────────────────────────────────────────────

  private onMessage(data: ArrayBuffer): void {
    const msg = decode(new Uint8Array(data)) as Record<string, unknown>;
    const type = msg.type as string;

    switch (type) {
      case 'doc_list':
        this.resolvePromise('doc_list', {
          docs: msg.docs as DocEntry[],
          tombstones: msg.tombstones as string[],
        });
        break;

      case 'sync_delta':
        this.resolvePromise(`sync_delta:${msg.doc_uuid as string}`, {
          delta: msg.delta as Uint8Array,
          serverVV: new TextDecoder().decode(msg.server_vv as Uint8Array),
        });
        break;

      case 'doc_unknown':
        this.resolvePromise(`sync_delta:${msg.doc_uuid as string}`, null);
        break;

      case 'delta_broadcast':
        if (this.initialSyncRunning) {
          console.log(`${this.tag} broadcast queued (initialSync running)`, { doc: msg.doc_uuid });
          this.queuedBroadcasts.push(msg);
        } else {
          this.enqueueBroadcast(msg);
        }
        break;

      case 'doc_deleted':
        if (this.initialSyncRunning) {
          console.log(`${this.tag} delete queued (initialSync running)`, { doc: msg.doc_uuid });
          this.queuedBroadcasts.push(msg);
        } else {
          void this.onDocDeleted(msg.doc_uuid as string);
        }
        break;

      case 'ack':
        this.setStatus('connected');
        break;

      case 'pong':
        break;

      case 'error':
        console.warn(`${this.tag} Server error:`, msg.message);
        break;
    }
  }

  /** Serialize broadcast processing to prevent concurrent CRDT mutations on the same doc. */
  private enqueueBroadcast(msg: Record<string, unknown>): void {
    this.broadcastQueue = this.broadcastQueue.then(() =>
      this.onDeltaBroadcast(msg).catch((err) => {
        console.error(`${this.tag} broadcast handler FAILED`, { doc: msg.doc_uuid, err });
      })
    );
  }

  private async onDeltaBroadcast(msg: Record<string, unknown>): Promise<void> {
    const docUuid = msg.doc_uuid as string;
    const delta = msg.delta as Uint8Array;

    // Flush pending debounce edits into CRDT before merging broadcast,
    // otherwise local keystrokes that haven't been sync_from_disk'd yet
    // would be lost when the merged result overwrites the editor.
    await this.flushPendingEdits(docUuid);

    const doc = await this.docs.getOrLoad(docUuid);
    const textBefore = doc.get_text();

    // Try import_and_diff for surgical editor updates; fall back to import_snapshot
    let diffJson: string | null = null;
    try {
      diffJson = doc.import_and_diff(delta);
    } catch (err) {
      console.warn(`${this.tag} import_and_diff failed, falling back to import_snapshot`, { docUuid, err });
      try {
        doc.import_snapshot(delta);
      } catch (err2) {
        console.error(`${this.tag} import_snapshot ALSO failed`, { docUuid, err2 });
        return;
      }
    }
    const textAfter = doc.get_text();

    console.log(`${this.tag} delta broadcast received`, {
      docUuid,
      peer_id: msg.peer_id as string,
      deltaLen: (delta as Uint8Array).length,
    });

    if (Math.abs(textAfter.length - textBefore.length) > Math.max(textBefore.length, 1) * 0.5) {
      console.warn(`${this.tag} large merge delta`, {
        path: docUuid, beforeLen: textBefore.length, afterLen: textAfter.length,
      });
    }

    // VV gap detection: check if local VV covers the server's VV after import
    const serverVVRaw = msg.server_vv as Uint8Array | undefined;
    if (serverVVRaw && serverVVRaw.length > 0) {
      const serverVVStr = new TextDecoder().decode(serverVVRaw);
      const localVVStr = doc.export_vv_json();

      if (!this.vvCovers(localVVStr, serverVVStr)) {
        console.warn(`${this.tag} VV gap detected after broadcast`, { docUuid, localVV: localVVStr, serverVV: serverVVStr });

        if (!this.catchUpInProgress.has(docUuid)) {
          this.catchUpInProgress.add(docUuid);
          try {
            const result = await this.requestSyncStart(docUuid, localVVStr);
            if (result && result.delta.length > 0) {
              doc.import_snapshot(result.delta);
              const catchUpText = doc.get_text();
              await this.writeToVault(docUuid, catchUpText);
            }
          } finally {
            this.catchUpInProgress.delete(docUuid);
          }
          await this.docs.persist(docUuid);
          return;
        }
      }

      this.lastServerVV.set(docUuid, serverVVStr);
    }

    // Try surgical editor update via diff; fall back to full writeToVault
    try {
      if (diffJson && this.applyDiffToEditor(docUuid, diffJson, doc.get_text())) {
        this.lastRemoteWrite.set(docUuid, doc.get_text());
        await this.docs.persist(docUuid);
        return;
      }
    } catch (err) {
      console.warn(`${this.tag} applyDiffToEditor failed, falling back to writeToVault`, { docUuid, err });
    }

    await this.writeToVault(docUuid, textAfter);
    await this.docs.persist(docUuid);
  }

  private async onDocDeleted(docUuid: string): Promise<void> {
    this.docs.remove(docUuid);
    this.lastServerVV.delete(docUuid);
    const f = this.app.vault.getAbstractFileByPath(docUuid);
    if (f instanceof TFile) {
      this.writingFromRemote.add(docUuid);
      try {
        await this.app.vault.trash(f, true);
      } finally {
        setTimeout(() => this.writingFromRemote.delete(docUuid), 0);
      }
    }
  }

  // ── Realtime push ───────────────────────────────────────────────────────────

  onFileChanged(path: string): void {
    const existing = this.pushDebounceTimers.get(path);
    if (existing) clearTimeout(existing);
    this.pushDebounceTimers.set(
      path,
      setTimeout(() => {
        this.pushDebounceTimers.delete(path);
        const freshContent = this.readCurrentContent(path);
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
    this.docs.remove(path);
    this.lastServerVV.delete(path);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'doc_delete', doc_uuid: path, peer_id: this.settings.peerId });
    } else {
      this.pendingDeletes.add(path);
    }
  }

  onFileRenamed(oldPath: string, newPath: string, content: string): void {
    this.onFileDeleted(oldPath);
    this.pushFileDelta(newPath, content);
  }

  // ── Guards ──────────────────────────────────────────────────────────────────

  isWritingFromRemote(path: string): boolean {
    return this.writingFromRemote.has(path);
  }

  isUpdatingEditorFromRemote(path: string): boolean {
    return this.updatingEditorFromRemote.has(path);
  }

  getDocument(filePath: string): WasmSyncDocument | undefined {
    return this.docs.get(filePath);
  }

  /** Get local storage stats: .loro file sizes and synced doc count. */
  async getLocalStorageStats(): Promise<{
    loroFiles: Array<[string, number]>;
    syncedDocCount: number;
  }> {
    return {
      loroFiles: await this.docs.getStorageSizes(),
      syncedDocCount: this.docs.size(),
    };
  }

  private async flushPendingEdits(path: string): Promise<void> {
    const timer = this.pushDebounceTimers.get(path);
    if (!timer) return;
    clearTimeout(timer);
    this.pushDebounceTimers.delete(path);
    const freshContent = this.readCurrentContent(path);
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
            console.log(`${this.tag} flushed + pushed pending edits`, { path, deltaLen: delta.length });
          }
        } catch (err) {
          console.warn(`${this.tag} flush push failed`, { path, err });
        }
      }
    }
  }

  readCurrentContent(path: string): string | null {
    let content: string | null = null;
    this.app.workspace.iterateAllLeaves((leaf: any) => {
      if (content !== null) return;
      if (!(leaf.view instanceof MarkdownView)) return;
      if (leaf.view.file?.path !== path) return;
      const editor = leaf.view.editor;
      if (editor) content = editor.getValue();
    });
    return content;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private pushFileDelta(path: string, content: string): void {
    void this.pushFileDeltaAsync(path, content);
  }

  private async pushFileDeltaAsync(path: string, content: string): Promise<void> {
    // Prefer fresh editor content over potentially stale disk content.
    // vault.on('modify') reads from disk asynchronously — a broadcast may have
    // updated the editor in the meantime, making the disk content stale.
    const freshEditorContent = this.readCurrentContent(path);
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
      console.log(`${this.tag} sync_push`, { path, version: doc.version(), deltaLen: delta.length });
      this.send({
        type: 'sync_push',
        doc_uuid: path,
        delta,
        peer_id: this.settings.peerId,
      });
    } catch (err) {
      console.error(`${this.tag} export_delta failed, falling back to doc_create:`, path, err);
      this.pushDocCreate(path, doc);
    }
    await this.docs.persist(path);
  }

  private pushDocCreate(filePath: string, doc: WasmSyncDocument): void {
    try {
      const snapshot = doc.export_snapshot();
      console.log(`${this.tag} doc_create`, { path: filePath, version: doc.version(), snapshotLen: snapshot.length });
      this.send({
        type: 'doc_create',
        doc_uuid: filePath,
        snapshot,
        peer_id: this.settings.peerId,
      });
    } catch (err) {
      console.error(`${this.tag} export_snapshot failed:`, filePath, err);
    }
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encode(msg));
    }
  }

  requestDocList(): Promise<{ docs: DocEntry[]; tombstones: string[] }> {
    this.send({ type: 'request_doc_list' });
    return this.waitForPromise('doc_list');
  }

  private requestSyncStart(
    docUuid: string,
    clientVV: string | null,
  ): Promise<{ delta: Uint8Array; serverVV: string } | null> {
    const clientVVBytes = clientVV !== null
      ? new TextEncoder().encode(clientVV)
      : null;
    this.send({
      type: 'sync_start',
      doc_uuid: docUuid,
      client_vv: clientVVBytes,
    });
    return this.waitForPromise(`sync_delta:${docUuid}`);
  }

  /** Create a promise that resolves when resolvePromise is called, or rejects on timeout / WS close. */
  private waitForPromise<T>(key: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPromises.delete(key);
        reject(new Error(`WS request timeout: ${key}`));
      }, WS_REQUEST_TIMEOUT_MS);

      this.pendingPromises.set(key, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
    });
  }

  /** Reject all pending promises (called on WS close). */
  private rejectAllPending(reason: string): void {
    const count = this.pendingPromises.size;
    if (count === 0) return;
    console.warn(`${this.tag} rejecting ${count} pending promises: ${reason}`);
    for (const [, entry] of this.pendingPromises) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pendingPromises.clear();
  }

  private resolvePromise(key: string, value: unknown): void {
    const entry = this.pendingPromises.get(key);
    if (entry) {
      this.pendingPromises.delete(key);
      clearTimeout(entry.timer);
      entry.resolve(value);
    }
  }

  private async writeToVault(filePath: string, content: string): Promise<void> {
    console.log(`${this.tag} writeToVault`, { filePath, contentLen: content.length });
    const existing = this.app.vault.getAbstractFileByPath(filePath);

    // Skip write if content is already identical
    if (existing instanceof TFile) {
      const current = await this.app.vault.read(existing);
      if (current === content) return;
    }

    this.lastRemoteWrite.set(filePath, content);

    // Strategy 1: Editor open → update buffer directly (no "externally modified" dialog)
    if (this.applyToEditor(filePath, content)) {
      return; // Obsidian autosave handles disk persistence
    }

    // Strategy 2: No editor open → disk write (fallback)
    this.writingFromRemote.add(filePath);
    try {
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      } else {
        // Ensure parent directories exist (mobile Obsidian doesn't auto-create them)
        const dir = filePath.substring(0, filePath.lastIndexOf('/'));
        if (dir) {
          await this.ensureDir(dir);
        }
        await this.app.vault.create(filePath, content);
      }
    } finally {
      setTimeout(() => this.writingFromRemote.delete(filePath), 500);
    }
  }

  /** Recursively create directories if they don't exist. */
  private async ensureDir(dir: string): Promise<void> {
    if (this.app.vault.getAbstractFileByPath(dir)) return;
    const parent = dir.substring(0, dir.lastIndexOf('/'));
    if (parent) {
      await this.ensureDir(parent);
    }
    try {
      await this.app.vault.createFolder(dir);
    } catch {
      // folder may have been created concurrently
    }
  }

  /**
   * Apply a TextDelta diff surgically to open editors for filePath.
   * Uses editor.transaction() so the cursor stays in place automatically.
   * Returns true if at least one editor was updated, false if no editor found.
   * Falls back to false if the diff cannot be applied cleanly.
   */
  private applyDiffToEditor(filePath: string, diffJson: string, expectedText: string): boolean {
    let ops: Array<{ retain?: number; insert?: string; delete?: number }>;
    try {
      ops = JSON.parse(diffJson);
    } catch {
      return false;
    }
    if (!Array.isArray(ops) || ops.length === 0) return false;

    let applied = false;

    this.app.workspace.iterateAllLeaves((leaf) => {
      if (applied) return; // only apply to first matching editor
      if (!(leaf.view instanceof MarkdownView)) return;
      if (leaf.view.file?.path !== filePath) return;

      const editor = leaf.view.editor;
      if (!editor) return;

      // Build EditorChange array from TextDelta ops
      const changes: Array<{ from: { line: number; ch: number }; to?: { line: number; ch: number }; text: string }> = [];
      let offset = 0;

      for (const op of ops) {
        if (op.retain !== undefined) {
          offset += op.retain;
        } else if (op.insert !== undefined) {
          const from = editor.offsetToPos(offset);
          changes.push({ from, text: op.insert });
          // Don't advance offset — insert doesn't consume existing chars
        } else if (op.delete !== undefined) {
          const from = editor.offsetToPos(offset);
          const to = editor.offsetToPos(offset + op.delete);
          changes.push({ from, to, text: '' });
          offset += op.delete; // Advance past deleted chars in original document
        }
      }

      if (changes.length === 0) return;

      this.updatingEditorFromRemote.add(filePath);
      try {
        editor.transaction({ changes });
      } finally {
        this.updatingEditorFromRemote.delete(filePath);
      }

      // Verification: ensure editor content matches CRDT state
      if (editor.getValue() !== expectedText) {
        console.warn(`${this.tag} diff apply mismatch, falling back to setValue`, { filePath });
        this.updatingEditorFromRemote.add(filePath);
        try {
          const cursor = editor.getCursor();
          editor.setValue(expectedText);
          const lastLine = editor.lastLine();
          const line = Math.min(cursor.line, lastLine);
          const maxCh = editor.getLine(line).length;
          editor.setCursor({ line, ch: Math.min(cursor.ch, maxCh) });
        } finally {
          this.updatingEditorFromRemote.delete(filePath);
        }
      }

      applied = true;
    });

    return applied;
  }

  /**
   * Apply content directly to all open editors for filePath.
   * Returns true if at least one editor was updated, false if no editor found.
   */
  private applyToEditor(filePath: string, content: string): boolean {
    let applied = false;

    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!(leaf.view instanceof MarkdownView)) return;
      if (leaf.view.file?.path !== filePath) return;

      const editor = leaf.view.editor;
      if (!editor) return; // Reading mode — no editor

      // Save cursor, apply content, restore cursor (clamped to valid range)
      const cursor = editor.getCursor();
      this.updatingEditorFromRemote.add(filePath);
      try {
        editor.setValue(content);
      } finally {
        this.updatingEditorFromRemote.delete(filePath);
      }

      // Clamp cursor to valid range after content change
      const lastLine = editor.lastLine();
      const line = Math.min(cursor.line, lastLine);
      const maxCh = editor.getLine(line).length;
      const ch = Math.min(cursor.ch, maxCh);
      editor.setCursor({ line, ch });

      applied = true;
    });

    return applied;
  }

  /** Check if vvA covers all peers/counters in vvB (no gaps). */
  private vvCovers(vvA: string, vvB: string): boolean {
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
  private hasSharedHistory(clientVV: string, serverVV: string): boolean {
    try {
      const client = JSON.parse(clientVV) as Record<string, number>;
      const server = JSON.parse(serverVV) as Record<string, number>;
      return Object.keys(client).some(peer => peer in server);
    } catch {
      return true; // Parse error → assume shared (safe default, no fork)
    }
  }

  private conflictPath(path: string): string {
    const date = new Date().toISOString().slice(0, 10);
    const dot = path.lastIndexOf('.');
    const ext = dot >= 0 ? path.slice(dot) : '';
    const base = path.slice(0, path.length - ext.length);
    let candidate = `${base} (conflict ${date})${ext}`;
    let counter = 2;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = `${base} (conflict ${date} ${counter})${ext}`;
      counter++;
    }
    return candidate;
  }

  private setStatus(s: SyncStatus): void {
    this.statusCallback?.(s);
  }

  /** Log tag including peerId for multi-vault console debugging. */
  private get tag(): string {
    return `[VCRDT:${this.settings.peerId}]`;
  }
}

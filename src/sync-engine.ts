import { App, TFile, requestUrl } from 'obsidian';
import { encode, decode } from '@msgpack/msgpack';
import type { VaultCRDTSettings } from './settings';
import { createDocument, type WasmSyncDocument } from './wasm-bridge';
import { DocumentManager } from './document-manager';
import { vvCovers, hasSharedHistory, conflictPath } from './conflict-utils';
import { PromiseManager } from './promise-manager';
import { EditorIntegration } from './editor-integration';
import { PushHandler } from './push-handler';
import { log, warn, error } from './logger';

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
const PARALLEL_DOWNLOADS = 5;

// ── SyncEngine ───────────────────────────────────────────────────────────────

export class SyncEngine {
  private docs: DocumentManager;
  private editor: EditorIntegration;
  private push: PushHandler;
  private promises = new PromiseManager();
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private writingFromRemote = new Set<string>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 1_000;
  private hasConnected = false;
  private initialSyncRunning = false;
  private queuedBroadcasts: Record<string, unknown>[] = [];
  /** Stores the server VV (JSON string) per doc after last successful sync. */
  private lastServerVV = new Map<string, string>();
  /** Tracks docs currently doing a VV-gap catch-up to prevent duplicates. */
  private catchUpInProgress = new Set<string>();
  /** Content hash of last remote write — suppresses echo pushes. */
  private lastRemoteWrite = new Map<string, string>();
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
    this.editor = new EditorIntegration(app, this.writingFromRemote, this.lastRemoteWrite, this.tag);
    this.push = new PushHandler(
      this.docs,
      this.editor,
      (msg) => this.send(msg),
      this.settings,
      this.lastRemoteWrite,
      this.lastServerVV,
      (s) => this.setStatus(s),
      () => this.ws?.readyState === WebSocket.OPEN,
      this.tag,
    );
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
    this.push.stopAllTimers();
    this.lastRemoteWrite.clear();
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
    const device = encodeURIComponent(this.settings.deviceName || 'unknown');
    const url = `${this.wsUrl()}?token=${this.token ?? ''}&device=${device}`;
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
          error(`${this.tag} initialSync error:`, err)
        );
      }
    };

    ws.onmessage = (ev: MessageEvent) => {
      this.onMessage(ev.data as ArrayBuffer);
    };

    ws.onclose = () => {
      this.setStatus('offline');
      this.stopHeartbeat();
      this.promises.rejectAll('WebSocket closed', this.tag);
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

  async initialSync(onProgress?: (done: number, total: number, changed: number) => void, mode: SyncMode = 'merge'): Promise<void> {
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
      log(`${this.tag} initialSync start`, {
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
      let changed = 0;

      let downloadOk = 0;
      let downloadFail = 0;
      if (mode !== 'push') {
        log(`${this.tag} downloading ${serverOnlyUuids.length} server-only docs (parallel=${PARALLEL_DOWNLOADS})`);
        // Parallel downloads with sliding window
        let wsAbortError: Error | null = null;
        const downloadOne = async (uuid: string): Promise<void> => {
          // Resumable: skip docs that already have persisted CRDT state
          const existing = await this.docs.getOrLoad(uuid);
          if (existing.version() > 0) {
            downloadOk++;
            stepsDone++;
            onProgress?.(stepsDone, totalSteps, changed);
            return;
          }

          try {
            const result = await this.requestSyncStart(uuid, null);
            if (result) {
              const doc = await this.docs.getOrLoad(uuid);
              doc.import_snapshot(result.delta);
              this.lastServerVV.set(uuid, result.serverVV);
              await this.editor.writeToVault(uuid, doc.get_text());
              await this.docs.persist(uuid);
              downloadOk++;
              changed++;
            }
          } catch (err) {
            downloadFail++;
            warn(`${this.tag} download failed for ${uuid}:`, err);
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
              wsAbortError = err as Error;
            }
          }
          stepsDone++;
          onProgress?.(stepsDone, totalSteps, changed);
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
          warn(`${this.tag} WS closed during download, aborting (${downloadOk} ok, ${downloadFail} fail)`);
          throw wsAbortError;
        }
      } else {
        // Push mode: skip downloads, just advance progress
        stepsDone += serverOnlyUuids.length;
        onProgress?.(stepsDone, totalSteps, changed);
      }
      log(`${this.tag} download complete: ${downloadOk} ok, ${downloadFail} fail of ${serverOnlyUuids.length}`);

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
              const cPath = conflictPath(this.app, file.path);
              warn(`${this.tag} concurrent create conflict`, { path: file.path, conflictPath: cPath });
              await this.app.vault.create(cPath, localContent);

              // Adopt server version
              doc.import_snapshot(result.delta);
              this.lastServerVV.set(file.path, result.serverVV);
              await this.editor.writeToVault(file.path, doc.get_text());
              await this.docs.persist(file.path);
              changed++;
              stepsDone++;
              onProgress?.(stepsDone, totalSteps, changed);
              continue;
            }
          }
        }

        // Detect external disk changes (edits outside Obsidian while it was closed).
        const hadLocalDiskChange = !doc.text_matches(localContent) && localContent.trim() !== '';

        // Sync local disk changes into CRDT before computing VV
        if (hadLocalDiskChange) {
          doc.sync_from_disk(localContent);
        }

        const clientVV = doc.export_vv_json();
        const result = await this.requestSyncStart(file.path, clientVV);

        if (result) {
          // Concurrent external-edit conflict detection
          if (result.delta.length > 0 && hadLocalDiskChange) {
            const persistedSnapshot = await this.docs.loadPersistedSnapshot(file.path);
            const tempDoc = createDocument();
            if (persistedSnapshot) tempDoc.import_snapshot(persistedSnapshot);
            tempDoc.import_snapshot(result.delta);
            const serverText = tempDoc.get_text();

            if (serverText.trim() !== '' && serverText !== localContent) {
              const cPath = conflictPath(this.app, file.path);
              warn(`${this.tag} concurrent external edit conflict`, { path: file.path, conflictPath: cPath });
              await this.app.vault.create(cPath, localContent);

              await this.docs.removeAndClean(file.path);
              const freshDoc = await this.docs.getOrLoad(file.path);
              const fullResult = await this.requestSyncStart(file.path, null);
              if (fullResult && fullResult.delta.length > 0) {
                freshDoc.import_snapshot(fullResult.delta);
                this.lastServerVV.set(file.path, fullResult.serverVV);
              }
              await this.editor.writeToVault(file.path, freshDoc.get_text());
              await this.docs.persist(file.path);
              changed++;
              stepsDone++;
              onProgress?.(stepsDone, totalSteps, changed);
              continue;
            }
          }

          // Disjoint-VV conflict detection
          if (
            result.delta.length > 0 &&
            clientVV !== '{}' &&
            !hasSharedHistory(clientVV, result.serverVV)
          ) {
            const tempDoc = createDocument();
            tempDoc.import_snapshot(result.delta);
            const serverText = tempDoc.get_text();

            if (serverText.trim() !== '' && localContent.trim() !== '' && serverText !== localContent) {
              const cPath = conflictPath(this.app, file.path);
              warn(`${this.tag} disjoint VV conflict`, { path: file.path, conflictPath: cPath });
              await this.app.vault.create(cPath, localContent);

              await this.docs.removeAndClean(file.path);
              const freshDoc = await this.docs.getOrLoad(file.path);
              freshDoc.import_snapshot(result.delta);
              this.lastServerVV.set(file.path, result.serverVV);
              await this.editor.writeToVault(file.path, freshDoc.get_text());
              await this.docs.persist(file.path);
              changed++;
              stepsDone++;
              onProgress?.(stepsDone, totalSteps, changed);
              continue;
            }
          }

          // Import server delta
          let docChanged = result.delta.length > 0;
          if (docChanged) {
            doc.import_snapshot(result.delta);
          }
          this.lastServerVV.set(file.path, result.serverVV);

          const serverContent = doc.get_text();

          if (localContent.trim() === '' && serverContent.trim() !== '') {
            log(`${this.tag} overlapping: empty local, adopting server`, { path: file.path });
            await this.editor.writeToVault(file.path, serverContent);
          } else {
            const clientVVAfterMerge = doc.export_vv_json();
            if (!vvCovers(result.serverVV, clientVVAfterMerge)) {
              const delta = doc.export_delta_since_vv_json(result.serverVV);
              if (delta.length > 0) {
                log(`${this.tag} overlapping push delta (VV gap)`, { path: file.path, deltaLen: delta.length });
                docChanged = true;
                this.send({
                  type: 'sync_push',
                  doc_uuid: file.path,
                  delta,
                  peer_id: this.settings.peerId,
                });
              }
            } else {
              log(`${this.tag} overlapping match`, { path: file.path });
            }

            if (localContent !== serverContent) {
              await this.editor.writeToVault(file.path, serverContent);
            }
          }
          if (docChanged) changed++;
        }
        await this.docs.persist(file.path);
        stepsDone++;
        onProgress?.(stepsDone, totalSteps, changed);
      }

      // 3. Local-only docs — push full snapshot via doc_create (skip in pull mode)
      if (mode !== 'pull') {
        for (const file of localFiles) {
          if (tombstoneSet.has(file.path) || serverDocMap.has(file.path)) continue;
          const content = localContents.get(file.path) ?? '';
          log(`${this.tag} local-only push`, { path: file.path, contentLen: content.length });
          const doc = await this.docs.getOrLoad(file.path);
          doc.sync_from_disk(content);
          this.push.pushDocCreate(file.path, doc);
          await this.docs.persist(file.path);
          changed++;
          stepsDone++;
          onProgress?.(stepsDone, totalSteps, changed);
        }
      } else {
        stepsDone += localOnlyFiles.length;
        onProgress?.(stepsDone, totalSteps, changed);
      }

      // 4. Flush queued offline deletes
      this.push.flushPendingDeletes();

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
        this.promises.resolve('doc_list', {
          docs: msg.docs as DocEntry[],
          tombstones: msg.tombstones as string[],
        });
        break;

      case 'sync_delta':
        this.promises.resolve(`sync_delta:${msg.doc_uuid as string}`, {
          delta: msg.delta as Uint8Array,
          serverVV: new TextDecoder().decode(msg.server_vv as Uint8Array),
        });
        break;

      case 'doc_unknown':
        this.promises.resolve(`sync_delta:${msg.doc_uuid as string}`, null);
        break;

      case 'delta_broadcast':
        if (this.initialSyncRunning) {
          log(`${this.tag} broadcast queued (initialSync running)`, { doc: msg.doc_uuid });
          this.queuedBroadcasts.push(msg);
        } else {
          this.enqueueBroadcast(msg);
        }
        break;

      case 'doc_deleted':
        if (this.initialSyncRunning) {
          log(`${this.tag} delete queued (initialSync running)`, { doc: msg.doc_uuid });
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
        warn(`${this.tag} Server error:`, msg.message);
        break;
    }
  }

  private enqueueBroadcast(msg: Record<string, unknown>): void {
    this.broadcastQueue = this.broadcastQueue.then(() =>
      this.onDeltaBroadcast(msg).catch((err) => {
        error(`${this.tag} broadcast handler FAILED`, { doc: msg.doc_uuid, err });
      })
    );
  }

  private async onDeltaBroadcast(msg: Record<string, unknown>): Promise<void> {
    const docUuid = msg.doc_uuid as string;
    const delta = msg.delta as Uint8Array;

    await this.push.flushPendingEdits(docUuid);

    const doc = await this.docs.getOrLoad(docUuid);
    const textBefore = doc.get_text();

    let diffJson: string | null = null;
    try {
      diffJson = doc.import_and_diff(delta);
    } catch (err) {
      warn(`${this.tag} import_and_diff failed, falling back to import_snapshot`, { docUuid, err });
      try {
        doc.import_snapshot(delta);
      } catch (err2) {
        error(`${this.tag} import_snapshot ALSO failed`, { docUuid, err2 });
        return;
      }
    }
    const textAfter = doc.get_text();

    log(`${this.tag} delta broadcast received`, {
      docUuid,
      peer_id: msg.peer_id as string,
      deltaLen: (delta as Uint8Array).length,
    });

    if (Math.abs(textAfter.length - textBefore.length) > Math.max(textBefore.length, 1) * 0.5) {
      warn(`${this.tag} large merge delta`, {
        path: docUuid, beforeLen: textBefore.length, afterLen: textAfter.length,
      });
    }

    // VV gap detection
    const serverVVRaw = msg.server_vv as Uint8Array | undefined;
    if (serverVVRaw && serverVVRaw.length > 0) {
      const serverVVStr = new TextDecoder().decode(serverVVRaw);
      const localVVStr = doc.export_vv_json();

      if (!vvCovers(localVVStr, serverVVStr)) {
        warn(`${this.tag} VV gap detected after broadcast`, { docUuid, localVV: localVVStr, serverVV: serverVVStr });

        if (!this.catchUpInProgress.has(docUuid)) {
          this.catchUpInProgress.add(docUuid);
          try {
            const result = await this.requestSyncStart(docUuid, localVVStr);
            if (result && result.delta.length > 0) {
              doc.import_snapshot(result.delta);
              const catchUpText = doc.get_text();
              await this.editor.writeToVault(docUuid, catchUpText);
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
      if (diffJson && this.editor.applyDiffToEditor(docUuid, diffJson, doc.get_text())) {
        this.lastRemoteWrite.set(docUuid, doc.get_text());
        await this.docs.persist(docUuid);
        return;
      }
    } catch (err) {
      warn(`${this.tag} applyDiffToEditor failed, falling back to writeToVault`, { docUuid, err });
    }

    await this.editor.writeToVault(docUuid, textAfter);
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

  // ── Public API (delegated to PushHandler) ──────────────────────────────────

  onFileChanged(path: string): void {
    this.push.onFileChanged(path);
  }

  onFileChangedImmediate(path: string, content: string): void {
    this.push.onFileChangedImmediate(path, content);
  }

  onFileDeleted(path: string): void {
    this.push.onFileDeleted(path);
  }

  onFileRenamed(oldPath: string, newPath: string, content: string): void {
    this.push.onFileRenamed(oldPath, newPath, content);
  }

  // ── Guards ──────────────────────────────────────────────────────────────────

  isWritingFromRemote(path: string): boolean {
    return this.writingFromRemote.has(path);
  }

  isUpdatingEditorFromRemote(path: string): boolean {
    return this.editor.isUpdatingEditorFromRemote(path);
  }

  readCurrentContent(path: string): string | null {
    return this.editor.readCurrentContent(path);
  }

  getDocument(filePath: string): WasmSyncDocument | undefined {
    return this.docs.get(filePath);
  }

  async getLocalStorageStats(): Promise<{
    loroFiles: Array<[string, number]>;
    syncedDocCount: number;
  }> {
    return {
      loroFiles: await this.docs.getStorageSizes(),
      syncedDocCount: this.docs.size(),
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encode(msg));
    }
  }

  requestDocList(): Promise<{ docs: DocEntry[]; tombstones: string[] }> {
    this.send({ type: 'request_doc_list' });
    return this.promises.waitFor('doc_list');
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
    return this.promises.waitFor(`sync_delta:${docUuid}`);
  }

  private setStatus(s: SyncStatus): void {
    this.statusCallback?.(s);
  }

  /** Log tag including peerId for multi-vault console debugging. */
  private get tag(): string {
    return `[VCRDT:${this.settings.peerId}]`;
  }
}

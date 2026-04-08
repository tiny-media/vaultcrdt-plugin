import { App, TFile, requestUrl } from 'obsidian';
import { encode, decode } from '@msgpack/msgpack';
import type { VaultCRDTSettings } from './settings';
import { type WasmSyncDocument } from './wasm-bridge';
import { DocumentManager } from './document-manager';
import { vvCovers } from './conflict-utils';
import { PromiseManager } from './promise-manager';
import { EditorIntegration } from './editor-integration';
import { PushHandler } from './push-handler';
import { log, warn, error } from './logger';
import { isSyncablePath } from './path-policy';
import { validateServerUrl, toHttpBase, toWsBase } from './url-policy';
import { runInitialSync, type SyncMode } from './sync-initial';

export type SyncStatus = 'connected' | 'syncing' | 'offline' | 'error';
export { type SyncMode } from './sync-initial';

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
  /**
   * One-shot admin token sent with the next /auth/verify call to register
   * a new vault. Cleared after the first successful auth. Never persisted.
   */
  private oneShotAdminToken: string | null = null;

  statusCallback: ((s: SyncStatus) => void) | null = null;
  /** Fires on every message received from the server (pong, ack, delta, etc.). */
  onServerActivity: (() => void) | null = null;
  /** Called on WS open — main.ts auto-detects sync mode and runs initialSync. */
  onInitialSync: ((engine: SyncEngine) => void) | null = null;

  constructor(
    private app: App,
    private settings: VaultCRDTSettings,
  ) {
    // Startup-Invariante: peerId is guaranteed non-empty by main.ts
    // (loadSettings() generates one before constructing SyncEngine). We pass
    // it through so every CRDT doc commits ops on a stable per-device VV line.
    this.docs = new DocumentManager(app, settings.peerId);
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
    // Last line of defence: refuse to start if the saved server URL is not
    // acceptable to the central policy (plain http/ws outside localhost/LAN,
    // malformed, wrong scheme). This catches any bypass that may have slipped
    // past SetupModal or SettingsTab.
    const check = validateServerUrl(this.settings.serverUrl);
    if (!check.ok) {
      error(`${this.tag} refusing to start: ${check.reason}`);
      throw new Error(`Invalid server URL: ${check.reason}`);
    }
    // Restore offline delete intents from the persistent journal before we
    // reconnect, so initialSync can skip redownloading paths that were
    // deleted while offline.
    await this.push.loadPendingDeletesFromJournal();
    await this.auth();
    this.connect();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
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
    return toHttpBase(this.settings.serverUrl);
  }

  /**
   * Arm a one-shot admin token for the next /auth/verify call. Used by
   * main.ts and the settings Reconfigure flow to register a brand-new
   * vault without persisting the token to disk.
   */
  setOneShotAdminToken(token: string): void {
    this.oneShotAdminToken = token;
  }

  private async auth(): Promise<void> {
    const body: Record<string, string> = {
      vault_id: this.settings.vaultId,
      api_key: this.settings.vaultSecret,
    };
    if (this.oneShotAdminToken) {
      body.admin_token = this.oneShotAdminToken;
    }
    const resp = await requestUrl({
      url: `${this.httpBase()}/auth/verify`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    this.token = resp.json.token as string;
    // Clear only after a successful call so a transient failure lets a
    // retry (e.g. scheduleReconnect) re-send the token. Plugin reload
    // still drops it because it only lives in RAM.
    this.oneShotAdminToken = null;
  }

  /**
   * Drop all in-memory CRDT state and persisted .loro/vv-cache/delete-journal
   * files. Used by the settings Reconfigure flow when the user points the
   * plugin at a different vault, so the new vault starts from a clean state
   * instead of inheriting stale snapshots keyed only by file path.
   */
  async wipeLocalState(): Promise<void> {
    await this.docs.clearAll();
    this.lastServerVV.clear();
    this.lastRemoteWrite.clear();
    this.catchUpInProgress.clear();
    this.queuedBroadcasts = [];
  }

  private wsUrl(): string {
    return toWsBase(this.settings.serverUrl) + '/ws';
  }

  private connect(): void {
    const device = encodeURIComponent(this.settings.deviceName || 'unknown');
    const peerId = encodeURIComponent(this.settings.peerId || '');
    const url = `${this.wsUrl()}?token=${this.token ?? ''}&device=${device}&peer_id=${peerId}`;
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
      await runInitialSync(
        {
          app: this.app,
          docs: this.docs,
          editor: this.editor,
          push: this.push,
          lastServerVV: this.lastServerVV,
          lastRemoteWrite: this.lastRemoteWrite,
          writingFromRemote: this.writingFromRemote,
          tag: this.tag,
          peerId: this.settings.peerId,
          ws: this.ws,
          send: (msg) => this.send(msg),
          requestDocList: () => this.requestDocList(),
          requestSyncStart: (uuid, vv) => this.requestSyncStart(uuid, vv),
        },
        onProgress,
        mode,
      );
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
    this.onServerActivity?.();

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

      case 'doc_tombstoned':
        warn(`${this.tag} doc is tombstoned on server — push refused`, { doc: msg.doc_uuid });
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
    if (!isSyncablePath(docUuid)) {
      warn(`${this.tag} rejected broadcast for invalid path`, { docUuid });
      return;
    }
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
            await this.push.flushPendingEdits(docUuid);
            const result = await this.requestSyncStart(docUuid, localVVStr);
            if (result && result.delta.length > 0) {
              // Use surgical diff for any open editor doc to preserve typing.
              const hasOpenEditor = this.editor.hasOpenEditor(docUuid);
              let catchUpDiffJson: string | null = null;
              if (hasOpenEditor) {
                try {
                  catchUpDiffJson = doc.import_and_diff(result.delta);
                } catch {
                  doc.import_snapshot(result.delta);
                }
              } else {
                doc.import_snapshot(result.delta);
              }
              const catchUpText = doc.get_text();
              if (hasOpenEditor && catchUpDiffJson) {
                if (this.editor.applyDiffToEditor(docUuid, catchUpDiffJson, catchUpText, true)) {
                  const postContent = this.editor.readCurrentContent(docUuid);
                  if (postContent !== null && !doc.text_matches(postContent)) {
                    doc.sync_from_disk(postContent);
                  }
                  this.lastRemoteWrite.set(docUuid, postContent ?? catchUpText);
                } else {
                  await this.editor.writeToVault(docUuid, catchUpText);
                }
              } else {
                await this.editor.writeToVault(docUuid, catchUpText);
              }
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
    if (!isSyncablePath(docUuid)) {
      warn(`${this.tag} rejected delete for invalid path`, { docUuid });
      return;
    }
    await this.docs.removeAndClean(docUuid);
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

  /**
   * Delete the old path only (used when a rename crosses the syncable-path
   * boundary: syncable → unsyncable). The new path is outside the policy,
   * so nothing is pushed for it.
   */
  onFileDeletedOnly(path: string): void {
    this.push.deleteOnly(path);
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

import { App, TFile, Notice, requestUrl } from 'obsidian';
import { encode, decode } from '@msgpack/msgpack';
import type { VaultCRDTSettings } from './settings';
import { createDocument, type WasmSyncDocument } from './wasm-bridge';
import { DocumentManager } from './document-manager';
import { vvCovers, fnv1aHash64, remoteDeletedPath, hasSharedHistory, conflictPath } from './conflict-utils';
import { PromiseManager } from './promise-manager';
import { SyncRequestBroker, type SyncDeltaResponse } from './sync-broker';
import { EditorIntegration } from './editor-integration';
import { PushHandler } from './push-handler';
import { log, warn, error, redact } from './logger';
import { PROTOCOL_VERSION, jsonOf } from './protocol';
import { isSyncablePath, isExcalidrawPath } from './path-policy';
import { validateServerUrl, toHttpBase, toWsBase } from './url-policy';
import { runInitialSync, type SyncMode } from './sync-initial';
import { SyncTrace } from './sync-trace';
import type { VVCacheEntry } from './state-storage';
import { StartupDirtyTracker } from './startup-dirty-tracker';
import type { InboxSink } from './inbox';
import { FEATURE_BLOBS } from './server-features';
import type { BlobUploader } from './blob-uploader';
import { authRejectedNoticeMessage, protocolMismatchNoticeMessage, conflictNoticeMessage, excalidrawConflictNoticeMessage, tombstoneNoticeMessage, remoteDeleteKeptNoticeMessage, remoteDeleteTrashedNoticeMessage, tombstoneRenamedNoticeMessage } from './user-facing-copy';

export type SyncStatus = 'connected' | 'syncing' | 'offline' | 'error';
export { type SyncMode } from './sync-initial';

// ── Types mirroring ws.rs ────────────────────────────────────────────────────

interface DocEntry {
  doc_uuid: string;
  updated_at: string;
  server_vv: Uint8Array;
}

const HEARTBEAT_MS = 30_000;

/** Bound for the sync_start liveness probe behind a `doc_tombstoned` refusal. */
const TOMBSTONE_LIVENESS_TIMEOUT_MS = 5_000;

/** Text of an untyped protocol field; non-strings never reach user-visible text. */
function fieldText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Tombstone content_hash from a doc_deleted frame. Absent/null on old servers. */
function optionalContentHash(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Max silence from the server before the socket is treated as a zombie.
 * Checked on each heartbeat tick, so a dead connection is force-closed
 * 90–120 s after the last incoming frame. 90 s (not 45 s): the heartbeat
 * setInterval stalls >15 s periodically in the throttled Electron renderer
 * (30 s ticks), which at 45 s killed healthy sockets — pings/pongs were
 * flowing on the wire. The server's 120 s read-idle close is the backstop
 * for truly dead sockets and its closes DO arrive (verified on the wire),
 * so this deadline only needs to sit between renderer-timer jitter and
 * the server backstop.
 */
const ACTIVITY_DEADLINE_MS = 90_000;
const MAX_BACKOFF_MS = 30_000;
const PARALLEL_DOWNLOADS = 5;
/**
 * Bounds for broadcasts queued while initialSync runs (U11). Either limit
 * trips the overflow: the queue is discarded, further broadcasts are dropped
 * for the rest of this initialSync, and ONE extra initialSync pass runs
 * afterwards as the resync (it re-reconciles every doc against the server,
 * so dropped deltas and deletes are recovered without a new protocol path).
 */
const MAX_QUEUED_BROADCASTS = 2_000;
const MAX_QUEUED_BROADCAST_BYTES = 32 * 1024 * 1024;
/** Trailing debounce for blob_path_changed → catchUp (not this.sleep — tests no-op that). */
const BLOB_CATCHUP_DEBOUNCE_MS = 2_000;

// ── SyncEngine ───────────────────────────────────────────────────────────────

export class SyncEngine {
  private docs: DocumentManager;
  private editor: EditorIntegration;
  private push: PushHandler;
  private promises = new PromiseManager();
  private broker = new SyncRequestBroker((docUuid, clientVV) => {
    this.trace.markPath('ws.sync-start', docUuid, {
      hasClientVV: clientVV !== null,
      clientVVLen: clientVV?.length ?? 0,
    });
    const clientVVBytes = clientVV !== null
      ? new TextEncoder().encode(clientVV)
      : null;
    this.send({
      type: 'sync_start',
      doc_uuid: docUuid,
      client_vv: clientVVBytes,
    });
  }, (kind, docUuid) => {
    log(`${this.tag} unsolicited ${kind} (no waiter): ${docUuid}`);
  }, () => this.socketEpoch, (docUuid) => {
    if (this.stopped) return;
    // Retire even with healthy other-key waiters: steady traffic must not
    // postpone the 90s bound. Close may abort the whole parallel server-only
    // download batch (wsAbortError) or serial overlap (overlapAbortError).
    // The existing onclose path owns rejection and reconnect scheduling.
    this.trace.markPath('ws.retire-undrained', docUuid);
    log(`${this.tag} retiring undrained WebSocket: ${docUuid}`);
    this.ws?.close();
  });
  private socketEpoch = 0;
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private authedThisSocket = false;
  private noticedCloseReasons = new Set<string>();
  private writingFromRemote = new Set<string>();
  private deletingFromRemote = new Set<string>();
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private backoffMs = 1_000;
  /** Timestamp of the last message received from the server (any type). */
  private lastServerActivityAt = 0;
  private hasConnected = false;
  private initialSyncRunning = false;
  private oversizedSendNoticed = false;
  private queuedBroadcasts: Record<string, unknown>[] = [];
  private queuedBroadcastBytes = 0;
  /** Set when the queue overflowed during the current initialSync. */
  private broadcastQueueOverflowed = false;
  /** One overflow resync per start(); a second overflow only logs. */
  private overflowResyncUsed = false;
  private overflowNoticed = false;
  /** Paths that received a real editor-change during the current startup. */
  private startupEditedPaths = new Set<string>();
  /** Ignore noisy vault modify/create/rename events until the first initial sync settled. */
  private acceptVaultChangeEvents = false;
  /** Aggregate count of noisy cold-start vault events we deliberately ignored. */
  private suppressedColdStartVaultEvents = { modify: 0, create: 0, rename: 0 };
  /** Stores the server VV (JSON string) per doc after last successful sync. */
  private lastServerVV = new Map<string, string>();
  /** Tracks docs currently doing a VV-gap catch-up to prevent duplicates. */
  private catchUpInProgress = new Set<string>();
  /** fnv1aHash64 of the last remote write per path — suppresses echo pushes (one-shot). */
  private lastRemoteWrite = new Map<string, string>();
  /** Serialized broadcast processing queue — prevents concurrent CRDT mutations. */
  private broadcastQueue: Promise<void> = Promise.resolve();
  /** Shared VV/content-hash cache from vv-cache.json. */
  private vvCache = new Map<string, VVCacheEntry>();
  private vvCacheDirty = false;
  private vvCacheTimer: number | null = null;
  private vvCacheWrite: Promise<void> = Promise.resolve();
  /** Device-local dirty tracker for startup verification. */
  private startupDirty: StartupDirtyTracker;
  /** Set to true after stop() — prevents reconnect after intentional close. */
  private stopped = false;
  /** Engine lifecycle generation; bumped on each start(). Tasks capture it at admission so restart survivors are fenced. */
  private generation = 0;
  /** Pending/completed actions keyed by (docUuid, size, mtime), a SESSION-LOCAL admission heuristic.
   * “mtime never identity” applies to BLOB deletion identity, not this flow. Failures release only their own incarnation. */
  private notifiedTombstones = new Map<string, { size: number; mtime: number }>();
  /** Definitive liveness evidence for the captured incarnation; cleared on start(). */
  private tombstoneLivenessChecked = new Map<string, { size: number; mtime: number }>();
  private trace = new SyncTrace();
  private advertisedFeatures: string[] = [];
  private blobCatchUpTimer: number | null = null;
  /**
   * One-shot admin token sent with the next /auth/verify call to register
   * a new vault. Cleared after the first successful auth. Never persisted.
   */
  private oneShotAdminToken: string | null = null;

  /** Quiet-mode inbox sink (design §E): set by main.ts after construction. */
  inbox: InboxSink | null = null;
  /** Feature probe used to populate the WS auth frame; default is old-server (no features). */
  getServerFeatures: () => Promise<string[]> = async () => [];
  /** Attachment lane; catchUp is scheduled from blob_path_changed. */
  blobUploader: BlobUploader | null = null;
  /** Wall-clock ms of the last completed initial sync (0 = none this session). */
  private lastInitialSyncAt = 0;

  statusCallback: ((s: SyncStatus) => void) | null = null;
  /** Fires on every message received from the server (pong, ack, delta, etc.). */
  onServerActivity: (() => void) | null = null;
  /** Called after auth_ok — main.ts auto-detects sync mode and runs initialSync. */
  onInitialSync: ((engine: SyncEngine) => void) | null = null;

  constructor(
    private app: App,
    private settings: VaultCRDTSettings,
  ) {
    // Startup-Invariante: peerId is guaranteed non-empty by main.ts
    // (loadSettings() generates one before constructing SyncEngine). We pass
    // it through so every CRDT doc commits ops on a stable per-device VV line.
    this.docs = new DocumentManager(app, settings.peerId);
    this.startupDirty = new StartupDirtyTracker(settings.vaultId, settings.peerId);
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
      (event, path, data) => this.trace.markPath(event, path, data),
    );
    this.push.onExcalidrawConcurrent = (path, content) => this.resolveExcalidrawConcurrent(path, content);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.generation++;
    this.tombstoneLivenessChecked.clear();
    this.stopped = false;
    this.startupEditedPaths.clear();
    this.overflowResyncUsed = false;
    this.overflowNoticed = false;
    this.acceptVaultChangeEvents = false;
    this.suppressedColdStartVaultEvents = { modify: 0, create: 0, rename: 0 };
    this.trace.resetStartup({
      vaultId: this.settings.vaultId,
      deviceName: this.settings.deviceName,
      peerId: this.settings.peerId,
    });
    this.trace.mark('start.begin');
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
    this.trace.mark('start.pending-deletes-loaded');

    // Shared cache lives in the vault (`vv-cache.json`); the local dirty set
    // lives device-locally in localStorage so Android does not inherit stale
    // dirty bits from other devices or sync timing.
    this.vvCache = await this.docs.loadVVCache() ?? new Map<string, VVCacheEntry>();
    this.startupDirty.reload();
    this.trace.mark('start.startup-state-loaded', {
      cacheEntries: this.vvCache.size,
      localDirty: this.startupDirty.size(),
    });

    await this.auth();
    this.trace.mark('start.auth-ok');
    await this.connect();
    this.trace.mark('start.connect-called');
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /**
   * Rejects all waiters and broker entries synchronously. Already-running async
   * continuations may still complete their current await. Only the tombstone
   * task is fenced while stopped or retired by a new engine generation.
   * Liveness evidence resets on start; pending/completed actions survive.
   * Other file-writing continuations are NOT fenced:
   * accepted weaker continuation guarantee, design 2026-09-09.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    if (this.blobCatchUpTimer !== null) {
      window.clearTimeout(this.blobCatchUpTimer);
      this.blobCatchUpTimer = null;
    }
    this.push.stopAllTimers();
    this.lastRemoteWrite.clear();
    this.startupEditedPaths.clear();
    this.trace.mark('stop.called');
    this.ws?.close();
    this.ws = null;
    this.promises.rejectAll('Sync engine stopped', this.tag);
    this.broker.rejectAll('Sync engine stopped', this.tag);
    await this.docs.persistAll();
    await this.flushVVCache();
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

  /** Fresh vault JWT for API calls outside the WS lifecycle (e.g. POST /invite
   *  from the invite screen). Reuses a still-valid token when present.
   *  Callers must treat errors (401/expired) as "no invite right now". */
  async getJwt(): Promise<string> {
    if (!this.token) await this.auth();
    return this.token!;
  }

  private async auth(): Promise<void> {
    // S1b: a per-device key (from /invite/redeem) replaces the shared secret.
    // Old servers never issue one, so the /auth/verify path stays the default.
    if (this.settings.deviceKey) {
      try {
        const resp = await requestUrl({
          url: `${this.httpBase()}/auth/device`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vault_id: this.settings.vaultId,
            peer_id: this.settings.peerId,
            device_key: this.settings.deviceKey,
          }),
        });
        this.token = jsonOf<{ token: string }>(resp).token ?? '';
      } catch (e: unknown) {
        if ((e as { status?: number })?.status === 401) {
          this.noticeOnce('auth_invalid', authRejectedNoticeMessage());
        }
        throw e;
      }
      return;
    }
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
    this.token = jsonOf<{ token: string }>(resp).token ?? '';
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
    this.startupEditedPaths.clear();
    this.vvCache.clear();
    this.startupDirty.clearAll();
    this.notifiedTombstones.clear();
    this.tombstoneLivenessChecked.clear();
  }

  /**
   * Device-identity reset (vault-clone hygiene): drop this device's
   * peer-keyed startup-dirty localStorage entry so the orphaned old-peer key
   * does not linger after a fresh peerId is minted. The `.loro` snapshots and
   * the path-keyed vv-cache are deliberately KEPT — their content is valid;
   * only the causal identity for FUTURE commits changes (Loro carries several
   * peer lines in one doc). Because DocumentManager and StartupDirtyTracker
   * capture peerId at construction (see constructor), the caller must REBUILD
   * the engine after minting the new id — a plain restart() would keep
   * committing on the old peer line.
   */
  clearStartupDirtyForIdentityReset(): void {
    this.startupDirty.clearAll();
  }

  private wsUrl(): string {
    return toWsBase(this.settings.serverUrl) + '/ws';
  }

  private async connect(): Promise<void> {
    this.advertisedFeatures = await this.getServerFeatures();
    if (this.stopped) return;
    const device = encodeURIComponent(this.settings.deviceName || 'unknown');
    const peerId = encodeURIComponent(this.settings.peerId || '');
    const url = `${this.wsUrl()}?vault_id=${encodeURIComponent(this.settings.vaultId)}&device=${device}&peer_id=${peerId}`;
    const ws = new WebSocket(url);
    this.socketEpoch++;
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.trace.mark('ws.open');
      this.authedThisSocket = false;
      const frame: Record<string, unknown> = {
        type: 'auth',
        token: this.token ?? '',
        protocol_version: PROTOCOL_VERSION,
      };
      if (this.advertisedFeatures.includes(FEATURE_BLOBS)) {
        frame.features = ['blobs'];
      }
      this.send(frame);
    };

    ws.onmessage = (ev: MessageEvent) => {
      this.onMessage(ev.data as ArrayBuffer);
    };

    ws.onclose = (ev: CloseEvent) => {
      // Ignore stale close from a socket that restart() already replaced.
      if (this.ws !== ws) return;
      if (!this.authedThisSocket) {
        this.trace.mark('ws.close-before-auth', { code: ev.code, reason: redact(redact(ev.reason ?? '', this.token ?? '')) });
        this.setStatus('error');
        if (ev.reason === 'auth_invalid' || ev.reason === 'auth_required' || ev.reason === 'auth_timeout') {
          this.noticeOnce(ev.reason, authRejectedNoticeMessage());
        }
      }
      void this.flushVVCache().catch((err) => error(`${this.tag} vv-cache flush failed:`, err));
      this.trace.mark('ws.close');
      this.setStatus('offline');
      this.stopHeartbeat();
      this.promises.rejectAll('WebSocket closed', this.tag);
      this.broker.rejectAll('WebSocket closed', this.tag);
      if (!this.stopped) this.scheduleReconnect();
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.trace.mark('ws.error');
      this.setStatus('error');
    };
  }

  private noticeOnce(key: string, text: string): void {
    if (this.noticedCloseReasons.has(key)) return;
    this.noticedCloseReasons.add(key);
    new Notice(redact(text), 12000);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => {
      void this.auth()
        .then(() => this.connect())
        .catch(() => this.scheduleReconnect());
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private scheduleBlobCatchUp(): void {
    if (this.blobCatchUpTimer !== null) window.clearTimeout(this.blobCatchUpTimer);
    this.blobCatchUpTimer = window.setTimeout(() => {
      this.blobCatchUpTimer = null;
      if (this.stopped) return;
      const uploader = this.blobUploader;
      if (!uploader) return;
      void uploader.catchUp().catch((err) => error(`${this.tag} blob catch-up failed:`, err));
    }, BLOB_CATCHUP_DEBOUNCE_MS);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastServerActivityAt = Date.now();
    this.heartbeatTimer = window.setInterval(() => {
      const silentMs = Date.now() - this.lastServerActivityAt;
      if (silentMs >= ACTIVITY_DEADLINE_MS) {
        // Zombie socket: our pings go out but nothing comes back. Force the
        // close so onclose runs the normal reconnect/initialSync healing path.
        this.trace.mark('ws.activity-deadline', { silentMs });
        error(`${this.tag} no server activity for ${silentMs}ms — closing zombie socket`);
        this.ws?.close();
        return;
      }
      this.send({ type: 'ping' });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Initial sync ───────────────────────────────────────────────────────────

  async initialSync(onProgress?: (done: number, total: number, changed: number) => void, mode: SyncMode = 'merge'): Promise<void> {
    if (this.initialSyncRunning) {
      log(`${this.tag} initialSync already running — skipping re-entry`);
      return;
    }
    this.trace.mark('initial-sync.begin', { mode });
    this.setStatus('syncing');
    this.initialSyncRunning = true;
    this.queuedBroadcasts = [];
    this.queuedBroadcastBytes = 0;
    this.broadcastQueueOverflowed = false;

    let succeeded = false;
    try {
      await runInitialSync(
        {
          app: this.app,
          docs: this.docs,
          editor: this.editor,
          push: this.push,
          lastServerVV: this.lastServerVV,
          lastRemoteWrite: this.lastRemoteWrite,
          deletingFromRemote: this.deletingFromRemote,
          tag: this.tag,
          peerId: this.settings.peerId,
          ws: this.ws,
          send: (msg) => this.send(msg),
          requestDocList: () => this.requestDocList(),
          requestSyncStart: (uuid, vv) => this.requestSyncStart(uuid, vv),
          cachedVVs: new Map(this.vvCache),
          saveVVCache: (map) => this.replaceVVCache(map),
          dirtyPaths: this.startupDirty.snapshot(),
          saveDirtyPaths: (paths) => this.replaceDirtyPaths(paths),
          trace: (event, data) => this.trace.mark(event, data),
          tracePath: (event, path, data) => this.trace.markPath(event, path, data),
          observePath: (path) => this.trace.observePath(path),
          wasEditedDuringStartup: (path) => this.startupEditedPaths.has(path),
          hasUnackedEdit: (path) => this.push.hasUnackedEdit(path),
          hasPendingEdits: (path) => this.push.hasPendingEdits(path),
          inbox: this.inbox,
        },
        onProgress,
        mode,
      );
      succeeded = true;
    } finally {
      this.initialSyncRunning = false;

      if (!succeeded) {
        this.trace.mark('initial-sync.queue-discard', { queued: this.queuedBroadcasts.length });
        this.queuedBroadcasts = [];
        this.startupEditedPaths.clear();
        // Keep acceptVaultChangeEvents=false; surface error status (not connected).
        this.setStatus('error');
        this.trace.mark('initial-sync.end', { ok: false });
      } else {
        this.trace.mark('initial-sync.queue-flush', { queued: this.queuedBroadcasts.length });

        if (!this.broadcastQueueOverflowed) {
          for (const queued of this.queuedBroadcasts) {
            const type = queued.type as string;
            if (type === 'delta_broadcast') {
              await this.onDeltaBroadcast(queued);
            } else if (type === 'doc_deleted') {
              await this.onDocDeleted(
                queued.doc_uuid as string,
                optionalContentHash(queued.content_hash),
              );
            } else if (type === 'create_conflict') {
              await this.resolveDisjointHistory(queued.doc_uuid as string, 'create_conflict');
            }
          }
        }
        this.queuedBroadcasts = [];

        // Initial-sync end reconciled server truth — anything still unacked
        // is superseded, so the sent-unacked guard must not persist past it.
        this.push.clearSentUnacked();
        this.lastInitialSyncAt = Date.now();

        this.trace.mark('initial-sync.end', { ok: true });
        if (
          this.suppressedColdStartVaultEvents.modify > 0 ||
          this.suppressedColdStartVaultEvents.create > 0 ||
          this.suppressedColdStartVaultEvents.rename > 0
        ) {
          this.trace.mark('startup.vault-events-suppressed', {
            ...this.suppressedColdStartVaultEvents,
          });
        }
        this.startupEditedPaths.clear();
        this.acceptVaultChangeEvents = true;
        this.setStatus('connected');
        if (this.broadcastQueueOverflowed) {
          if (this.overflowResyncUsed) {
            warn(`${this.tag} broadcast queue overflowed again — no further automatic resync; live VV-gap catch-up covers docs with new broadcasts`);
          } else {
            this.overflowResyncUsed = true;
            if (!this.overflowNoticed) {
              this.overflowNoticed = true;
              // Quiet mode (design §E): log-only — the second pass is automatic.
              log(`${this.tag} many changes arrived during startup sync — running a second sync pass`);
            }
            this.trace.mark('initial-sync.overflow-resync');
            void this.initialSync(onProgress, mode).catch((err) =>
              error(`${this.tag} overflow resync failed:`, err),
            );
          }
        }
      }
    }
  }

  // ── Message handling ────────────────────────────────────────────────────────

  private onMessage(data: ArrayBuffer): void {
    // A malformed/undecodable frame must not throw out of ws.onmessage.
    // There is no documented recovery for an unparseable frame: warn with the
    // byte length, change no state, drop it. Scope: this entry point only —
    // the TextDecoder sites keep their richer semantics (rejecting waiters).
    let msg: Record<string, unknown>;
    let type: string;
    try {
      const decoded: unknown = decode(new Uint8Array(data));
      if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
        throw new Error('frame is not an object');
      }
      msg = decoded as Record<string, unknown>;
      if (typeof msg.type !== 'string') throw new Error('frame has no string type');
      type = msg.type;
    } catch (err) {
      warn(`${this.tag} dropping undecodable frame (${data.byteLength} bytes):`, err);
      return;
    }
    this.lastServerActivityAt = Date.now();
    this.onServerActivity?.();

    switch (type) {
      case 'auth_ok':
        this.authedThisSocket = true;
        this.trace.mark('ws.auth-ok', { protocolVersion: msg.protocol_version });
        this.backoffMs = 1_000;
        this.startHeartbeat();
        this.hasConnected = true;
        this.noticedCloseReasons.clear();
        if (this.onInitialSync) {
          this.onInitialSync(this);
        } else {
          this.initialSync().catch((err) =>
            error(`${this.tag} initialSync error:`, err)
          );
        }
        break;

      case 'doc_list':
        this.promises.resolve('doc_list', {
          docs: msg.docs as DocEntry[],
          tombstones: msg.tombstones as string[],
          tombstone_hashes: Array.isArray(msg.tombstone_hashes)
            ? msg.tombstone_hashes as Array<{ doc_uuid: string; content_hash: string | null }>
            : undefined,
        });
        break;

      case 'sync_delta': {
        const docUuid = typeof msg.doc_uuid === 'string' ? msg.doc_uuid : null;
        try {
          if (!docUuid) {
            warn(`${this.tag} sync_delta missing doc_uuid`);
            break;
          }
          const delta = msg.delta;
          const serverVv = msg.server_vv;
          if (!(delta instanceof Uint8Array) || !(serverVv instanceof Uint8Array)) {
            this.broker.fail(
              docUuid,
              new Error('malformed sync_delta frame'),
            );
            break;
          }
          this.trace.markPath('ws.sync-delta', docUuid, {
            deltaLen: delta.length,
          });
          // Per-key positional correlation relies on server ws.rs Task-2's
          // single-flight read loop: await handler, enqueue response, then read.
          // Responses retain request order; unsolicited delta_broadcast,
          // doc_deleted and blob_path_changed may interleave before a response.
          // Push cases never consume waiter slots (late timed-out owners do).
          // Request ids are deferred to protocol v1.1.
          if (!this.broker.deliver(docUuid, 'sync_delta', {
            delta,
            serverVV: new TextDecoder().decode(serverVv),
          })) {
            log(`${this.tag} unsolicited sync_delta (no waiter): ${docUuid}`);
          }
        } catch (err) {
          warn(`${this.tag} sync_delta handler error:`, err);
          if (docUuid) {
            this.broker.fail(
              docUuid,
              err instanceof Error ? err : new Error(String(err)),
            );
          }
        }
        break;
      }

      case 'doc_unknown':
        if (!this.broker.deliver(msg.doc_uuid as string, 'doc_unknown', null)) {
          log(`${this.tag} unsolicited doc_unknown (no waiter): ${msg.doc_uuid as string}`);
        }
        break;

      case 'delta_broadcast':
        if (this.initialSyncRunning) {
          this.trace.markPath('ws.broadcast-queued', msg.doc_uuid as string, {
            queueSizeBefore: this.queuedBroadcasts.length,
            deltaLen: (msg.delta as Uint8Array).length,
          });
          log(`${this.tag} broadcast queued (initialSync running)`, { doc: msg.doc_uuid });
          this.queueBroadcast(msg);
        } else {
          this.trace.markPath('ws.broadcast-live', msg.doc_uuid as string, {
            deltaLen: (msg.delta as Uint8Array).length,
          });
          this.enqueueBroadcast(msg);
        }
        break;

      case 'doc_deleted':
        if (this.initialSyncRunning) {
          log(`${this.tag} delete queued (initialSync running)`, { doc: msg.doc_uuid });
          this.queueBroadcast(msg);
        } else {
          void this.onDocDeleted(
            msg.doc_uuid as string,
            optionalContentHash(msg.content_hash),
          );
        }
        break;

      case 'doc_tombstoned':
        void this.handleDocTombstoned(msg.doc_uuid);
        break;

      case 'create_conflict':
        if (typeof msg.doc_uuid !== 'string' || !isSyncablePath(msg.doc_uuid)) {
          warn(`${this.tag} rejected create_conflict for invalid path`, { docUuid: msg.doc_uuid });
          break;
        }
        if (this.initialSyncRunning) this.queueBroadcast(msg);
        else void this.resolveDisjointHistory(msg.doc_uuid, 'create_conflict');
        break;

      case 'ack':
        this.setStatus('connected');
        break;

      case 'pong':
        break;

      case 'blob_path_changed':
        this.scheduleBlobCatchUp();
        break;

      case 'error':
        warn(`${this.tag} Server error:`, redact(fieldText(msg.code), this.token ?? ''), redact(fieldText(msg.message), this.token ?? ''));
        if (msg.code === 'protocol_version_mismatch') {
          const m = /server=(\d+)/.exec(fieldText(msg.message));
          this.noticeOnce('protocol_version_mismatch', protocolMismatchNoticeMessage(m ? Number(m[1]) : 0, PROTOCOL_VERSION));
        }
        // If the error names a doc, unblock the waiting sync_delta promise
        // instead of letting it stall until the 60s timeout.
        if (typeof msg.doc_uuid === 'string' && msg.doc_uuid.length > 0) {
          this.broker.fail(
            msg.doc_uuid,
            new Error(redact(redact(fieldText(msg.message) || 'server error', this.token ?? ''))),
          );
        }
        break;
    }
  }

  private queueBroadcast(msg: Record<string, unknown>): void {
    if (this.broadcastQueueOverflowed) return; // dropping until the resync pass
    const cost = msg.type === 'delta_broadcast' ? (msg.delta as Uint8Array).byteLength : 0;
    if (
      this.queuedBroadcasts.length >= MAX_QUEUED_BROADCASTS ||
      this.queuedBroadcastBytes + cost > MAX_QUEUED_BROADCAST_BYTES
    ) {
      this.broadcastQueueOverflowed = true;
      this.trace.mark('ws.broadcast-overflow', {
        queued: this.queuedBroadcasts.length,
        bytes: this.queuedBroadcastBytes,
      });
      error(`${this.tag} broadcast queue overflow during initialSync — discarding queue, resync pass follows`, {
        queued: this.queuedBroadcasts.length, bytes: this.queuedBroadcastBytes,
      });
      this.queuedBroadcasts = [];
      this.queuedBroadcastBytes = 0;
      return;
    }
    this.queuedBroadcasts.push(msg);
    this.queuedBroadcastBytes += cost;
  }

  private enqueueBroadcast(msg: Record<string, unknown>): void {
    this.broadcastQueue = this.broadcastQueue.then(() =>
      this.onDeltaBroadcast(msg).catch((err: unknown) => {
        error(`${this.tag} broadcast handler FAILED`, { doc: msg.doc_uuid, err });
      })
    );
  }

  private async onDeltaBroadcast(msg: Record<string, unknown>): Promise<void> {
    const docUuid = msg.doc_uuid as string;
    this.trace.markPath('broadcast.begin', docUuid, {
      deltaLen: (msg.delta as Uint8Array).length,
      initialSyncRunning: this.initialSyncRunning,
    });
    if (!isSyncablePath(docUuid)) {
      warn(`${this.tag} rejected broadcast for invalid path`, { docUuid });
      return;
    }
    const delta = msg.delta as Uint8Array;

    const doc = await this.docs.getOrLoad(docUuid);
    const localVV = doc.export_vv_json();
    const incomingRaw = msg.server_vv;
    const incomingServerVV = incomingRaw instanceof Uint8Array && incomingRaw.length > 0
      ? new TextDecoder().decode(incomingRaw)
      : null;
    if (localVV !== '{}') {
      if (incomingServerVV === null || !hasSharedHistory(localVV, incomingServerVV)) {
        this.trace.markPath('broadcast.disjoint-history', docUuid);
        warn(`${this.tag} broadcast has disjoint or unknown history`, { docUuid });
        await this.resolveDisjointHistory(docUuid, 'broadcast');
        return;
      }
    }

    if (
      isExcalidrawPath(docUuid) &&
      incomingServerVV !== null &&
      !vvCovers(localVV, incomingServerVV)
    ) {
      let localText = this.editor.readCurrentContent(docUuid);
      if (localText === null) {
        const file = this.app.vault.getAbstractFileByPath(docUuid);
        localText = file instanceof TFile ? await this.app.vault.read(file) : doc.get_text();
      }
      const localExtras =
        this.push.hasPendingEdits(docUuid) ||
        localText !== doc.get_text() ||
        !vvCovers(incomingServerVV, localVV);
      if (localExtras) {
        this.trace.markPath('broadcast.excalidraw-concurrent', docUuid);
        await this.resolveExcalidrawConcurrent(docUuid, localText);
        return;
      }
    }

    if (incomingServerVV !== null) this.lastServerVV.set(docUuid, incomingServerVV);
    if (await this.push.flushPendingEdits(docUuid)) {
      this.trace.markPath('broadcast.excalidraw-concurrent-flush', docUuid);
      return;
    }
    this.trace.markPath('broadcast.after-flush', docUuid);

    const textBefore = doc.get_text();

    // Security review finding #1: an edit made while Obsidian was CLOSED
    // produces no vault event, so nothing marks the doc dirty and the
    // startup clean-skip never reads the disk. Discriminate with the
    // PRE-import text only:
    //   disk == text we are writing      → nothing to do (writeToVault skips)
    //   disk == textBefore               → ordinary update, we know that state
    //   disk differs from BOTH           → an edit we never saw → conflict copy
    // Difference to initial sync (writeServerText): NO blank/whitespace
    // exclusion here — a whitespace-only external edit is user data too, and
    // unlike cold start we have a trustworthy pre-import baseline.
    const preserveUnseenDiskText = async (path: string, diskText: string): Promise<boolean> => {
      if (diskText === textBefore) return false;
      const cPath = conflictPath(this.app, path);
      warn(`${this.tag} broadcast overwrite refused — unseen local disk change`, {
        path, conflictPath: cPath,
      });
      this.trace.markPath('broadcast.unseen-disk-conflict', path, {
        diskLen: diskText.length, conflictPath: cPath,
      });
      await this.app.vault.create(cPath, diskText);
      this.inbox?.add({
        kind: 'conflict', path: cPath, relatedPath: path,
        note: conflictNoticeMessage(cPath),
      });
      return true;
    };
    const preserveOpts = { preserveUnseenDiskText };

    let diffJson: string | null = null;
    try {
      diffJson = doc.import_and_diff(delta);
    } catch (err) {
      this.trace.markPath('broadcast.import-and-diff-error', docUuid, {
        message: err instanceof Error ? err.message : String(err),
      });
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
      deltaLen: (delta).length,
    });

    if (Math.abs(textAfter.length - textBefore.length) > Math.max(textBefore.length, 1) * 0.5) {
      warn(`${this.tag} large merge delta`, {
        path: docUuid, beforeLen: textBefore.length, afterLen: textAfter.length,
      });
    }

    // VV gap detection
    const serverVVRaw = msg.server_vv as Uint8Array | undefined;
    const serverVVStr = serverVVRaw && serverVVRaw.length > 0
      ? new TextDecoder().decode(serverVVRaw) : null;
    if (serverVVStr !== null) {
      const localVVStr = doc.export_vv_json();

      if (!vvCovers(localVVStr, serverVVStr)) {
        this.trace.markPath('broadcast.vv-gap', docUuid);
        warn(`${this.tag} VV gap detected after broadcast`, { docUuid, localVV: localVVStr, serverVV: serverVVStr });

        if (!this.catchUpInProgress.has(docUuid)) {
          this.catchUpInProgress.add(docUuid);
          try {
            if (await this.push.flushPendingEdits(docUuid)) return;
            const result = await this.requestSyncStart(docUuid, localVVStr);
            if (result && result.delta.length > 0) {
              // Use surgical diff for active editor doc to preserve typing
              const isActive = this.editor.getActiveEditorPath() === docUuid;
              let catchUpDiffJson: string | null = null;
              if (isActive) {
                try {
                  catchUpDiffJson = doc.import_and_diff(result.delta);
                } catch {
                  doc.import_snapshot(result.delta);
                }
              } else {
                doc.import_snapshot(result.delta);
              }
              const catchUpText = doc.get_text();
              if (isActive && catchUpDiffJson) {
                if (this.editor.applyDiffToEditor(docUuid, catchUpDiffJson, catchUpText, true)) {
                  this.trace.markPath('broadcast.catch-up-apply-diff', docUuid, { textLen: catchUpText.length });
                  const postContent = this.editor.readCurrentContent(docUuid);
                  if (postContent !== null && !doc.text_matches(postContent)) {
                    doc.sync_from_disk(postContent);
                  }
                  this.lastRemoteWrite.set(docUuid, fnv1aHash64(postContent ?? catchUpText));
                } else {
                  this.trace.markPath('broadcast.catch-up-write-to-vault', docUuid, { textLen: catchUpText.length });
                  await this.editor.writeToVault(docUuid, catchUpText, preserveOpts);
                }
              } else {
                this.trace.markPath('broadcast.catch-up-write-to-vault', docUuid, { textLen: catchUpText.length });
                await this.editor.writeToVault(docUuid, catchUpText, preserveOpts);
              }
            }
            if (result) {
              this.lastServerVV.set(docUuid, result.serverVV);
              this.rememberVVCache(docUuid, result.serverVV, doc.get_text());
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

    // Try surgical editor update via diff; fall back to full writeToVault.
    // skipFallback: a verification mismatch means concurrent local typing —
    // never rewrite the editor from CRDT state on this path (tail loss).
    let appliedDiff = false;
    try {
      appliedDiff = diffJson
        ? this.editor.applyDiffToEditor(docUuid, diffJson, doc.get_text(), true)
        : false;
      if (appliedDiff) {
        this.trace.markPath('broadcast.apply-diff', docUuid, { textLen: doc.get_text().length });
      }
    } catch (err) {
      this.trace.markPath('broadcast.apply-diff-error', docUuid, {
        message: err instanceof Error ? err.message : String(err),
      });
      warn(`${this.tag} applyDiffToEditor failed, falling back to writeToVault`, { docUuid, err });
    }

    if (appliedDiff) {
      // Fold local keystrokes typed during the async apply back into the
      // CRDT and push them (flushPendingEdits pushes with peer_id and
      // sentUnacked tracking; with no timer armed it still folds — see its
      // own change). This mirrors the catch-up branch but guarantees the
      // tail reaches the server, which the catch-up branch can defer to
      // the full push after initial sync.
      // Bind the server VV to the post-import/apply text, not the post-fold
      // text: a fold can add local ops the server has not confirmed.
      const preFoldText = doc.get_text();
      try {
        if (await this.push.flushPendingEdits(docUuid)) return;
      } catch (err) {
        this.trace.markPath('broadcast.fold-error', docUuid, {
          message: err instanceof Error ? err.message : String(err),
        });
        warn(`${this.tag} post-apply fold failed`, { docUuid, err });
      }
      const postContent = this.editor.readCurrentContent(docUuid);
      this.lastRemoteWrite.set(docUuid, fnv1aHash64(postContent ?? doc.get_text()));
      await this.docs.persist(docUuid);
      if (serverVVStr !== null) this.rememberVVCache(docUuid, serverVVStr, preFoldText);
      return;
    }

    this.trace.markPath('broadcast.write-to-vault', docUuid, { textLen: textAfter.length });
    await this.editor.writeToVault(docUuid, textAfter, preserveOpts);
    await this.docs.persist(docUuid);
    if (serverVVStr !== null) this.rememberVVCache(docUuid, serverVVStr, doc.get_text());
  }

  /** True when the task's captured generation is retired: engine stopped, or a newer start() bumped the generation. */
  private fenced(gen: number): boolean {
    return this.stopped || gen !== this.generation;
  }

  private tombstoneIdentity(docUuid: string): { size: number; mtime: number } {
    const file = this.app.vault.getAbstractFileByPath(docUuid);
    return file instanceof TFile
      ? { size: file.stat.size, mtime: file.stat.mtime }
      : { size: -1, mtime: -1 };
  }

  private sameTombstoneIdentity(
    a: { size: number; mtime: number } | undefined,
    b: { size: number; mtime: number },
  ): boolean {
    return a?.size === b.size && a?.mtime === b.mtime;
  }

  /**
   * Server refused a push because the document is tombstoned (deleted on
   * another device). The previous behaviour was a silent warn-log, which
   * meant the user could keep typing into a doomed file with no feedback.
   * Show a clear Notice (deduped by pending/completed incarnation action) so the user
   * notices the situation and can recover the content manually.
   * If the file still exists locally it is renamed to `(deleted-remote)` so the content lives on as a new synced note.
   */
  private async handleDocTombstoned(docUuid: unknown): Promise<void> {
    const gen = this.generation;
    // Admission check at the handler boundary. A refusal names a path,
    // and every effect below (lookup, liveness probe, document load, recovery
    // send, rename, Notice, inbox entry) acts on it. Non-note or excluded
    // paths must produce no effect at all — reject before anything happens.
    if (typeof docUuid !== 'string' || !isSyncablePath(docUuid)) {
      warn(`${this.tag} rejected doc_tombstoned for invalid path`);
      return;
    }
    warn(`${this.tag} doc is tombstoned on server — push refused`, { doc: docUuid });
    const identity = this.tombstoneIdentity(docUuid);
    if (this.sameTombstoneIdentity(this.notifiedTombstones.get(docUuid), identity)) return;
    const stale = await this.tombstoneRefusalIsStale(docUuid, gen, identity);
    // Socket retirement preserves the decision; engine restart fences survivors.
    // Liveness evidence belongs only to the current session.
    if (this.fenced(gen)) {
      warn(`${this.tag} tombstone task fenced while stopped`, { doc: docUuid });
      this.trace.markPath('tombstoned.fence-stopped', docUuid);
      return;
    }
    if (!this.sameTombstoneIdentity(this.tombstoneIdentity(docUuid), identity)) {
      return this.handleDocTombstoned(docUuid);
    }
    if (stale) return;
    // (docUuid, size, mtime) is a SESSION-LOCAL admission heuristic, not BLOB
    // deletion identity: that separate flow retains the “mtime never identity” invariant.
    if (this.sameTombstoneIdentity(this.notifiedTombstones.get(docUuid), identity)) return;
    this.notifiedTombstones.set(docUuid, identity);
    const f = this.app.vault.getAbstractFileByPath(docUuid);
    if (!(f instanceof TFile)) {
      this.noteTombstoneEditLost(docUuid);
      return;
    }
    const keptPath = remoteDeletedPath(this.app, docUuid);
    // Defense in depth: the destination is derived, so validate it under the
    // same note policy immediately before the native rename is initiated.
    if (!isSyncablePath(keptPath)) {
      warn(`${this.tag} refusing tombstone rename to non-syncable destination`, { doc: docUuid });
      this.noteTombstoneEditLost(docUuid);
      return;
    }
    try {
      // Defensive call-site fence: no await since the earlier check or before rename.
      // Generation also fences engine-restart survivors.
      if (this.fenced(gen)) {
        warn(`${this.tag} tombstone rename fenced while stopped`, { doc: docUuid });
        this.trace.markPath('tombstoned.fence-stopped', docUuid);
        return;
      }
      const current = this.app.vault.getAbstractFileByPath(docUuid);
      if (!(current instanceof TFile) || !this.sameTombstoneIdentity(current.stat, identity)) {
        return this.handleDocTombstoned(docUuid);
      }
      await this.app.fileManager.renameFile(current, keptPath);
    } catch (err) {
      if (this.sameTombstoneIdentity(this.notifiedTombstones.get(docUuid), identity)) {
        this.notifiedTombstones.delete(docUuid);
      }
      warn(`${this.tag} rename of tombstoned file failed`, { doc: docUuid, keptPath, err });
      if (this.fenced(gen)) {
        this.trace.markPath('tombstoned.fence-stopped', docUuid);
        return;
      }
      this.noteTombstoneEditLost(docUuid);
      return;
    }
    if (this.fenced(gen)) {
      this.trace.markPath('tombstoned.fence-stopped', docUuid);
      return;
    }
    try {
      this.trace.markPath('tombstoned.renamed', docUuid, { keptPath });
      this.inbox?.add({
        kind: 'tombstone-rename', path: keptPath, relatedPath: docUuid,
        note: tombstoneRenamedNoticeMessage(docUuid, keptPath),
      });
    } catch (err) {
      // Bookkeeping after a successful rename must not release the dedup
      // entry (the action completed) and must not propagate (void caller).
      warn(`${this.tag} tombstone rename bookkeeping failed`, { doc: docUuid, keptPath, err });
    }
  }

  /**
   * A `doc_tombstoned` refusal can be stale: an older server answers from the
   * tombstone row even though a live documents row for the same path exists
   * (delete + re-create while reconnects happened in between). Ask the server
   * for the doc's current state over the existing sync_start request before
   * destroying the local file's identity. A live snapshot ⇒ keep the file and
   * re-send the change as doc_create with replace semantics.
   * Definitive negative evidence is reused only for the same incarnation this session.
   */
  private async tombstoneRefusalIsStale(
    docUuid: string, gen: number, identity: { size: number; mtime: number },
  ): Promise<boolean> {
    if (this.sameTombstoneIdentity(this.tombstoneLivenessChecked.get(docUuid), identity)) return false;
    const f = this.app.vault.getAbstractFileByPath(docUuid);
    if (!(f instanceof TFile)) return false;
    let live: { delta: Uint8Array; serverVV: string } | null;
    try {
      live = await this.probeServerDoc(docUuid);
    } catch (err) {
      // A failed or timed-out probe is NOT a delete confirmation: defer the
      // rename and leave the file as-is. The liveness map is only marked on
      // definitive answers, so the next refusal may probe again.
      warn(`${this.tag} tombstone liveness probe failed — deferring rename`, { doc: docUuid, err });
      this.trace.markPath('tombstoned.liveness-unknown', docUuid);
      return true;
    }
    if (this.fenced(gen)) {
      this.trace.markPath('tombstoned.fence-stopped', docUuid);
      return true;
    }
    if (!this.sameTombstoneIdentity(this.tombstoneIdentity(docUuid), identity)) return true;
    if (live === null || live.delta.length === 0) {
      // Definitive no-live-row answer: this (and only this) consumes the
      // once-per-session slot — after the rename, notifiedTombstones dedups.
      this.tombstoneLivenessChecked.set(docUuid, identity);
      this.trace.markPath('tombstoned.liveness-confirmed', docUuid);
      return false;
    }
    // Stale refusal (server still has the live doc): do NOT consume the slot.
    // If the recovery doc_create below is lost (e.g. socket death), the next
    // refusal must re-probe instead of renaming without a definitive answer.
    this.trace.markPath('tombstoned.stale-refusal', docUuid);
    warn(`${this.tag} tombstone refusal is stale — server still has a live doc`, { doc: docUuid });
    try {
      // Already-issued loads may publish persisted state after retirement into
      // empty/invalidated slots or serve later cache callers (pre-existing load
      // invalidation race). Prevent new retired loads and continuation effects;
      // DocumentManager publication cancellation is outside this slice.
      if (this.fenced(gen)) {
        this.trace.markPath('tombstoned.fence-stopped', docUuid);
        return true;
      }
      const doc = await this.docs.getOrLoad(docUuid);
      if (this.fenced(gen)) {
        this.trace.markPath('tombstoned.fence-stopped', docUuid);
        return true;
      }
      if (!this.sameTombstoneIdentity(this.tombstoneIdentity(docUuid), identity)) return true;
      const current = this.editor.readCurrentContent(docUuid);
      if (current !== null && !doc.text_matches(current)) doc.sync_from_disk(current);
      // No await between check and push; restart survivors are generation-fenced.
      if (this.fenced(gen)) {
        warn(`${this.tag} tombstone recovery fenced while stopped`, { doc: docUuid });
        this.trace.markPath('tombstoned.fence-stopped', docUuid);
        return true;
      }
      this.push.pushDocCreate(docUuid, doc, { replaceTombstone: true });
      await this.docs.persist(docUuid);
    } catch (err) {
      warn(`${this.tag} re-send after stale tombstone failed`, { doc: docUuid, err });
    }
    return true;
  }

  /** sync_start probe with a bounded wait so a silent server cannot stall the refusal path. */
  private probeServerDoc(docUuid: string): Promise<SyncDeltaResponse> {
    const request = this.requestSyncStart(docUuid, null);
    let timer = 0;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = window.setTimeout(
        () => { reject(new Error('tombstone liveness probe timeout')); },
        TOMBSTONE_LIVENESS_TIMEOUT_MS,
      );
    });
    request.catch(() => { /* settled below or already reported */ });
    return Promise.race([request, timeout]).finally(() => { window.clearTimeout(timer); });
  }

  /** Lost edit on a tombstoned doc: inbox entry + one short notice (design §E). */
  private noteTombstoneEditLost(docUuid: string): void {
    const text = tombstoneNoticeMessage(docUuid);
    this.inbox?.add({ kind: 'tombstone-edit', path: docUuid, note: text });
    new Notice(redact(text), 8000);
  }

  /**
   * Concurrent excalidraw: keep the local drawing as a conflict copy, drop
   * pending edits, and adopt the remote snapshot as the main line. Do not
   * push the local edit into the CRDT. Always write the remote text to the
   * working file so a later FileWatcher scan cannot re-ingest it as a local change.
   */
  private async resolveExcalidrawConcurrent(path: string, localContent: string): Promise<boolean> {
    if (this.catchUpInProgress.has(path)) {
      log(`${this.tag} excalidraw conflict already in progress`, { path });
      return true;
    }
    this.catchUpInProgress.add(path);
    try {
      this.push.cancelPendingEdits(path);
      const result = await this.requestSyncStart(path, null);
      if (result === null || result.delta.length === 0) {
        warn(`${this.tag} excalidraw concurrent adopt has no server snapshot`, { path });
        this.trace.markPath('excalidraw.no-snapshot', path);
        return true;
      }
      const tempDoc = createDocument('__probe__', '__probe__');
      tempDoc.import_snapshot(result.delta);
      const serverText = tempDoc.get_text();
      const textsDiffer = serverText !== localContent;
      if (textsDiffer && localContent.trim() !== '') {
        const cPath = conflictPath(this.app, path);
        await this.app.vault.create(cPath, localContent);
        this.inbox?.add({
          kind: 'conflict', path: cPath, relatedPath: path,
          note: excalidrawConflictNoticeMessage(cPath),
        });
        warn(`${this.tag} excalidraw concurrent conflict`, { path, conflictPath: cPath });
        this.trace.markPath('excalidraw.conflict', path, { conflictPath: cPath });
      } else {
        log(`${this.tag} excalidraw concurrent adopt (blank or identical local)`, { path });
      }
      await this.docs.removeAndClean(path);
      const freshDoc = await this.docs.getOrLoad(path);
      freshDoc.import_snapshot(result.delta);
      this.lastServerVV.set(path, result.serverVV);
      await this.editor.writeToVault(path, serverText);
      await this.docs.persist(path);
      this.rememberVVCache(path, result.serverVV, freshDoc.get_text());
      return true;
    } finally {
      this.catchUpInProgress.delete(path);
    }
  }

  private async resolveDisjointHistory(docUuid: string, reason: 'create_conflict' | 'broadcast'): Promise<void> {
    if (this.catchUpInProgress.has(docUuid)) {
      log(`${this.tag} disjoint resolution already in progress`, { docUuid, reason });
      return;
    }
    this.catchUpInProgress.add(docUuid);
    try {
      this.push.cancelPendingEdits(docUuid);
      let localText = this.editor.readCurrentContent(docUuid);
      if (localText === null) {
        const file = this.app.vault.getAbstractFileByPath(docUuid);
        localText = file instanceof TFile ? await this.app.vault.read(file) : '';
      }
      const result = await this.requestSyncStart(docUuid, null);
      if (result === null || result.delta.length === 0) {
        warn(`${this.tag} disjoint resolution has no server snapshot`, { docUuid, reason });
        this.trace.markPath('disjoint.no-snapshot', docUuid, { reason });
        return;
      }
      const tempDoc = createDocument('__probe__', '__probe__');
      tempDoc.import_snapshot(result.delta);
      const serverText = tempDoc.get_text();
      const textsDiffer = serverText !== localText;
      if (textsDiffer && localText.trim() !== '') {
        const cPath = conflictPath(this.app, docUuid);
        await this.app.vault.create(cPath, localText);
        this.inbox?.add({
          kind: 'disjoint-conflict', path: cPath, relatedPath: docUuid,
          note: conflictNoticeMessage(cPath),
        });
        warn(`${this.tag} disjoint history conflict`, { docUuid, reason, conflictPath: cPath });
        this.trace.markPath('disjoint.conflict', docUuid, { reason, conflictPath: cPath });
      } else {
        log(`${this.tag} disjoint history adopt (blank local or identical text)`, { docUuid, reason });
      }
      await this.docs.removeAndClean(docUuid);
      const freshDoc = await this.docs.getOrLoad(docUuid);
      freshDoc.import_snapshot(result.delta);
      this.lastServerVV.set(docUuid, result.serverVV);
      if (textsDiffer) await this.editor.writeToVault(docUuid, serverText);
      await this.docs.persist(docUuid);
      this.rememberVVCache(docUuid, result.serverVV, freshDoc.get_text());
    } finally {
      this.catchUpInProgress.delete(docUuid);
    }
  }

  private async onDocDeleted(docUuid: string, contentHash?: string): Promise<void> {
    if (!isSyncablePath(docUuid)) {
      warn(`${this.tag} rejected delete for invalid path`, { docUuid });
      return;
    }
    const doc = this.docs.get(docUuid);
    const editorContent = this.editor.readCurrentContent(docUuid);
    const unackedKeep = this.push.hasUnackedEdit(docUuid);
    // Keep-guard (T2), shared with initial-sync step 6:
    // 1. pending/unacked edits always KEEP.
    // 2. tombstone content_hash present: fnv1aHash64(local content) vs hash is
    //    authoritative (editor if a leaf is open, otherwise disk via TFile/
    //    vault.read). Mismatch ⇒ unsynced local value ⇒ KEEP, even when the
    //    watcher already folded the offline edit into the CRDT (CRDT == disk).
    //    Match ⇒ provably clean ⇒ Trash. Skips CRDT-vs-disk heuristics.
    // 3. hash absent (old server): previous heuristics — CRDT vs editor/disk,
    //    or persisted snapshot vs disk; no snapshot cannot prove clean ⇒ KEEP.
    let keep: boolean;
    if (this.push.hasPendingEdits(docUuid) || unackedKeep) {
      keep = true;
    } else if (typeof contentHash === 'string') {
      let localContent = editorContent;
      if (localContent === null) {
        const diskFile = this.app.vault.getAbstractFileByPath(docUuid);
        if (diskFile instanceof TFile) {
          localContent = await this.app.vault.read(diskFile);
        }
      }
      keep = localContent !== null && fnv1aHash64(localContent) !== contentHash;
    } else {
      let contentDiverged = false;
      if (doc !== undefined) {
        if (editorContent !== null) {
          contentDiverged = !doc.text_matches(editorContent);
        } else {
          const diskFile = this.app.vault.getAbstractFileByPath(docUuid);
          if (diskFile instanceof TFile) {
            const diskContent = await this.app.vault.read(diskFile);
            contentDiverged = !doc.text_matches(diskContent);
          }
        }
      } else {
        const persisted = await this.docs.loadPersistedSnapshot(docUuid);
        if (persisted === null) {
          // Live equivalent of step-6 Deviation 1: no snapshot means we cannot
          // prove the file is unmodified, so KEEP.
          contentDiverged = true;
        } else {
          const loaded = await this.docs.getOrLoad(docUuid);
          const diskFile = this.app.vault.getAbstractFileByPath(docUuid);
          if (diskFile instanceof TFile) {
            const diskContent = await this.app.vault.read(diskFile);
            contentDiverged = !loaded.text_matches(diskContent);
          }
        }
      }
      keep = contentDiverged;
    }
    if (keep) {
      this.forgetStartupPath(docUuid);
      this.inbox?.add({ kind: 'deleted-remote', path: docUuid, note: remoteDeleteKeptNoticeMessage(docUuid) });
      await this.docs.removeAndClean(docUuid);
      this.lastServerVV.delete(docUuid);
      this.lastRemoteWrite.delete(docUuid);
      this.push.markRecreateIntent(docUuid);
      this.trace.markPath('delete.kept-local-edits', docUuid, unackedKeep ? { unacked: true } : undefined);
      return;
    }
    this.push.ackPendingDelete(docUuid);
    this.forgetStartupPath(docUuid);
    await this.docs.removeAndClean(docUuid);
    this.lastServerVV.delete(docUuid);
    const f = this.app.vault.getAbstractFileByPath(docUuid);
    if (f instanceof TFile) {
      this.deletingFromRemote.add(docUuid);
      try {
        await this.app.fileManager.trashFile(f);
        this.inbox?.add({ kind: 'deleted-remote', path: docUuid, note: remoteDeleteTrashedNoticeMessage(docUuid) });
      } finally {
        window.setTimeout(() => this.deletingFromRemote.delete(docUuid), 500);
      }
    }
  }

  // ── Public API (delegated to PushHandler) ──────────────────────────────────

  traceEditorChange(path: string, data: Record<string, unknown>): void {
    this.trace.observePath(path);
    this.trace.markPath('ui.editor-change', path, data);
  }

  onFileChanged(path: string): void {
    this.startupEditedPaths.add(path);
    this.markStartupPathDirty(path);
    this.trace.observePath(path);
    this.trace.markPath('editor-change.accepted', path, { initialSyncRunning: this.initialSyncRunning });
    this.push.onFileChanged(path);
  }

  onFileChangedImmediate(path: string, content: string): void {
    this.markStartupPathDirty(path);
    this.trace.observePath(path);
    this.trace.markPath('vault-change.accepted', path, {
      initialSyncRunning: this.initialSyncRunning,
      contentLen: content.length,
    });
    this.push.onFileChangedImmediate(path, content);
  }

  onFileDeleted(path: string): void {
    this.forgetStartupPath(path);
    this.push.onFileDeleted(path);
  }

  onFileRenamed(oldPath: string, newPath: string, content: string): void {
    this.forgetStartupPath(oldPath);
    this.markStartupPathDirty(newPath);
    this.push.onFileRenamed(oldPath, newPath, content);
  }

  /**
   * Delete the old path only (used when a rename crosses the syncable-path
   * boundary: syncable → unsyncable). The new path is outside the policy,
   * so nothing is pushed for it.
   */
  onFileDeletedOnly(path: string): void {
    this.forgetStartupPath(path);
    this.push.deleteOnly(path);
  }

  noteSuppressedColdStartVaultEvent(type: 'modify' | 'create' | 'rename'): void {
    this.suppressedColdStartVaultEvents[type]++;
  }

  // ── Guards ──────────────────────────────────────────────────────────────────

  shouldAcceptVaultChangeEvents(): boolean {
    return this.acceptVaultChangeEvents;
  }

  isWritingFromRemote(path: string): boolean {
    return this.writingFromRemote.has(path);
  }

  isDeletingFromRemote(path: string): boolean {
    return this.deletingFromRemote.has(path);
  }

  traceVaultDeleteDropped(path: string, reason: 'echo-dropped' | 'remote-suppressed'): void {
    this.trace.observePath(path);
    this.trace.markPath(`vault-change.delete-${reason}`, path);
  }

  /** Discriminate vault events observed inside the remote-write window. */
  isRemoteWriteEcho(path: string, content: string): boolean {
    const hashMatch = this.lastRemoteWrite.get(path) === fnv1aHash64(content);
    this.trace.observePath(path);
    this.trace.markPath(
      hashMatch ? 'vault-change.echo-dropped' : 'vault-change.accepted-in-window',
      path,
      { hashMatch },
    );
    return hashMatch;
  }

  isUpdatingEditorFromRemote(path: string): boolean {
    return this.editor.isUpdatingEditorFromRemote(path);
  }

  readCurrentContent(path: string): string | null {
    return this.editor.readCurrentContent(path);
  }

  getStartupTraceReport(): string {
    return redact(redact(this.trace.report(), this.token ?? ''));
  }

  getDocument(filePath: string): WasmSyncDocument | undefined {
    return this.docs.get(filePath);
  }

  getDiagnosticsCounts(): { vvCacheEntries: number; pendingDeletes: number; sentUnacked: number } {
    return {
      vvCacheEntries: this.vvCache.size,
      pendingDeletes: this.push.pendingDeletePaths().length,
      sentUnacked: this.push.sentUnackedCount(),
    };
  }

  /** Panel data: last server message, last completed full sync, unacked pushes. */
  getPanelStats(): { lastActivityAt: number; lastInitialSyncAt: number; sentUnacked: number } {
    return {
      lastActivityAt: this.lastServerActivityAt,
      lastInitialSyncAt: this.lastInitialSyncAt,
      sentUnacked: this.push.sentUnackedCount(),
    };
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

  private markStartupPathDirty(path: string): void {
    this.startupDirty.markDirty(path);
  }

  private forgetStartupPath(path: string): void {
    this.startupDirty.clear(path);
    this.vvCache.delete(path);
  }

  private rememberVVCache(path: string, vv: string, text: string): void {
    this.vvCache.set(path, { vv, contentHash: fnv1aHash64(text) });
    this.vvCacheDirty = true;
    // Keep the first deadline: continuous broadcasts must not postpone persistence.
    if (this.vvCacheTimer !== null) return;
    this.vvCacheTimer = window.setTimeout(() => {
      void this.flushVVCache().catch((err) => error(`${this.tag} vv-cache flush failed:`, err));
    }, 5000);
  }

  private flushVVCache(): Promise<void> {
    if (this.vvCacheTimer !== null) window.clearTimeout(this.vvCacheTimer);
    this.vvCacheTimer = null;
    // Serialize whole-file writes, including close/unload during an active write.
    const write = this.vvCacheWrite.then(async () => {
      if (!this.vvCacheDirty) return;
      this.vvCacheDirty = false;
      try {
        await this.docs.saveVVCache(this.vvCache);
      } catch (err) {
        this.vvCacheDirty = true;
        throw err;
      }
    });
    this.vvCacheWrite = write.catch(() => {});
    return write;
  }

  private async replaceVVCache(map: Map<string, VVCacheEntry>): Promise<void> {
    await this.vvCacheWrite;
    this.vvCache = new Map(map);
    this.vvCacheDirty = true;
    await this.flushVVCache();
  }

  private replaceDirtyPaths(paths: Iterable<string>): void {
    this.startupDirty.replace(paths);
  }

  // note: a debounced push before auth_ok follows synchronous Auth on this
  // socket; add a client queue only if the server stops processing frames in order.
  private send(msg: object): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const bytes = encode(msg) as Uint8Array;
    const MAX_WS_MSG_BYTES = 50 * 1024 * 1024;
    if (bytes.byteLength > MAX_WS_MSG_BYTES) {
      error(`${this.tag} refusing to send oversized message`, {
        bytes: bytes.byteLength,
        limit: MAX_WS_MSG_BYTES,
        type: (msg as { type?: string }).type,
      });
      if (!this.oversizedSendNoticed) {
        this.oversizedSendNoticed = true;
        new Notice(
          'VaultCRDT: message too large to sync (50 MiB limit)',
          10000,
        );
      }
      return;
    }
    // @msgpack/msgpack returns a slice over a plain ArrayBuffer (never a
    // SharedArrayBuffer), but its declared type is Uint8Array<ArrayBufferLike>.
    this.ws.send(bytes as Uint8Array<ArrayBuffer>);
  }

  async requestDocList(): Promise<{ docs: DocEntry[]; tombstones: string[]; tombstone_hashes?: Array<{ doc_uuid: string; content_hash: string | null }> }> {
    this.trace.mark('ws.request-doc-list');
    this.send({ type: 'request_doc_list' });
    const result = await this.promises.waitFor<{
      docs: DocEntry[];
      tombstones: string[];
      tombstone_hashes?: Array<{ doc_uuid: string; content_hash: string | null }>;
    }>('doc_list');
    this.trace.mark('ws.doc-list', {
      docs: result.docs.length,
      tombstones: result.tombstones.length,
    });
    return result;
  }

  private requestSyncStart(
    docUuid: string,
    clientVV: string | null,
  ): Promise<SyncDeltaResponse> {
    if (this.stopped) return Promise.reject(new Error('Sync engine stopped'));
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket not open'));
    }
    return this.broker.request(docUuid, clientVV);
  }

  private setStatus(s: SyncStatus): void {
    this.statusCallback?.(s);
  }

  /** Log tag including peerId for multi-vault console debugging. */
  private get tag(): string {
    return `[VCRDT:${this.settings.peerId}]`;
  }
}

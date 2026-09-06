import { Plugin, Platform, TFile, TFolder, Notice, requestUrl, apiVersion } from 'obsidian';
import { VaultCRDTSettings, VaultCRDTSettingsTab, DEFAULT_SETTINGS, ensureDeviceIdentity, regeneratePeerId } from './settings';
import { initWasm } from './wasm-bridge';
import { SyncEngine } from './sync-engine';
import type { SyncMode } from './sync-engine';
import { FileWatcher } from './file-watcher';
import { SetupModal } from './setup-modal';
import { parseSetupParams } from './setup-link';
import { InviteModal } from './invite-modal';
import { ReplaceConnectionModal } from './replace-connection-modal';
import { resetConnectionState } from './settings';
import { SETUP_COPY } from './user-facing-copy';
import { Modal } from 'obsidian';
import { log, error, redact, setSecretProvider, getRecentIssues } from './logger';
import { ServerFeatureCache, FEATURE_INVITE, FEATURE_BLOBS } from './server-features';
import { buildDiagnosticsReport, assertNoSecret, type DiagnosticsInput } from './diagnostics';
import { PROTOCOL_VERSION, jsonOf } from './protocol';
import { toHttpBase } from './url-policy';
import { isSyncablePath, isAttachmentPath } from './path-policy';
import { BlobIndex } from './blob-index';
import { BlobUploader } from './blob-uploader';
import { StateStorage } from './state-storage';
import { Inbox } from './inbox';
import { InboxModal } from './inbox-modal';
import { StatusPanelModal } from './status-panel';
import { PANEL_COPY } from './user-facing-copy';

/** If no server response (pong/ack/delta) for this long, show disconnected. */
const ACTIVITY_TIMEOUT_MS = 60_000;

export default class VaultCRDTPlugin extends Plugin {
  declare settings: VaultCRDTSettings;
  syncEngine!: SyncEngine;
  fileWatcher!: FileWatcher;
  private statusBarEl: HTMLElement | null = null;
  private ribbonEl: HTMLElement | null = null;
  private connected = false;
  /** Quiet-mode inbox (design §E) — persisted in state/inbox.json, not settings. */
  inbox!: Inbox;
  private activityTimer: number | null = null;
  private syncEngineInitialized = false;
  private pendingDeleteChecks = new Set<string>();
  private pendingSyncEngineInit: Promise<void> | null = null;
  private handlingSetupLink = false;
  private activeSetup: SetupModal | null = null;
  /** Cached GET /health feature list (TTL'd), shared by every SetupModal. */
  serverFeatures = new ServerFeatureCache();
  /** Attachment blob lane (design §3) — dormant unless the server has "blobs". */
  blobIndex!: BlobIndex;
  blobUploader!: BlobUploader;

  async onload(): Promise<void> {
    await this.loadSettings();
    const setupHandler = (params: Record<string, string>) => {
      void this.handleSetupLink(params).catch(() => new Notice(SETUP_COPY.failed, 8000));
    };
    this.registerObsidianProtocolHandler('vaultcrdt/setup', setupHandler);
    this.registerObsidianProtocolHandler('vaultcrdt-setup', setupHandler);
    this.inbox = new Inbox({
      storage: new StateStorage(this.app),
      fileExists: (path) => !!this.app.vault.getAbstractFileByPath(path),
      notify: (text) => { new Notice(text, 4000); },
    });
    await this.inbox.load();
    this.blobIndex = new BlobIndex(new StateStorage(this.app));
    await this.blobIndex.load();
    this.blobUploader = new BlobUploader({
      index: this.blobIndex,
      serverUrl: () => this.settings.serverUrl,
      peerId: () => this.settings.peerId,
      getJwt: () => this.syncEngine.getJwt(),
      blobsEnabled: async () =>
        this.syncEngineInitialized
        && (await this.serverFeatures.get(this.settings.serverUrl)).includes(FEATURE_BLOBS),
      stat: (path) => this.app.vault.adapter.stat(path),
      readBinary: (path) => this.app.vault.adapter.readBinary(path),
      notify: (text) => { new Notice(text, 8000); },
      isMobile: Platform.isMobile,
    });
    this.refreshInboxIndicators();
    // Obsidian prefixes this with the manifest id, yielding vaultcrdt:invite-device.
    this.addCommand({ id: 'invite-device', name: SETUP_COPY.command,
      callback: () => { this.openInviteModal(); } });
    // Phones have no ribbon and no status bar, so the panel and the inbox are
    // only reachable as commands (palette / pinned mobile toolbar).
    this.addCommand({ id: 'open-status-panel', name: PANEL_COPY.command, icon: 'refresh-cw',
      callback: () => { this.openStatusPanel(); } });
    this.addCommand({ id: 'open-inbox', name: PANEL_COPY.inboxCommand, icon: 'inbox',
      callback: () => { this.openInbox(); } });
    this.ribbonEl = this.addRibbonIcon('refresh-cw', PANEL_COPY.ribbon, () => { this.openStatusPanel(); });
    this.refreshInboxIndicators();

    // Defer SyncEngine initialization until editor is ready (lazy-load pattern)
    // This avoids blocking the UI during startup.
    this.addCommand({
      id: 'export-startup-trace',
      name: 'Export last startup trace',
      callback: () => void this.exportStartupTrace(),
    });
    this.addCommand({
      id: 'export-diagnostics',
      name: 'Export diagnostics bundle',
      callback: () => void this.exportDiagnostics().catch(() => {
        new Notice('VaultCRDT: diagnostics export failed', 8000);
      }),
    });

    // React to editor keystrokes (debounced inside SyncEngine)
    this.registerEditorAndVaultEvents();

    // Scan for external changes (git pull, Syncthing) when window is focused
    if (Platform.isDesktop) {
      this.registerDomEvent(window, 'focus', () => {
        if (this.syncEngineInitialized) {
          void this.fileWatcher.scanForExternalChanges();
        }
      });
    }

    this.addSettingTab(new VaultCRDTSettingsTab(this.app, this));
    this.setupStatusBar();

    // Wait for layout before initializing sync engine
    this.app.workspace.onLayoutReady(() => {
      this.inbox.scanExisting(this.app.vault.getMarkdownFiles().map((f) => f.path));
      this.refreshInboxIndicators();
      void this.initializeSyncEngine();
    });

    log('Plugin loaded');
  }

  /** Invite modal with the server-minted one-use token (shared by command + panel). */
  openInviteModal(): void {
    const mintInvite = async (): Promise<{ invite: string; expires_at: string } | null> => {
          const supported = (await this.serverFeatures.get(this.settings.serverUrl)).includes(FEATURE_INVITE);
          log('invite.mint', { supported, engineReady: this.syncEngineInitialized, vault: this.settings.vaultId });
          if (!supported) return null;
          if (!this.syncEngineInitialized) {
            // Command can fire before the lazy engine init finished; the call is
            // idempotent and joins a pending init instead of starting a second one.
            await this.initializeSyncEngine();
            log('invite.mint.engine-init', { engineReady: this.syncEngineInitialized });
            if (!this.syncEngineInitialized) return null;
          }
          try {
            const jwt = await this.syncEngine.getJwt();
            const resp = await requestUrl({
              url: `${toHttpBase(this.settings.serverUrl)}/invite`,
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
              body: JSON.stringify({ peer_id: this.settings.peerId, device_name: this.settings.deviceName }),
            });
            const { invite, expires_at } = jsonOf<{ invite: string; expires_at: string }>(resp);
            log('invite.mint.resp', { ok: !!(invite && expires_at), status: resp.status });
            return invite && expires_at ? { invite, expires_at } : null;
          } catch (e) {
            error('invite.mint failed:', (e as { status?: number })?.status, e);
            return null;
          }
        };
        new InviteModal(this.app, this.settings, mintInvite).open();
  }

  /** Ribbon status panel (design §E) — the mobile-safe entry point. */
  openStatusPanel(): void {
    void this.serverFeatures.get(this.settings.serverUrl);
    new StatusPanelModal(this.app, () => ({
      connected: this.connected,
      ...(this.syncEngineInitialized
        ? this.syncEngine.getPanelStats()
        : { lastActivityAt: 0, lastInitialSyncAt: 0, sentUnacked: 0 }),
      inboxCount: this.inbox.count(),
      serverProtocolVersion: this.serverFeatures.protocolVersion(),
      clientProtocolVersion: PROTOCOL_VERSION,
    }), {
      syncNow: () => { void this.syncNow(); },
      invite: () => { this.openInviteModal(); },
      openInbox: () => { this.openInbox(); },
      exportDiagnostics: () => void this.exportDiagnostics().catch(() => {
        new Notice('VaultCRDT: diagnostics export failed', 8000);
      }),
      openSettings: () => {
        (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } })
          .setting.open();
        (this.app as unknown as { setting: { openTabById(id: string): void } })
          .setting.openTabById(this.manifest.id);
      },
    }).open();
  }

  openInbox(): void {
    // Dismiss inside the modal must update ribbon tint + status-bar badge at
    // once, not on the next activity tick.
    new InboxModal(this.app, this.inbox, () => this.setStatusBarConnected(this.connected)).open();
    this.refreshInboxIndicators();
  }

  private async syncNow(): Promise<void> {
    await this.initializeSyncEngine();
    if (!this.syncEngineInitialized) return;
    await this.runSyncWithProgress(this.syncEngine, 'merge').catch((err) => {
      error('sync now failed:', err);
    });
  }

  /** All editor/vault event wiring (kept together for readability). */
  private registerEditorAndVaultEvents(): void {
    // React to editor keystrokes (debounced inside SyncEngine)
    this.registerEvent(
      this.app.workspace.on('editor-change', (editor, view) => {
        const file = view.file;
        if (!file) return;
        if (!this.syncEngineInitialized) return; // Ignore edits before sync engine is ready
        const syncable = isSyncablePath(file.path);
        const writingFromRemote = this.syncEngine.isWritingFromRemote(file.path);
        const updatingEditorFromRemote = this.syncEngine.isUpdatingEditorFromRemote(file.path);
        const accepted = syncable && !writingFromRemote && !updatingEditorFromRemote;
        this.syncEngine.traceEditorChange(file.path, {
          accepted,
          syncable,
          writingFromRemote,
          updatingEditorFromRemote,
        });
        if (accepted) {
          this.syncEngine.onFileChanged(file.path);
        }
      })
    );

    // React to vault file saves — push immediately, but only for external edits.
    // When a file is open in an editor, editor-change (debounced) handles it.
    // Pushing here too causes echo loops because vault.read() can return stale
    // disk content while the editor already has fresh broadcast content.
    this.registerEvent(
      this.app.vault.on('modify', async (abstractFile) => {
        if (!(abstractFile instanceof TFile)) return;
        if (isAttachmentPath(abstractFile.path)) { this.blobUploader.onFileChanged(abstractFile.path); return; }
        if (!isSyncablePath(abstractFile.path)) return;
        if (!this.syncEngineInitialized) return; // Ignore changes before sync engine is ready
        let content: string | undefined;
        if (this.syncEngine.isWritingFromRemote(abstractFile.path)) {
          content = await this.app.vault.read(abstractFile);
          if (this.syncEngine.isRemoteWriteEcho(abstractFile.path, content)) return;
        }
        if (!this.syncEngine.shouldAcceptVaultChangeEvents()) {
          this.syncEngine.noteSuppressedColdStartVaultEvent('modify');
          return;
        }
        if (this.syncEngine.readCurrentContent(abstractFile.path) !== null) return;
        content ??= await this.app.vault.read(abstractFile);
        this.syncEngine.onFileChangedImmediate(abstractFile.path, content);
      })
    );

    // File creation — push immediately
    this.registerEvent(
      this.app.vault.on('create', async (file) => {
        if (!(file instanceof TFile)) return;
        if (isAttachmentPath(file.path)) { this.blobUploader.onFileChanged(file.path); return; }
        if (!isSyncablePath(file.path)) return;
        if (!this.syncEngineInitialized) return; // Ignore creates before sync engine is ready
        let content: string | undefined;
        if (this.syncEngine.isWritingFromRemote(file.path)) {
          content = await this.app.vault.read(file);
          if (this.syncEngine.isRemoteWriteEcho(file.path, content)) return;
        }
        if (!this.syncEngine.shouldAcceptVaultChangeEvents()) {
          this.syncEngine.noteSuppressedColdStartVaultEvent('create');
          return;
        }
        content ??= await this.app.vault.read(file);
        this.syncEngine.onFileChangedImmediate(file.path, content);
      })
    );

    // File deletion — push tombstone + clean up local CRDT
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (!(file instanceof TFile)) return;
        this.inbox.onFileDeleted(file.path);
        this.refreshInboxIndicators();
        if (!isSyncablePath(file.path)) return;
        if (!this.syncEngineInitialized) return; // Ignore deletes before sync engine is ready
        const path = file.path;
        if (this.syncEngine.isDeletingFromRemote(path)) {
          this.syncEngine.traceVaultDeleteDropped(path, 'remote-suppressed');
          return;
        }
        if (this.pendingDeleteChecks.has(path)) {
          this.syncEngine.traceVaultDeleteDropped(path, 'echo-dropped');
          return;
        }
        if (this.syncEngine.isWritingFromRemote(path)) {
          this.pendingDeleteChecks.add(path);
          window.setTimeout(() => {
            if (!this.pendingDeleteChecks.delete(path)) return;
            if (this.app.vault.getAbstractFileByPath(path)) {
              this.syncEngine.traceVaultDeleteDropped(path, 'echo-dropped');
            } else {
              this.syncEngine.onFileDeleted(path);
            }
          }, 600);
          return;
        }
        this.syncEngine.onFileDeleted(path);
      })
    );

    // File rename — four transitions depending on whether each side is
    // syncable. Folders fire per-file rename events, so we only care about TFile.
    //
    //   old syncable | new syncable → rename (tombstone old, push new)
    //   old syncable | new unsync   → deleteOnly(old) — file moved out of policy
    //   old unsync   | new syncable → push new as a fresh file, do NOT emit
    //                                  a spurious doc_delete for a path the
    //                                  server has never seen
    //   old unsync   | new unsync   → ignore
    this.registerEvent(
      this.app.vault.on('rename', async (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        this.inbox.onFileRenamed(oldPath, file.path);
        this.refreshInboxIndicators();
        if (!this.syncEngineInitialized) return; // Ignore renames before sync engine is ready
        const oldSync = isSyncablePath(oldPath);
        const newSync = isSyncablePath(file.path);
        if (!this.syncEngine.shouldAcceptVaultChangeEvents()) {
          this.syncEngine.noteSuppressedColdStartVaultEvent('rename');
          return;
        }
        if (oldSync && newSync) {
          const content = await this.app.vault.read(file);
          this.syncEngine.onFileRenamed(oldPath, file.path, content);
        } else if (oldSync && !newSync) {
          this.syncEngine.onFileDeletedOnly(oldPath);
        } else if (!oldSync && newSync) {
          if (this.syncEngine.isWritingFromRemote(file.path)) return;
          const content = await this.app.vault.read(file);
          this.syncEngine.onFileChangedImmediate(file.path, content);
        }
      })
    );
  }

  private async initializeSyncEngine(): Promise<void> {
    if (this.syncEngineInitialized) return;
    if (this.pendingSyncEngineInit) {
      await this.pendingSyncEngineInit;
      return;
    }

    const init = (async () => {
      try {
        // Lazy-initialize WASM + sync engine after editor is ready
        // (non-blocking). The WASM module must be ready before the
        // SyncEngine constructor touches any Loro bindings.
        await initWasm();
        this.buildAndWireSyncEngine();
        this.pendingSyncEngineInit = null;

        // Start sync connection after engine is ready
        if (!this.handlingSetupLink) await this.startWithSetup();
      } catch (err) {
        error('Failed to initialize sync engine:', err);
        this.pendingSyncEngineInit = null;
      }
    })();

    this.pendingSyncEngineInit = init;
    await init;
  }

  /**
   * Construct the SyncEngine + FileWatcher and wire their callbacks. Shared by
   * the lazy first init and the device-identity reset, which must build a
   * *fresh* engine so DocumentManager / StartupDirtyTracker pick up the new
   * peerId (both capture it at construction, so restart() alone is not enough).
   */
  private buildAndWireSyncEngine(): void {
    this.syncEngine = new SyncEngine(this.app, this.settings);
    this.fileWatcher = new FileWatcher(this.app, this.syncEngine);
    // Wire up initial sync (auto-detect pull/push/merge)
    this.syncEngine.inbox = this.inbox;
    this.syncEngine.onInitialSync = (engine) => {
      void this.handleInitialSync(engine);
    };
    this.syncEngineInitialized = true;
    this.wireStatusBar();
  }

  /**
   * Danger action (settings): mint a fresh peerId for this device so a cloned
   * vault stops sharing one Loro peer line across two machines. The engine is
   * fully REBUILT (not just restarted) because DocumentManager and
   * StartupDirtyTracker capture peerId at construction. Existing `.loro`
   * snapshots and the path-keyed vv-cache are kept (content stays valid); only
   * the peer-keyed startup-dirty entry is dropped. Returns the new peerId.
   */
  async resetDeviceIdentity(): Promise<string> {
    if (!this.syncEngineInitialized) {
      // Engine not up yet — mint + persist; the pending init builds it later.
      const { newPeerId } = regeneratePeerId(this.settings);
      await this.saveSettings();
      return newPeerId;
    }
    await this.syncEngine.stop();
    // Drop the OLD peer-keyed startup-dirty entry before the id changes.
    this.syncEngine.clearStartupDirtyForIdentityReset();
    const { newPeerId } = regeneratePeerId(this.settings);
    await this.saveSettings();
    this.buildAndWireSyncEngine();
    try {
      await this.syncEngine.start();
    } catch (err) {
      error('resetDeviceIdentity start error:', err);
      new Notice('VaultCRDT: reconnect after reset failed — check Settings', 8000);
    }
    return newPeerId;
  }

  async handleSetupLink(params: Record<string, string>): Promise<void> {
    if (this.handlingSetupLink) return;
    let prefill;
    try { prefill = parseSetupParams(params); }
    catch (err) {
      const modal = new Modal(this.app);
      modal.contentEl.createEl('p', { text: (err as Error).message });
      modal.open();
      return;
    }
    this.handlingSetupLink = true;
    try {
      const configured = !!(this.settings.serverUrl && this.settings.vaultId
        && (this.settings.vaultSecret || this.settings.deviceKey));
      if (configured && !await new ReplaceConnectionModal(this.app, this.settings.vaultId).prompt()) return;
      this.activeSetup?.close();
      await this.initializeSyncEngine();
      if (!this.syncEngineInitialized) throw new Error(SETUP_COPY.failed);
      const result = await new SetupModal(this.app, this.settings, prefill, this.serverFeatures).prompt();
      if (!result) { new Notice(SETUP_COPY.configure, 5000); return; }
      // Wipe only AFTER the join is confirmed: cancelling the modal must be a
      // true no-op, not a half-wiped connection (device-test finding 2026-09-06:
      // confirm-replace + cancel-join left the vault unsynced and unconfigured).
      if (configured) {
        await resetConnectionState(this, true);
        await this.saveSettings();
      }
      this.settings.serverUrl = result.serverUrl;
      this.settings.vaultId = result.vaultId;
      this.settings.vaultSecret = result.vaultSecret;
      this.settings.deviceKey = result.deviceKey ?? '';
      if (result.deviceName !== undefined) this.settings.deviceName = result.deviceName;
      this.settings.onboardingComplete = false;
      await this.saveSettings();
      if (result.adminToken) this.syncEngine.setOneShotAdminToken(result.adminToken);
      await this.syncEngine.start();
    } finally { this.handlingSetupLink = false; }
  }

  private async startWithSetup(): Promise<void> {
    const needsSetup = !this.settings.serverUrl || !this.settings.vaultId
      || !(this.settings.vaultSecret || this.settings.deviceKey);
    if (needsSetup) {
      this.activeSetup = new SetupModal(this.app, this.settings);
      const result = await this.activeSetup.prompt();
      this.activeSetup = null;
      if (this.handlingSetupLink) return;
      if (result) {
        // Persist only the durable credentials. The optional adminToken
        // is a one-shot used for the very first auth and must never
        // touch disk.
        this.settings.serverUrl = result.serverUrl;
        this.settings.vaultId = result.vaultId;
        this.settings.vaultSecret = result.vaultSecret;
        this.settings.deviceKey = result.deviceKey ?? '';
        await this.saveSettings();
        if (result.adminToken) {
          this.syncEngine.setOneShotAdminToken(result.adminToken);
        }
      } else {
        new Notice('VaultCRDT: open Settings to configure sync', 5000);
        return;
      }
    }
    this.syncEngine.start().catch((err) => {
      error('start error:', err);
      new Notice('VaultCRDT: connection failed — check Settings', 8000);
    });
  }

  private async handleInitialSync(engine: SyncEngine): Promise<void> {
    try {
      const isOnboarding = !this.settings.onboardingComplete;
      let mode: SyncMode = 'merge';

      if (isOnboarding) {
        const { docs: serverDocs } = await engine.requestDocList();
        const localFiles = this.app.vault.getMarkdownFiles();

        // Auto-detect: no question asked
        if (localFiles.length === 0 && serverDocs.length > 0) {
          mode = 'pull';
        } else if (serverDocs.length === 0 && localFiles.length > 0) {
          mode = 'push';
        }
        // else: both have content → merge (CRDT handles conflicts)

        this.settings.onboardingComplete = true;
        await this.saveSettings();
      }

      await this.runSyncWithProgress(engine, mode, isOnboarding);
      // Catch-up runs after the doc_list-driven initial sync completed.
      await this.blobUploader.catchUp().catch((err) => { error('blob catch-up failed:', err); });
    } catch (err) {
      error('initialSync error:', err);
      new Notice('VaultCRDT: Sync failed — see console for details');
    }
  }

  private async runSyncWithProgress(engine: SyncEngine, mode: SyncMode, forceNotice = false): Promise<void> {
    let notice = null as Notice | null;
    try {
      await engine.initialSync((done, total, changed) => {
        // Quiet mode (design §E): progress is only shown during the first
        // onboarding sync; later syncs log instead of interrupting.
        if (!forceNotice) {
          log(`sync progress ${done}/${total} (${changed} changed)`);
          return;
        }
        if (!notice) notice = new Notice('VaultCRDT: Starting sync...', 0);
        notice.setMessage(`VaultCRDT: Syncing ${done}/${total} (${changed} changed)...`);
      }, mode);
      if (notice) {
        notice.hide();
        new Notice('VaultCRDT: Sync complete', 3000);
      }
      this.refreshInboxIndicators();
    } catch (err) {
      notice?.hide();
      new Notice('VaultCRDT: Sync failed', 5000);
      throw err;
    }
  }

  private setupStatusBar(): void {
    // Show the status bar immediately; callbacks are wired by
    // initializeSyncEngine() once the engine exists.
    this.updateStatusBar();
  }

  private wireStatusBar(): void {
    if (!this.syncEngineInitialized) return;
    // Connection state is tracked even without a status bar — the ribbon
    // panel is the only surface on mobile.
    this.syncEngine.statusCallback = (status) => {
      if (status === 'offline' || status === 'error') {
        this.clearActivityTimer();
        this.setStatusBarConnected(false);
      }
      // 'connected' and 'syncing' are ignored here — only actual server
      // responses (via onServerActivity) flip the indicator to ●.
    };
    this.syncEngine.onServerActivity = () => {
      this.setStatusBarConnected(true);
      this.resetActivityTimer();
    };
  }

  updateStatusBar(): void {
    if (this.settings.showSyncStatus) {
      if (!this.statusBarEl) {
        this.statusBarEl = this.addStatusBarItem();
        this.statusBarEl.addClass('vcrdt-status');
      }
      this.setStatusBarConnected(false);
    } else {
      this.clearActivityTimer();
      this.statusBarEl?.remove();
      this.statusBarEl = null;
    }
  }

  private resetActivityTimer(): void {
    this.clearActivityTimer();
    this.activityTimer = window.setTimeout(() => {
      this.setStatusBarConnected(false);
    }, ACTIVITY_TIMEOUT_MS);
  }

  private clearActivityTimer(): void {
    if (this.activityTimer) {
      window.clearTimeout(this.activityTimer);
      this.activityTimer = null;
    }
  }

  private setStatusBarConnected(connected: boolean): void {
    this.connected = connected;
    this.refreshInboxIndicators();
    if (!this.statusBarEl) return;
    this.statusBarEl.empty();
    this.statusBarEl.appendText('sync\u2002');
    this.statusBarEl.createSpan({ text: connected ? '●' : '○', cls: 'vcrdt-status-dot' });
    const inboxCount = this.inbox?.count() ?? 0;
    if (inboxCount > 0) this.statusBarEl.appendText(`\u00b7${inboxCount}`);
    this.statusBarEl.setAttribute('aria-label', connected ? 'VaultCRDT: connected' : 'VaultCRDT: not connected');
    this.statusBarEl.addClass('vcrdt-status-bar');
    this.statusBarEl.toggleClass('vcrdt-status-connected', connected);
  }

  /** Ribbon tint + status-bar badge follow inbox count and connection state. */
  private refreshInboxIndicators(): void {
    const attention = (this.inbox?.count() ?? 0) > 0 || !this.connected;
    this.ribbonEl?.toggleClass('vcrdt-ribbon-attention', attention);
  }

  private async exportStartupTrace(): Promise<void> {
    if (!this.syncEngineInitialized) {
      new Notice('VaultCRDT: sync engine not yet initialized', 5000);
      return;
    }
    const dir = 'VaultCRDT Debug';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = `${dir}/startup-trace-${stamp}.md`;
    await this.ensureDir(dir);
    await this.app.vault.create(path, this.syncEngine.getStartupTraceReport());
    new Notice(redact(`VaultCRDT: trace exported to ${path}`), 8000);
  }

  private async exportDiagnostics(): Promise<void> {
    const t0 = Date.now();
    let health: DiagnosticsInput['health'];
    try {
      const resp = await requestUrl({ url: `${toHttpBase(this.settings.serverUrl)}/health` });
      const body = jsonOf<{ version: unknown; protocol_version: unknown }>(resp);
      health = {
        reachable: true, latencyMs: Date.now() - t0,
        version: typeof body.version === 'string' ? body.version : undefined,
        protocolVersion: typeof body.protocol_version === 'number' ? body.protocol_version : undefined,
      };
    } catch {
      health = { reachable: false, latencyMs: Date.now() - t0 };
    }
    let counts = { vvCacheEntries: -1, pendingDeletes: -1, sentUnacked: -1, stateFiles: -1, stateBytes: -1 };
    if (this.syncEngineInitialized) {
      const { loroFiles } = await this.syncEngine.getLocalStorageStats();
      counts = {
        ...this.syncEngine.getDiagnosticsCounts(), stateFiles: loroFiles.length,
        stateBytes: loroFiles.reduce((sum, [, bytes]) => sum + bytes, 0),
      };
    }
    const dir = 'VaultCRDT Debug';
    const folder = this.app.vault.getAbstractFileByPath(dir);
    const traces = folder instanceof TFolder
      ? folder.children.filter(f => f instanceof TFile && /^startup-trace-.*\.md$/.test(f.name)) : [];
    traces.sort((a, b) => a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
    const report = buildDiagnosticsReport({
      pluginVersion: this.manifest.version, obsidianVersion: apiVersion,
      serverUrl: this.settings.serverUrl, health, clientProtocolVersion: PROTOCOL_VERSION,
      settings: { ...this.settings }, deviceName: this.settings.deviceName, peerId: this.settings.peerId,
      counts, recentIssues: getRecentIssues(), newestTracePath: traces[0]?.path ?? null,
      inboxCount: this.inbox?.count() ?? 0,
      lastInitialSyncAt: this.syncEngineInitialized ? this.syncEngine.getPanelStats().lastInitialSyncAt : 0,
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = `${dir}/diagnostics-${stamp}.md`;
    await this.ensureDir(dir);
    assertNoSecret(report, this.settings.vaultSecret, this.settings.deviceKey ?? '');
    await this.app.vault.create(path, report);
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) throw new Error('diagnostics file could not be read back');
    const back = await this.app.vault.read(f);
    try {
      assertNoSecret(back, this.settings.vaultSecret, this.settings.deviceKey ?? '');
    } catch (e) {
      // Security exception to obsidianmd/prefer-file-manager-trash-file: a
      // diagnostics file that still contains the vault secret must be removed
      // permanently, never moved to the trash where it stays readable.
      await this.app.vault.delete(f, true);
      new Notice('VaultCRDT: diagnostics export aborted — file contained the vault secret and was deleted', 10000);
      throw e;
    }
    new Notice(redact(`VaultCRDT: diagnostics exported to ${path}`), 8000);
  }

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

  onunload(): void {
    // Plugin.onunload is synchronous; the shutdown continues in the background
    // exactly as before (Obsidian never awaited the returned promise).
    void this.shutdown();
  }

  private async shutdown(): Promise<void> {
    this.clearActivityTimer();
    // ponytail: pending deletes are not flushed on unload; startup reconciles.
    this.pendingDeleteChecks.clear();
    // Wait for pending initialization before stopping
    if (this.pendingSyncEngineInit) {
      await this.pendingSyncEngineInit;
    }
    if (this.syncEngineInitialized) {
      await this.syncEngine.stop();
    }
    log('Plugin unloaded');
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData() as Record<string, unknown> | null;
    if (data) {
      // Migrate legacy "apiKey" → "vaultSecret"
      if ('apiKey' in data && !('vaultSecret' in data)) {
        data.vaultSecret = data.apiKey;
      }
      // Clean up removed fields
      delete data.apiKey;
      delete data.registrationKey;
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

    // Startup invariant: peerId and deviceName must exist BEFORE the
    // SyncEngine is constructed, otherwise the Loro doc would be created
    // with an unstable random PeerID and the WS handshake would send an
    // empty peer_id. The SettingsTab used to lazily generate these on first
    // open, which is too late — see the conflict-storm audit notes §3B (local).
    if (ensureDeviceIdentity(this.settings)) {
      await this.saveSettings();
    }
    setSecretProvider(() => this.settings.vaultSecret);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

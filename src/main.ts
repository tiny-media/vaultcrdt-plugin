import { Plugin, Platform, TFile, Notice } from 'obsidian';
import { VaultCRDTSettings, VaultCRDTSettingsTab, DEFAULT_SETTINGS, ensureDeviceIdentity } from './settings';
import { initWasm } from './wasm-bridge';
import { SyncEngine } from './sync-engine';
import type { SyncMode } from './sync-engine';
import { FileWatcher } from './file-watcher';
import { SetupModal } from './setup-modal';
import { log, error } from './logger';
import { isSyncablePath } from './path-policy';

/** If no server response (pong/ack/delta) for this long, show disconnected. */
const ACTIVITY_TIMEOUT_MS = 60_000;

export default class VaultCRDTPlugin extends Plugin {
  settings!: VaultCRDTSettings;
  syncEngine!: SyncEngine;
  fileWatcher!: FileWatcher;
  private statusBarEl: HTMLElement | null = null;
  private activityTimer: ReturnType<typeof setTimeout> | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    await initWasm();

    this.syncEngine = new SyncEngine(this.app, this.settings);
    this.fileWatcher = new FileWatcher(this.app, this.syncEngine);

    // React to editor keystrokes (debounced inside SyncEngine)
    this.registerEvent(
      this.app.workspace.on('editor-change', (editor, view) => {
        const file = view.file;
        if (file && isSyncablePath(file.path) && !this.syncEngine.isWritingFromRemote(file.path) && !this.syncEngine.isUpdatingEditorFromRemote(file.path)) {
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
        if (!isSyncablePath(abstractFile.path)) return;
        if (this.syncEngine.isWritingFromRemote(abstractFile.path)) return;
        if (this.syncEngine.readCurrentContent(abstractFile.path) !== null) return;
        const content = await this.app.vault.read(abstractFile);
        this.syncEngine.onFileChangedImmediate(abstractFile.path, content);
      })
    );

    // File creation — push immediately
    this.registerEvent(
      this.app.vault.on('create', async (file) => {
        if (!(file instanceof TFile) || !isSyncablePath(file.path)) return;
        if (this.syncEngine.isWritingFromRemote(file.path)) return;
        const content = await this.app.vault.read(file);
        this.syncEngine.onFileChangedImmediate(file.path, content);
      })
    );

    // File deletion — push tombstone + clean up local CRDT
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (!(file instanceof TFile) || !isSyncablePath(file.path)) return;
        if (this.syncEngine.isWritingFromRemote(file.path)) return;
        this.syncEngine.onFileDeleted(file.path);
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
        const oldSync = isSyncablePath(oldPath);
        const newSync = isSyncablePath(file.path);
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

    // Scan for external changes (git pull, Syncthing) when window is focused
    if (Platform.isDesktop) {
      this.registerDomEvent(window, 'focus', () => {
        void this.fileWatcher.scanForExternalChanges();
      });
    }

    this.addSettingTab(new VaultCRDTSettingsTab(this.app, this));
    this.setupStatusBar();

    // Wire up initial sync (auto-detect pull/push/merge)
    this.syncEngine.onInitialSync = (engine) => {
      void this.handleInitialSync(engine);
    };

    // Wait for layout before showing any modal or starting sync
    this.app.workspace.onLayoutReady(() => {
      void this.startWithSetup();
    });

    log('Plugin loaded');
  }

  private async startWithSetup(): Promise<void> {
    const needsSetup = !this.settings.serverUrl || !this.settings.vaultId || !this.settings.vaultSecret;
    if (needsSetup) {
      const result = await new SetupModal(this.app, this.settings).prompt();
      if (result) {
        // Persist only the durable credentials. The optional adminToken
        // is a one-shot used for the very first auth and must never
        // touch disk.
        this.settings.serverUrl = result.serverUrl;
        this.settings.vaultId = result.vaultId;
        this.settings.vaultSecret = result.vaultSecret;
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
    } catch (err) {
      error('initialSync error:', err);
      new Notice('VaultCRDT: Sync failed — see console for details');
    }
  }

  private async runSyncWithProgress(engine: SyncEngine, mode: SyncMode, forceNotice = false): Promise<void> {
    let notice = null as Notice | null;
    try {
      await engine.initialSync((done, total, changed) => {
        if (forceNotice || changed >= 5) {
          if (!notice) notice = new Notice('VaultCRDT: Starting sync...', 0);
          notice.setMessage(`VaultCRDT: Syncing ${done}/${total} (${changed} changed)...`);
        }
      }, mode);
      if (notice) {
        notice.hide();
        new Notice('VaultCRDT: Sync complete', 3000);
      }
    } catch (err) {
      notice?.hide();
      new Notice('VaultCRDT: Sync failed', 5000);
      throw err;
    }
  }

  private setupStatusBar(): void {
    this.syncEngine.statusCallback = (status) => {
      if (!this.statusBarEl) return;
      if (status === 'offline' || status === 'error') {
        this.clearActivityTimer();
        this.setStatusBarConnected(false);
      }
      // 'connected' and 'syncing' are ignored here — only actual server
      // responses (via onServerActivity) flip the indicator to ●.
    };
    this.syncEngine.onServerActivity = () => {
      if (!this.statusBarEl) return;
      this.setStatusBarConnected(true);
      this.resetActivityTimer();
    };
    this.updateStatusBar();
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
    this.activityTimer = setTimeout(() => {
      this.setStatusBarConnected(false);
    }, ACTIVITY_TIMEOUT_MS);
  }

  private clearActivityTimer(): void {
    if (this.activityTimer) {
      clearTimeout(this.activityTimer);
      this.activityTimer = null;
    }
  }

  private setStatusBarConnected(connected: boolean): void {
    if (!this.statusBarEl) return;
    this.statusBarEl.empty();
    this.statusBarEl.appendText('sync\u2002');
    const dot = this.statusBarEl.createSpan({ text: connected ? '●' : '○' });
    dot.style.fontSize = '0.55em';
    dot.style.position = 'relative';
    dot.style.top = '0.05em';
    this.statusBarEl.setAttribute('aria-label', connected ? 'VaultCRDT: connected' : 'VaultCRDT: not connected');
    this.statusBarEl.style.color = connected ? 'var(--text-muted)' : 'var(--text-faint)';
  }

  async onunload(): Promise<void> {
    this.clearActivityTimer();
    await this.syncEngine.stop();
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
    // open, which is too late — see gpt-audit/conflict-storm-plan.md §3B.
    if (ensureDeviceIdentity(this.settings)) {
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

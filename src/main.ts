import { Plugin, Platform, TFile, Notice } from 'obsidian';
import { VaultCRDTSettings, VaultCRDTSettingsTab, DEFAULT_SETTINGS } from './settings';
import { initWasm } from './wasm-bridge';
import { SyncEngine } from './sync-engine';
import type { SyncMode } from './sync-engine';
import { FileWatcherV2 } from './file-watcher';
import { OnboardingModal } from './onboarding-modal';
import { log, error } from './logger';

export default class VaultCRDTPlugin extends Plugin {
  settings!: VaultCRDTSettings;
  syncEngine!: SyncEngine;
  fileWatcher!: FileWatcherV2;
  async onload(): Promise<void> {
    await this.loadSettings();
    await initWasm();

    this.syncEngine = new SyncEngine(this.app, this.settings);
    this.fileWatcher = new FileWatcherV2(this.app, this.syncEngine);

    // React to editor keystrokes (debounced inside SyncEngine)
    this.registerEvent(
      this.app.workspace.on('editor-change', (editor, view) => {
        const file = view.file;
        if (file && !this.syncEngine.isWritingFromRemote(file.path) && !this.syncEngine.isUpdatingEditorFromRemote(file.path)) {
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
        if (this.syncEngine.isWritingFromRemote(abstractFile.path)) return;
        if (this.syncEngine.readCurrentContent(abstractFile.path) !== null) return;
        const content = await this.app.vault.read(abstractFile);
        this.syncEngine.onFileChangedImmediate(abstractFile.path, content);
      })
    );

    // File creation — push immediately
    this.registerEvent(
      this.app.vault.on('create', async (file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        if (this.syncEngine.isWritingFromRemote(file.path)) return;
        const content = await this.app.vault.read(file);
        this.syncEngine.onFileChangedImmediate(file.path, content);
      })
    );

    // File deletion — push tombstone + clean up local CRDT
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (!(file instanceof TFile)) return;
        if (this.syncEngine.isWritingFromRemote(file.path)) return;
        this.syncEngine.onFileDeleted(file.path);
      })
    );

    // File rename — tombstone old path, push under new path
    this.registerEvent(
      this.app.vault.on('rename', async (file, oldPath) => {
        if (file instanceof TFile && file.extension === 'md') {
          const content = await this.app.vault.read(file);
          this.syncEngine.onFileRenamed(oldPath, file.path, content);
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

    // Wire up onboarding modal + progress notice
    this.syncEngine.onInitialSync = (engine) => {
      void this.handleInitialSync(engine);
    };

    // Start: authenticate + connect (fire-and-forget, non-blocking)
    this.syncEngine.start().catch((err) =>
      error('start error:', err)
    );

    log('Plugin loaded');
  }

  private async handleInitialSync(engine: SyncEngine): Promise<void> {
    try {
      let mode: SyncMode = 'merge';
      const isOnboarding = !this.settings.onboardingComplete;

      if (isOnboarding) {
        // Check if this looks like a fresh device
        const { docs: serverDocs } = await engine.requestDocList();
        const localFiles = this.app.vault.getMarkdownFiles();

        // Fresh device heuristic: server has docs and we have no persisted CRDT state
        // (or very little). Show onboarding modal.
        if (serverDocs.length > 0 || localFiles.length > 0) {
          const modal = new OnboardingModal(this.app, serverDocs.length, localFiles.length);
          mode = await modal.prompt();
        }

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

  async onunload(): Promise<void> {
    await this.syncEngine.stop();
    log('Plugin unloaded');
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

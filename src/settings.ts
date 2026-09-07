import { App, Modal, Platform, PluginSettingTab, Setting, requestUrl, Notice } from 'obsidian';
import type VaultCRDTPlugin from './main';
import { validateServerUrl, toHttpBase, normalizeServerUrl } from './url-policy';
import { SetupModal } from './setup-modal';
import { TRUST_NOTICE_TEXT, protocolHealthText, SETUP_COPY, OBSIDIAN_SYNC_COPY, SETTINGS_COPY, vaultSecretSetting, PLUGIN_REPO } from './user-facing-copy';
import { EDIT_DEBOUNCE_MS } from './push-handler';

/**
 * Guard before re-hydrating the active file after catch-up (main.ts). Lives
 * here so the settings tab can display it without importing main.ts (cycle).
 */
export const HYDRATION_DEBOUNCE_MS = 2000;
import { PROTOCOL_VERSION, jsonOf } from './protocol';
import { redact } from './logger';
import type { ObsidianSyncEnabled } from './path-policy';

export interface VaultCRDTSettings {
  serverUrl: string;
  vaultSecret: string;
  /**
   * Per-device key issued by POST /invite/redeem (S1b). When set, the engine
   * authenticates via /auth/device instead of the shared secret. Persisted in
   * data.json, never printed, never sent anywhere but /auth/device.
   */
  deviceKey?: string;
  peerId: string;
  vaultId: string;
  deviceName: string;
  showSyncStatus: boolean;
  onboardingComplete: boolean;
  /** Per-device .obsidian blob-lane categories. Defaults OFF (data.json is per-device). */
  obsidianSync?: ObsidianSyncEnabled;
}

export const DEFAULT_SETTINGS: VaultCRDTSettings = {
  serverUrl: '',
  vaultSecret: '',
  deviceKey: '',
  peerId: '',
  vaultId: '',
  deviceName: '',
  showSyncStatus: true,
  onboardingComplete: false,
  obsidianSync: { settings: false, styles: false },
};

/**
 * UUID v4 without `crypto.randomUUID()`: older embedded WebViews (Amazon
 * WebView 84 / Chromium < 92, common on Fire tablets) lack the API and the
 * plugin dies at load time without this fallback. getRandomValues is
 * available everywhere WebAssembly is (measured 2026-09-06: plugin toggle
 * sprang back on Fire HD 10 / WebView v84).
 */
export function uuidV4Compat(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function defaultDeviceName(): string {
  if (Platform.isDesktopApp) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- desktop-only Node lookup, guarded by Platform.isDesktopApp
      const os = require('os') as { hostname: () => string; userInfo: () => { username: string } };
      const user = os.userInfo().username;
      const host = os.hostname();
      return `${user}@${host}`;
    } catch { /* fallback */ }
  }
  if (Platform.isMobileApp) return 'mobile';
  return 'device';
}

/**
 * Startup invariant: ensure peerId and deviceName exist on the settings
 * object before the SyncEngine is constructed. Returns true if any field
 * was filled in (caller is then expected to persist).
 *
 * Pure helper — no I/O, no Plugin reference — so it can be unit-tested
 * directly without mocking the full plugin lifecycle.
 */
export function ensureDeviceIdentity(
  settings: VaultCRDTSettings,
  genPeerId: () => string = uuidV4Compat,
  genDeviceName: () => string = defaultDeviceName,
): boolean {
  let changed = false;
  if (!settings.peerId) {
    settings.peerId = genPeerId();
    changed = true;
  }
  if (!settings.deviceName) {
    settings.deviceName = genDeviceName();
    changed = true;
  }
  return changed;
}

/**
 * Device-identity reset (vault-clone hygiene): assign the settings object a
 * fresh, non-empty peerId that differs from the current one. Pure — the caller
 * persists it and rebuilds the SyncEngine so DocumentManager / StartupDirtyTracker
 * (which capture peerId at construction) pick up the new identity. Returns both
 * ids; the old one is handy for logging.
 */
export function regeneratePeerId(
  settings: VaultCRDTSettings,
  genPeerId: () => string = uuidV4Compat,
): { oldPeerId: string; newPeerId: string } {
  const oldPeerId = settings.peerId;
  let newPeerId = genPeerId();
  // Guard the degenerate case (an empty result, or the astronomically
  // unlikely UUID collision) so the reset can never silently no-op.
  if (!newPeerId || newPeerId === oldPeerId) {
    newPeerId = genPeerId();
  }
  settings.peerId = newPeerId;
  return { oldPeerId, newPeerId };
}

/**
 * Confirmation dialog for the destructive "Reset device identity" action.
 * Mirrors the SetupModal prompt() pattern: open() runs onOpen(), the buttons
 * resolve the promise, onClose() defaults to "cancel".
 */
class ConfirmResetIdentityModal extends Modal {
  private resolve: ((confirmed: boolean) => void) | null = null;

  prompt(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Reset device identity?' });
    contentEl.createEl('p', {
      text:
        'This device gets a brand-new peer identity. Use it only after copying '
        + 'or restoring this vault from another device, and run it on exactly '
        + 'ONE of the two devices. Your notes and local CRDT history are kept — '
        + 'only the sync identity changes.',
      cls: 'setting-item-description',
    });
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText('Cancel').onClick(() => this.done(false))
      )
      .addButton((btn) =>
        btn.setButtonText('Reset identity').setWarning().onClick(() => this.done(true))
      );
  }

  private done(confirmed: boolean): void {
    this.resolve?.(confirmed);
    this.resolve = null;
    this.close();
  }

  onClose(): void {
    this.resolve?.(false);
    this.resolve = null;
    this.contentEl.empty();
  }
}

/** Shared destructive reconfigure step; setup links always request a wipe. */
export async function resetConnectionState(plugin: VaultCRDTPlugin, wipe: boolean): Promise<void> {
  await plugin.syncEngine.stop();
  if (wipe) await plugin.syncEngine.wipeLocalState();
  // A device key is bound to the old vault/device pair — never carry it over.
  plugin.settings.deviceKey = '';
  plugin.settings.onboardingComplete = false;
}

export class VaultCRDTSettingsTab extends PluginSettingTab {
  plugin: VaultCRDTPlugin;
  private reconnectTimer: number | null = null;
  private urlResetTimer: number | null = null;

  constructor(app: App, plugin: VaultCRDTPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => {
      void this.plugin.syncEngine.restart();
    }, 1500);
  }

  /** B5: URL changes are identity-bound — same reset as Reconfigure, not a bare restart. */
  private scheduleServerUrlReset(): void {
    if (this.urlResetTimer) window.clearTimeout(this.urlResetTimer);
    this.urlResetTimer = window.setTimeout(() => {
      void this.applyServerUrlChange();
    }, 1500);
  }

  private async applyServerUrlChange(): Promise<void> {
    await resetConnectionState(this.plugin, false);
    await this.plugin.saveSettings();
    try {
      await this.plugin.syncEngine.start();
    } catch (err) {
      new Notice(redact(`VaultCRDT: reconnect failed — ${(err as Error).message}`), 8000);
    }
    this.display();
  }

  /**
   * Open the SetupModal pre-filled with the current settings, then
   * re-wire the SyncEngine. When the user picks a *different* vault
   * we also wipe the local CRDT state, because StateStorage keys only
   * by file path and would otherwise leak the old vault's snapshots.
   */
  private async runReconfigure(): Promise<void> {
    const oldVaultId = this.plugin.settings.vaultId;
    const result = await new SetupModal(this.app, this.plugin.settings).prompt();
    if (!result) return;

    await resetConnectionState(this.plugin, result.vaultId !== oldVaultId);

    this.plugin.settings.serverUrl = result.serverUrl;
    this.plugin.settings.vaultId = result.vaultId;
    this.plugin.settings.vaultSecret = result.vaultSecret;
    this.plugin.settings.deviceKey = result.deviceKey ?? '';
    // Re-run the pull/push/merge auto-detection on next start.
    this.plugin.settings.onboardingComplete = false;
    await this.plugin.saveSettings();

    if (result.adminToken) {
      this.plugin.syncEngine.setOneShotAdminToken(result.adminToken);
    }

    try {
      await this.plugin.syncEngine.start();
      // Quiet mode (design §E): success is visible in the status panel/bar.
    } catch (err) {
      new Notice(redact(`VaultCRDT: reconnect failed — ${(err as Error).message}`), 8000);
    }

    this.display();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Note: peerId and deviceName are guaranteed to exist by main.ts
    // loadSettings() — this tab is view/edit only, never the source of truth.

    // ── Connection ────────────────────────────────────────────────────────
    new Setting(containerEl).setName(SETTINGS_COPY.connection).setHeading();

    new Setting(containerEl)
      .setName('Server')
      .setDesc(SETTINGS_COPY.serverUrlDesc)
      .addText((text) =>
        text
          .setPlaceholder('https://obsidian-sync.example.com')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            const raw = value.trim();
            // Allow an empty field (user clearing the input) without
            // spamming Notices, but reject any non-empty invalid URL here
            // so we never persist something the SyncEngine will later refuse.
            if (raw.length > 0) {
              const check = validateServerUrl(raw);
              if (!check.ok) {
                new Notice(redact(`VaultCRDT: ${check.reason}`), 6000);
                return;
              }
            }
            this.plugin.settings.serverUrl = normalizeServerUrl(raw);
            await this.plugin.saveSettings();
            this.scheduleServerUrlReset();
          })
      );

    const statusSetting = new Setting(containerEl)
      .setName(SETTINGS_COPY.statusName)
      .setDesc(SETTINGS_COPY.statusChecking);
    void this.showConnectionStatus(statusSetting);

    {
      const secret = vaultSecretSetting(this.plugin.settings.deviceKey);
      const secretRow = new Setting(containerEl)
        .setName(secret.name)
        .setDesc(secret.desc);
      if (secret.usesTextField) {
        secretRow.addText((text) => {
          text
            .setPlaceholder(secret.placeholder)
            .setValue(this.plugin.settings.vaultSecret)
            .onChange(async (value) => {
              this.plugin.settings.vaultSecret = value;
              await this.plugin.saveSettings();
              this.scheduleReconnect();
            });
          text.inputEl.type = 'password';
          return text;
        });
      } else {
        secretRow.controlEl.createSpan({ text: secret.readonlyLine });
      }
    }

    new Setting(containerEl)
      .setName('Device name')
      .setDesc('Shown in server logs and to other connected devices. Auto-detected from your system.')
      .addText((text) =>
        text
          .setPlaceholder(defaultDeviceName())
          .setValue(this.plugin.settings.deviceName)
          .onChange(async (value) => {
            this.plugin.settings.deviceName = value;
            await this.plugin.saveSettings();
          })
      );

    // Visible entry point for the existing `invite-device` command.
    new Setting(containerEl)
      .setName(SETTINGS_COPY.addDevice)
      .setDesc(SETTINGS_COPY.addDeviceDesc)
      .addButton((btn) =>
        btn.setButtonText(SETTINGS_COPY.addDeviceButton).setCta().onClick(() => {
          this.plugin.openInviteModal();
        })
      );

    new Setting(containerEl)
      .setName(SETTINGS_COPY.joinDifferentVault)
      .setDesc('Run setup again — useful when switching to a new vault or registering one with an admin token.')
      .addButton((btn) =>
        btn.setButtonText(SETTINGS_COPY.openSetup).onClick(async () => {
          await this.runReconfigure();
        })
      );

    // ── Sync ──────────────────────────────────────────────────────────────
    new Setting(containerEl).setName(SETTINGS_COPY.sync).setHeading();

    new Setting(containerEl)
      .setName('Status bar indicator')
      .setDesc('Show a small sync status icon in the bottom status bar')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showSyncStatus).onChange(async (value) => {
          this.plugin.settings.showSyncStatus = value;
          await this.plugin.saveSettings();
          this.plugin.updateStatusBar();
        })
      );

    new Setting(containerEl)
      .setName(SETTINGS_COPY.keepSettings)
      .setDesc(`${OBSIDIAN_SYNC_COPY.settingsDesc} ${OBSIDIAN_SYNC_COPY.neverSyncs}`)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.obsidianSync?.settings ?? false).onChange(async (value) => {
          this.plugin.settings.obsidianSync = {
            settings: value,
            styles: this.plugin.settings.obsidianSync?.styles ?? false,
          };
          await this.plugin.saveSettings();
          await this.plugin.applyObsidianSyncToggle('settings', value);
        })
      );

    new Setting(containerEl)
      .setName(SETTINGS_COPY.carryStyles)
      .setDesc(OBSIDIAN_SYNC_COPY.stylesDesc)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.obsidianSync?.styles ?? false).onChange(async (value) => {
          this.plugin.settings.obsidianSync = {
            settings: this.plugin.settings.obsidianSync?.settings ?? false,
            styles: value,
          };
          await this.plugin.saveSettings();
          await this.plugin.applyObsidianSyncToggle('styles', value);
        })
      );

    const syncSetting = new Setting(containerEl)
      .setName(SETTINGS_COPY.fullSync)
      .setDesc(SETTINGS_COPY.fullSyncDesc)
      .addButton((btn) =>
        btn.setButtonText(SETTINGS_COPY.runFullSync).onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText('Syncing...');
          try {
            await this.plugin.syncEngine.initialSync((done, total) => {
              syncSetting.setDesc(`${done} / ${total}`);
            });
            syncSetting.setDesc(SETTINGS_COPY.fullSyncDesc);
            btn.setButtonText('Done');
          } catch {
            btn.setButtonText('Failed');
          } finally {
            window.setTimeout(() => {
              btn.setDisabled(false);
              btn.setButtonText(SETTINGS_COPY.runFullSync);
            }, 2000);
          }
        })
      );

    // ── About ─────────────────────────────────────────────────────────────
    new Setting(containerEl).setName(SETTINGS_COPY.about).setHeading();

    new Setting(containerEl)
      .setName('Plugin version')
      .setDesc(`v${this.plugin.manifest.version}`);

    const serverSetting = new Setting(containerEl)
      .setName('Server')
      .setDesc(SETTINGS_COPY.statusChecking);
    void this.showServerAbout(serverSetting);

    new Setting(containerEl)
      .setName(SETTINGS_COPY.documentation)
      .setDesc(SETTINGS_COPY.documentationDesc)
      .addButton((btn) =>
        btn.setButtonText('Open').onClick(() => {
          window.open(`https://github.com/${PLUGIN_REPO}`, '_blank');
        })
      );

    new Setting(containerEl)
      .setName('Privacy and trust')
      .setDesc(TRUST_NOTICE_TEXT);

    // ── Developer ─────────────────────────────────────────────────────────
    const dev = containerEl.createEl('details');
    dev.addClass('vcrdt-developer');
    dev.createEl('summary', { text: SETTINGS_COPY.developer, cls: 'setting-item-heading' });
    const devContainer = dev.createDiv();

    new Setting(devContainer)
      .setName(SETTINGS_COPY.copyDiagnostics)
      .setDesc(SETTINGS_COPY.copyDiagnosticsDesc)
      .addButton((btn) =>
        btn.setButtonText(SETUP_COPY.copy).onClick(async () => {
          btn.setDisabled(true);
          try {
            const report = await this.plugin.collectDiagnosticsReport();
            await navigator.clipboard.writeText(report);
            btn.setButtonText(SETUP_COPY.copied);
          } catch {
            btn.setButtonText(SETUP_COPY.copyFailed);
          } finally {
            btn.setDisabled(false);
          }
        })
      );

    // Read-only constants — displayed, never editable.
    new Setting(devContainer).setName(SETTINGS_COPY.activeConstants).setHeading();
    new Setting(devContainer).setName(SETTINGS_COPY.editDebounce).setDesc(`${EDIT_DEBOUNCE_MS} ms`);
    new Setting(devContainer).setName(SETTINGS_COPY.hydrationDebounce).setDesc(`${HYDRATION_DEBOUNCE_MS} ms`);
    new Setting(devContainer).setName(SETTINGS_COPY.attachmentCaps).setDesc(SETTINGS_COPY.attachmentCapsValue);
    new Setting(devContainer)
      .setName(SETTINGS_COPY.protocolVersionName)
      .setDesc(protocolHealthText(this.plugin.serverFeatures.protocolVersion(), PROTOCOL_VERSION));

    new Setting(devContainer)
      .setName('Peer ID')
      .setDesc(`Unique identifier for this device: ${this.plugin.settings.peerId}`)
      .addButton((btn) =>
        btn.setButtonText(SETUP_COPY.copy).onClick(() => {
          void navigator.clipboard.writeText(this.plugin.settings.peerId);
          btn.setButtonText(SETUP_COPY.copied);
        })
      );

    new Setting(devContainer)
      .setName(SETUP_COPY.vault)
      .setDesc(
        this.plugin.settings.vaultId
          ? `${this.plugin.settings.vaultId}. ${SETTINGS_COPY.vaultIdSwitch}`
          : SETTINGS_COPY.vaultIdSwitch,
      )
      .addButton((btn) =>
        btn.setButtonText(SETUP_COPY.copy).onClick(() => {
          void navigator.clipboard.writeText(this.plugin.settings.vaultId);
          btn.setButtonText(SETUP_COPY.copied);
        })
      );

    const storageDetails = devContainer.createEl('details');
    storageDetails.createEl('summary', { text: 'Storage info', cls: 'setting-item-heading' });
    void this.loadStorageInfo(storageDetails.createDiv());

    const devicesDetails = devContainer.createEl('details');
    devicesDetails.createEl('summary', { text: 'Synced devices', cls: 'setting-item-heading' });
    void this.loadPeers(devicesDetails.createDiv());

    new Setting(devContainer)
      .setName('Reset device identity')
      .setDesc(
        'Give this device a fresh peer identity. Use after copying or restoring '
        + 'this vault from another device — run on exactly ONE of them. Notes and '
        + 'local CRDT history are kept; only the sync identity changes.'
      )
      .addButton((btn) =>
        btn.setButtonText('Reset identity').setWarning().onClick(async () => {
          const confirmed = await new ConfirmResetIdentityModal(this.app).prompt();
          if (!confirmed) return;
          btn.setDisabled(true);
          try {
            const newPeerId = await this.plugin.resetDeviceIdentity();
            new Notice(redact(`VaultCRDT: device identity reset — new Peer ID ${newPeerId}`), 8000);
          } catch (err) {
            new Notice(redact(`VaultCRDT: reset failed — ${(err as Error).message}`), 8000);
          } finally {
            this.display();
          }
        })
      );
  }

  /** Plain-language connection line; same /health source as the About block. */
  private async showConnectionStatus(setting: Setting): Promise<void> {
    if (!this.plugin.settings.serverUrl || !this.plugin.settings.vaultId) {
      setting.setDesc('Not connected — no server configured yet.');
      return;
    }
    try {
      const httpBase = toHttpBase(this.plugin.settings.serverUrl);
      await requestUrl({ url: `${httpBase}/health`, method: 'GET' });
      const host = new URL(httpBase).host;
      setting.setDesc(redact(`Server reachable (${host})`));
    } catch {
      setting.setDesc('Not connected — the server did not answer.');
    }
  }

  /** About block: server version, protocol state and advertised features. */
  private async showServerAbout(setting: Setting): Promise<void> {
    try {
      const httpBase = toHttpBase(this.plugin.settings.serverUrl);
      const resp = await requestUrl({ url: `${httpBase}/health`, method: 'GET' });
      const health = jsonOf<{ version: string; protocol_version: number }>(resp);
      const version = typeof health.version === 'string' ? health.version : '?';
      const pv = typeof health.protocol_version === 'number' ? health.protocol_version : undefined;
      const features = await this.plugin.serverFeatures.get(this.plugin.settings.serverUrl);
      const featureLine = features.length > 0 ? ` · features: ${features.join(', ')}` : '';
      setting.setDesc(redact(`v${version} — ${protocolHealthText(pv, PROTOCOL_VERSION)}${featureLine}`));
    } catch {
      setting.setDesc('Server not reachable');
    }
  }

  private async loadStorageInfo(container: HTMLElement): Promise<void> {
    container.createEl('p', { text: 'Loading...', cls: 'setting-item-description' });

    try {
      // Local stats
      const { loroFiles, syncedDocCount } = await this.plugin.syncEngine.getLocalStorageStats();
      const totalLoroBytes = loroFiles.reduce((sum, [, size]) => sum + size, 0);

      // Vault size (all .md files)
      const mdFiles = this.app.vault.getMarkdownFiles();
      let totalVaultBytes = 0;
      for (const f of mdFiles) {
        totalVaultBytes += f.stat.size;
      }

      const overhead = totalVaultBytes > 0
        ? ((totalLoroBytes / totalVaultBytes) * 100).toFixed(1)
        : '0';

      // Sort by size descending for top 10
      const topFiles = [...loroFiles].sort((a, b) => b[1] - a[1]).slice(0, 10);

      container.empty();
      new Setting(container).setName('Local').setHeading();

      new Setting(container)
        .setName('Synced documents')
        .setDesc(`${syncedDocCount} files`);

      new Setting(container)
        .setName('CRDT state (.loro files)')
        .setDesc(`${loroFiles.length} files, ${formatBytes(totalLoroBytes)}`);

      new Setting(container)
        .setName('Vault size (Markdown)')
        .setDesc(`${mdFiles.length} files, ${formatBytes(totalVaultBytes)}`);

      new Setting(container)
        .setName('CRDT overhead')
        .setDesc(`${overhead}%`);

      if (topFiles.length > 0) {
        new Setting(container).setName('Largest .loro files').setHeading();
        const list = container.createEl('ul', { cls: 'vcrdt-stats-list' });
        for (const [name, size] of topFiles) {
          list.createEl('li', { text: `${name} — ${formatBytes(size)}` });
        }
      }

      // Server stats
      await this.loadServerStats(container);
    } catch (err) {
      container.empty();
      container.createEl('p', { text: redact(`Error loading stats: ${String(err)}`), cls: 'setting-item-description' });
    }
  }

  private async loadPeers(container: HTMLElement): Promise<void> {
    container.createEl('p', { text: 'Loading...', cls: 'setting-item-description' });

    const httpBase = toHttpBase(this.plugin.settings.serverUrl);

    try {
      const authResp = await requestUrl({
        url: `${httpBase}/auth/verify`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vault_id: this.plugin.settings.vaultId,
          api_key: this.plugin.settings.vaultSecret,
        }),
      });
      const token = jsonOf<{ token: string }>(authResp).token;
      if (!token) {
        container.empty();
        container.createEl('p', { text: 'Not authenticated', cls: 'setting-item-description' });
        return;
      }

      const resp = await requestUrl({
        url: `${httpBase}/vault/peers`,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const peers = jsonOf<{ peers: Array<{ peer_id: string; device_name: string; last_seen_at: string }> }>(resp).peers ?? [];

      container.empty();

      if (peers.length === 0) {
        container.createEl('p', { text: 'No devices have synced yet.', cls: 'setting-item-description' });
        return;
      }

      const myPeerId = this.plugin.settings.peerId;
      for (const peer of peers) {
        const isMe = peer.peer_id === myPeerId;
        const name = peer.device_name || peer.peer_id.slice(0, 8);
        const label = isMe ? `${name} (this device)` : name;
        new Setting(container)
          .setName(label)
          .setDesc(`Last synced: ${peer.last_seen_at}`);
      }
    } catch {
      container.empty();
      container.createEl('p', { text: 'Could not load (server unreachable or not authenticated)', cls: 'setting-item-description' });
    }
  }

  private async loadServerStats(container: HTMLElement): Promise<void> {
    const httpBase = toHttpBase(this.plugin.settings.serverUrl);

    try {
      // Authenticate to get JWT
      const authResp = await requestUrl({
        url: `${httpBase}/auth/verify`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vault_id: this.plugin.settings.vaultId,
          api_key: this.plugin.settings.vaultSecret,
        }),
      });
      const token = jsonOf<{ token: string }>(authResp).token;
      if (!token) return;

      const statsResp = await requestUrl({
        url: `${httpBase}/debug/vault-stats`,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const stats = jsonOf<{
        doc_count: number;
        total_snapshot_bytes: number;
        total_vv_bytes: number;
        largest_docs: Array<{ doc_uuid: string; snapshot_bytes: number }>;
      }>(statsResp);

      new Setting(container).setName('Server').setHeading();

      new Setting(container)
        .setName('Documents on server')
        .setDesc(`${stats.doc_count ?? 0} files`);

      new Setting(container)
        .setName('Total snapshot size')
        .setDesc(formatBytes(stats.total_snapshot_bytes ?? 0));

      new Setting(container)
        .setName('Total VV size')
        .setDesc(formatBytes(stats.total_vv_bytes ?? 0));

      if ((stats.largest_docs?.length ?? 0) > 0) {
        new Setting(container).setName('Largest server documents').setHeading();
        const list = container.createEl('ul', { cls: 'vcrdt-stats-list' });
        for (const doc of stats.largest_docs ?? []) {
          list.createEl('li', { text: `${doc.doc_uuid} — ${formatBytes(doc.snapshot_bytes)}` });
        }
      }
    } catch {
      new Setting(container)
        .setName('Server stats')
        .setDesc('Could not load (server unreachable or not authenticated)');
    }
  }

}

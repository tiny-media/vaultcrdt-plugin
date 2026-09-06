import { App, Modal, Platform, PluginSettingTab, Setting, requestUrl, Notice } from 'obsidian';
import type VaultCRDTPlugin from './main';
import { validateServerUrl, toHttpBase, normalizeServerUrl } from './url-policy';
import { SetupModal } from './setup-modal';
import { TRUST_NOTICE_TEXT, protocolHealthText, SETUP_COPY } from './user-facing-copy';
import { PROTOCOL_VERSION, jsonOf } from './protocol';
import { redact } from './logger';

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
  debounceMs: number;
  showSyncStatus: boolean;
  onboardingComplete: boolean;
}

export const DEFAULT_SETTINGS: VaultCRDTSettings = {
  serverUrl: '',
  vaultSecret: '',
  deviceKey: '',
  peerId: '',
  vaultId: '',
  deviceName: '',
  debounceMs: 700,
  showSyncStatus: true,
  onboardingComplete: false,
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

    const pluginVersion: string = this.plugin.manifest.version;

    // ── Status ────────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Status').setHeading();

    new Setting(containerEl)
      .setName('Plugin version')
      .setDesc(`v${pluginVersion}`);

    const healthSetting = new Setting(containerEl)
      .setName('Server status')
      .setDesc('Checking...');
    void this.checkServerHealth(healthSetting);

    // ── Storage Info ──────────────────────────────────────────────────────
    const storageDetails = containerEl.createEl('details');
    storageDetails.createEl('summary', { text: 'Storage Info', cls: 'setting-item-heading' });
    const storageContainer = storageDetails.createDiv();
    void this.loadStorageInfo(storageContainer);

    // ── Connection ────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Connection').setHeading();

    new Setting(containerEl)
      .setName('Privacy and trust')
      .setDesc(TRUST_NOTICE_TEXT);

    new Setting(containerEl)
      .setName('Server')
      .setDesc('Address of your VaultCRDT server. WebSocket connection is derived automatically.')
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
            this.scheduleReconnect();
          })
      );

    new Setting(containerEl)
      .setName('Vault Name')
      .setDesc(this.plugin.settings.vaultId
        ? `Connected to: ${this.plugin.settings.vaultId}`
        : 'Not configured — enable the plugin to run Setup');

    new Setting(containerEl)
      .setName('Password')
      .setDesc('Shared password for this vault. Must be identical on every device that syncs this vault.')
      .addText((text) => {
        text
          .setPlaceholder('vault password')
          .setValue(this.plugin.settings.vaultSecret)
          .onChange(async (value) => {
            this.plugin.settings.vaultSecret = value;
            await this.plugin.saveSettings();
            this.scheduleReconnect();
          });
        text.inputEl.type = 'password';
        return text;
      });

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

    new Setting(containerEl)
      .setName('Reconnect to a different vault')
      .setDesc('Run setup again — useful when switching to a new vault or registering one with an admin token.')
      .addButton((btn) =>
        btn.setButtonText('Reconfigure').onClick(async () => {
          await this.runReconfigure();
        })
      );

    // ── Synced Devices ────────────────────────────────────────────────────
    const devicesDetails = containerEl.createEl('details');
    devicesDetails.createEl('summary', { text: 'Synced Devices', cls: 'setting-item-heading' });
    const devicesContainer = devicesDetails.createDiv();
    void this.loadPeers(devicesContainer);

    // ── Sync ──────────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Sync').setHeading();

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
      .setName('Sync delay')
      .setDesc('How long to wait after your last keystroke before sending changes (300–2000 ms)')
      .addSlider((slider) =>
        slider
          .setLimits(300, 2000, 50)
          .setValue(this.plugin.settings.debounceMs)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.debounceMs = value;
            await this.plugin.saveSettings();
          })
      );

    const syncSetting = new Setting(containerEl)
      .setName('Force full sync')
      .setDesc('Re-sync everything: pull all documents from the server and push all local files')
      .addButton((btn) =>
        btn.setButtonText('Sync now').onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText('Syncing...');
          try {
            await this.plugin.syncEngine.initialSync((done, total) => {
              syncSetting.setDesc(`${done} / ${total}`);
            });
            syncSetting.setDesc('Re-sync everything: pull all documents from the server and push all local files');
            btn.setButtonText('Done!');
          } catch {
            btn.setButtonText('Failed');
          } finally {
            window.setTimeout(() => {
              btn.setDisabled(false);
              btn.setButtonText('Sync now');
            }, 2000);
          }
        })
      );

    // ── Advanced ────────────────────────────────────────────────────────────
    const details = containerEl.createEl('details');
    details.createEl('summary', { text: 'Advanced', cls: 'setting-item-heading' });

    const advancedContainer = details.createDiv();

    new Setting(advancedContainer)
      .setName('Peer ID')
      .setDesc(`Unique identifier for this device: ${this.plugin.settings.peerId}`)
      .addButton((btn) =>
        btn.setButtonText(SETUP_COPY.copy).onClick(() => {
          void navigator.clipboard.writeText(this.plugin.settings.peerId);
          btn.setButtonText(SETUP_COPY.copied);
        })
      );

    new Setting(advancedContainer)
      .setName('Vault Name')
      .setDesc('Identifies this vault on the server. Changing this reconnects to a different vault.')
      .addText((text) =>
        text
          .setPlaceholder('my-notes')
          .setValue(this.plugin.settings.vaultId)
          .onChange(async (value) => {
            this.plugin.settings.vaultId = value.toLowerCase().trim();
            await this.plugin.saveSettings();
            this.scheduleReconnect();
          })
      )
      .addButton((btn) =>
        btn.setButtonText(SETUP_COPY.copy).onClick(() => {
          void navigator.clipboard.writeText(this.plugin.settings.vaultId);
          btn.setButtonText(SETUP_COPY.copied);
        })
      );

    // ── Danger Zone ─────────────────────────────────────────────────────────
    new Setting(advancedContainer)
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

  private async checkServerHealth(setting: Setting): Promise<void> {
    try {
      const httpBase = toHttpBase(this.plugin.settings.serverUrl);
      const resp = await requestUrl({ url: `${httpBase}/health`, method: 'GET' });
      const health = jsonOf<{ version: string; protocol_version: number }>(resp);
      const version = typeof health.version === 'string' ? health.version : '?';
      const pv = typeof health.protocol_version === 'number' ? health.protocol_version : undefined;
      setting.setDesc(redact(`Server reachable (server v${version}) — ${protocolHealthText(pv, PROTOCOL_VERSION)}`));
    } catch {
      setting.setDesc('Server not reachable');
    }
  }
}

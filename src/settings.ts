import { App, Platform, PluginSettingTab, Setting, requestUrl, Notice } from 'obsidian';
import type VaultCRDTPlugin from './main';

export interface VaultCRDTSettings {
  serverUrl: string;
  registrationKey: string;
  vaultSecret: string;
  peerId: string;
  vaultId: string;
  deviceName: string;
  debounceMs: number;
  showSyncStatus: boolean;
  onboardingComplete: boolean;
}

export const DEFAULT_SETTINGS: VaultCRDTSettings = {
  serverUrl: 'http://localhost:3737',
  registrationKey: '',
  vaultSecret: '',
  peerId: '',
  vaultId: '',
  deviceName: '',
  debounceMs: 700,
  showSyncStatus: true,
  onboardingComplete: false,
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function defaultDeviceName(): string {
  if (Platform.isDesktopApp) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const os = require('os') as { hostname: () => string; userInfo: () => { username: string } };
      const user = os.userInfo().username;
      const host = os.hostname();
      return `${user}@${host}`;
    } catch { /* fallback */ }
  }
  if (Platform.isMobileApp) return 'mobile';
  return 'device';
}

export class VaultCRDTSettingsTab extends PluginSettingTab {
  plugin: VaultCRDTPlugin;

  constructor(app: App, plugin: VaultCRDTPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Auto-generate IDs and device name if empty
    let needsSave = false;
    if (!this.plugin.settings.peerId) {
      this.plugin.settings.peerId = crypto.randomUUID();
      needsSave = true;
    }
    if (!this.plugin.settings.vaultId) {
      this.plugin.settings.vaultId = crypto.randomUUID();
      needsSave = true;
    }
    if (!this.plugin.settings.deviceName) {
      this.plugin.settings.deviceName = defaultDeviceName();
      needsSave = true;
    }
    if (needsSave) void this.plugin.saveSettings();

    const pluginVersion: string = this.plugin.manifest.version;

    // ── Status ────────────────────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Status' });

    new Setting(containerEl)
      .setName('Plugin version')
      .setDesc(`v${pluginVersion}`);

    const healthSetting = new Setting(containerEl)
      .setName('Server status')
      .setDesc('Checking...');
    this.checkServerHealth(healthSetting);

    // ── Storage Info ──────────────────────────────────────────────────────
    const storageDetails = containerEl.createEl('details');
    storageDetails.createEl('summary', { text: 'Storage Info', cls: 'setting-item-heading' });
    const storageContainer = storageDetails.createDiv();
    this.loadStorageInfo(storageContainer);

    // ── Connection ────────────────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Connection' });

    new Setting(containerEl)
      .setName('Server')
      .setDesc('Address of your VaultCRDT server. WebSocket connection is derived automatically.')
      .addText((text) =>
        text
          .setPlaceholder('https://obsidian-sync.example.com')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Admin Token')
      .setDesc('Only needed once when setting up a new vault. Your server admin can provide this.')
      .addText((text) => {
        text
          .setPlaceholder('admin token')
          .setValue(this.plugin.settings.registrationKey)
          .onChange(async (value) => {
            this.plugin.settings.registrationKey = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'password';
        return text;
      });

    new Setting(containerEl)
      .setName('Vault Secret')
      .setDesc('Shared secret for this vault. Must be identical on every device that syncs this vault.')
      .addText((text) => {
        text
          .setPlaceholder('vault secret')
          .setValue(this.plugin.settings.vaultSecret)
          .onChange(async (value) => {
            this.plugin.settings.vaultSecret = value;
            await this.plugin.saveSettings();
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

    // ── Synced Devices ────────────────────────────────────────────────────
    const devicesDetails = containerEl.createEl('details');
    devicesDetails.createEl('summary', { text: 'Synced Devices', cls: 'setting-item-heading' });
    const devicesContainer = devicesDetails.createDiv();
    this.loadPeers(devicesContainer);

    // ── Sync ──────────────────────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Sync' });

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
            setTimeout(() => {
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
        btn.setButtonText('Copy').onClick(() => {
          void navigator.clipboard.writeText(this.plugin.settings.peerId);
          new Notice('Peer ID copied');
        })
      );

    new Setting(advancedContainer)
      .setName('Vault ID')
      .setDesc(`Identifies this vault on the server: ${this.plugin.settings.vaultId}`)
      .addButton((btn) =>
        btn.setButtonText('Copy').onClick(() => {
          void navigator.clipboard.writeText(this.plugin.settings.vaultId);
          new Notice('Vault ID copied');
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
      container.createEl('h3', { text: 'Local' });

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
        container.createEl('h4', { text: 'Largest .loro files' });
        const list = container.createEl('ul', { cls: 'vcrdt-stats-list' });
        for (const [name, size] of topFiles) {
          list.createEl('li', { text: `${name} — ${formatBytes(size)}` });
        }
      }

      // Server stats
      await this.loadServerStats(container);
    } catch (err) {
      container.empty();
      container.createEl('p', { text: `Error loading stats: ${err}`, cls: 'setting-item-description' });
    }
  }

  private async loadPeers(container: HTMLElement): Promise<void> {
    container.createEl('p', { text: 'Loading...', cls: 'setting-item-description' });

    const httpBase = this.plugin.settings.serverUrl
      .replace(/^ws:\/\//, 'http://')
      .replace(/^wss:\/\//, 'https://');

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
      const token: string = authResp.json?.token;
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
      const peers: Array<{ peer_id: string; device_name: string; last_seen_at: string }> = resp.json?.peers ?? [];

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
    const httpBase = this.plugin.settings.serverUrl
      .replace(/^ws:\/\//, 'http://')
      .replace(/^wss:\/\//, 'https://');

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
      const token: string = authResp.json?.token;
      if (!token) return;

      const statsResp = await requestUrl({
        url: `${httpBase}/debug/vault-stats`,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const stats = statsResp.json;

      container.createEl('h3', { text: 'Server' });

      new Setting(container)
        .setName('Documents on server')
        .setDesc(`${stats.doc_count} files`);

      new Setting(container)
        .setName('Total snapshot size')
        .setDesc(formatBytes(stats.total_snapshot_bytes));

      new Setting(container)
        .setName('Total VV size')
        .setDesc(formatBytes(stats.total_vv_bytes));

      if (stats.largest_docs?.length > 0) {
        container.createEl('h4', { text: 'Largest server documents' });
        const list = container.createEl('ul', { cls: 'vcrdt-stats-list' });
        for (const doc of stats.largest_docs) {
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
    const httpBase = this.plugin.settings.serverUrl
      .replace(/^ws:\/\//, 'http://')
      .replace(/^wss:\/\//, 'https://');
    try {
      const resp = await requestUrl({ url: `${httpBase}/health`, method: 'GET' });
      const version: string = resp.json?.version ?? '?';
      setting.setDesc(`Server reachable  (server v${version})`);
    } catch {
      setting.setDesc('Server not reachable');
    }
  }
}

import { App, PluginSettingTab, Setting, requestUrl, Notice } from 'obsidian';
import type VaultCRDTPlugin from './main';

export interface VaultCRDTSettings {
  serverUrl: string;
  serverPassword: string;
  apiKey: string;
  peerId: string;
  vaultId: string;
  debounceMs: number;
  syncOnStartup: boolean;
  onboardingComplete: boolean;
}

export const DEFAULT_SETTINGS: VaultCRDTSettings = {
  serverUrl: 'http://localhost:3737',
  serverPassword: '',
  apiKey: '',
  peerId: '',
  vaultId: '',
  debounceMs: 700,
  syncOnStartup: true,
  onboardingComplete: false,
};

const PLUGIN_VERSION = '2.0.2';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
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

    // Auto-generate IDs if empty
    if (!this.plugin.settings.peerId) {
      this.plugin.settings.peerId = crypto.randomUUID();
      void this.plugin.saveSettings();
    }
    if (!this.plugin.settings.vaultId) {
      this.plugin.settings.vaultId = crypto.randomUUID();
      void this.plugin.saveSettings();
    }

    // ── Status & Info ───────────────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Status & Info' });

    new Setting(containerEl)
      .setName('Plugin version')
      .setDesc(`v${PLUGIN_VERSION}`);

    const healthSetting = new Setting(containerEl)
      .setName('Server status')
      .setDesc('Checking...');
    this.checkServerHealth(healthSetting);

    new Setting(containerEl)
      .setName('Vault ID')
      .setDesc(this.plugin.settings.vaultId)
      .addButton((btn) =>
        btn.setButtonText('Copy').onClick(() => {
          void navigator.clipboard.writeText(this.plugin.settings.vaultId);
          new Notice('Vault ID copied to clipboard');
        })
      );

    new Setting(containerEl)
      .setName('Peer ID')
      .setDesc(this.plugin.settings.peerId)
      .addButton((btn) =>
        btn.setButtonText('Copy').onClick(() => {
          void navigator.clipboard.writeText(this.plugin.settings.peerId);
          new Notice('Peer ID copied to clipboard');
        })
      );

    // ── Storage Info ──────────────────────────────────────────────────────
    const storageDetails = containerEl.createEl('details');
    storageDetails.createEl('summary', { text: 'Storage Info', cls: 'setting-item-heading' });
    const storageContainer = storageDetails.createDiv();
    this.loadStorageInfo(storageContainer);

    // ── Connection & Sync ───────────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Connection & Sync' });

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('URL of the VaultCRDT sync server (http:// or https://)')
      .addText((text) =>
        text
          .setPlaceholder('http://localhost:3737')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Server Password')
      .setDesc('Required to register a new vault — get this from the server admin')
      .addText((text) => {
        text
          .setPlaceholder('server password')
          .setValue(this.plugin.settings.serverPassword)
          .onChange(async (value) => {
            this.plugin.settings.serverPassword = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'password';
        return text;
      });

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('Your vault key — must match on all devices sharing this vault')
      .addText((text) => {
        text
          .setPlaceholder('my-secret-key')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'password';
        return text;
      });

    new Setting(containerEl)
      .setName('Sync on startup')
      .setDesc('Automatically run a full sync when the plugin loads')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.syncOnStartup = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Debounce (ms)')
      .setDesc('Delay before pushing edits to the server (100–2000)')
      .addSlider((slider) =>
        slider
          .setLimits(100, 2000, 50)
          .setValue(this.plugin.settings.debounceMs)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.debounceMs = value;
            await this.plugin.saveSettings();
          })
      );

    const syncSetting = new Setting(containerEl)
      .setName('Force full sync')
      .setDesc('Pull all server docs and push all local files')
      .addButton((btn) =>
        btn.setButtonText('Sync now').onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText('Syncing...');
          try {
            await this.plugin.syncEngine.initialSync((done, total) => {
              syncSetting.setDesc(`${done} / ${total}`);
            });
            syncSetting.setDesc('Pull all server docs and push all local files');
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
      .setDesc('Changing this will make the server treat this device as a new peer')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.peerId)
          .onChange(async (value) => {
            this.plugin.settings.peerId = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(advancedContainer)
      .setName('Vault ID')
      .setDesc('Must match on all devices sharing this vault')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.vaultId)
          .onChange(async (value) => {
            this.plugin.settings.vaultId = value;
            await this.plugin.saveSettings();
          })
      )
      .addButton((btn) =>
        btn.setButtonText('Generate').onClick(async () => {
          this.plugin.settings.vaultId = crypto.randomUUID();
          await this.plugin.saveSettings();
          this.display();
        })
      )
      .addButton((btn) =>
        btn.setButtonText('Copy').onClick(() => {
          void navigator.clipboard.writeText(this.plugin.settings.vaultId);
          new Notice('Vault ID copied to clipboard');
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
          api_key: this.plugin.settings.apiKey,
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

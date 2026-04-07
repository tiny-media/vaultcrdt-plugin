import { Modal, App, Setting, requestUrl, Notice } from 'obsidian';
import type { VaultCRDTSettings } from './settings';
import { validateServerUrl } from './url-policy';

export interface SetupResult {
  serverUrl: string;
  vaultId: string;
  vaultSecret: string;
}

const VAULT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export class SetupModal extends Modal {
  private resolve: ((result: SetupResult | null) => void) | null = null;
  private serverUrl: string;
  private vaultId: string;
  private vaultSecret: string;
  private errorEl: HTMLElement | null = null;

  constructor(app: App, settings: VaultCRDTSettings) {
    super(app);
    this.serverUrl = settings.serverUrl;
    this.vaultId = settings.vaultId;
    this.vaultSecret = settings.vaultSecret;
  }

  prompt(): Promise<SetupResult | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vcrdt-setup');

    contentEl.createEl('h2', { text: 'VaultCRDT — Setup' });
    contentEl.createEl('p', {
      text: 'Enter the details your server admin gave you.',
      cls: 'setting-item-description',
    });

    // Server URL
    new Setting(contentEl)
      .setName('Server')
      .setDesc('Address of your sync server')
      .addText((text) =>
        text
          .setPlaceholder('https://sync.example.com')
          .setValue(this.serverUrl)
          .onChange((v) => { this.serverUrl = v.trim(); })
      );

    // Vault Name
    new Setting(contentEl)
      .setName('Vault Name')
      .setDesc('Must match on every device that syncs this vault')
      .addText((text) =>
        text
          .setPlaceholder('my-notes')
          .setValue(this.vaultId)
          .onChange((v) => { this.vaultId = v.toLowerCase().trim(); })
      );

    // Password
    new Setting(contentEl)
      .setName('Password')
      .setDesc('Shared password for this vault — same on every device')
      .addText((text) => {
        text
          .setPlaceholder('vault password')
          .setValue(this.vaultSecret)
          .onChange((v) => { this.vaultSecret = v; });
        text.inputEl.type = 'password';
        return text;
      });

    // Error area (hidden by default)
    this.errorEl = contentEl.createEl('p', { cls: 'vcrdt-setup-error' });
    this.errorEl.style.color = 'var(--text-error)';
    this.errorEl.style.fontSize = '0.85em';
    this.errorEl.style.display = 'none';

    // Buttons
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText('Cancel').onClick(() => {
          this.resolve?.(null);
          this.resolve = null;
          this.close();
        })
      )
      .addButton((btn) =>
        btn.setButtonText('Connect').setCta().onClick(() => {
          void this.submit(btn);
        })
      );
  }

  private showError(msg: string): void {
    if (!this.errorEl) return;
    this.errorEl.textContent = msg;
    this.errorEl.style.display = '';
  }

  private hideError(): void {
    if (!this.errorEl) return;
    this.errorEl.style.display = 'none';
  }

  private async submit(btn: { setButtonText: (t: string) => void; setDisabled: (d: boolean) => void }): Promise<void> {
    this.hideError();

    // Client-side validation
    if (!this.serverUrl) {
      this.showError('Server URL is required');
      return;
    }
    const urlCheck = validateServerUrl(this.serverUrl);
    if (!urlCheck.ok) {
      this.showError(urlCheck.reason);
      return;
    }
    if (!VAULT_NAME_RE.test(this.vaultId)) {
      this.showError('Vault Name must be lowercase letters, numbers, or hyphens (e.g. my-notes)');
      return;
    }
    if (!this.vaultSecret) {
      this.showError('Password is required');
      return;
    }

    // Verify credentials against server
    btn.setDisabled(true);
    btn.setButtonText('Connecting...');

    const httpBase = this.serverUrl
      .replace(/^ws:\/\//, 'http://')
      .replace(/^wss:\/\//, 'https://');

    try {
      const resp = await requestUrl({
        url: `${httpBase}/auth/verify`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vault_id: this.vaultId,
          api_key: this.vaultSecret,
        }),
      });

      if (resp.json?.token) {
        this.resolve?.({
          serverUrl: this.serverUrl,
          vaultId: this.vaultId,
          vaultSecret: this.vaultSecret,
        });
        this.resolve = null;
        this.close();
        return;
      }

      this.showError('Unexpected server response. Check the server URL.');
    } catch (e: unknown) {
      // requestUrl throws on non-2xx status codes — extract status from error
      const status = (e as { status?: number })?.status;
      if (status === 401) {
        const msg = String((e as { message?: string })?.message ?? '');
        if (msg.includes('Invalid API key')) {
          this.showError('Wrong password for this vault. Check with your server admin.');
        } else if (msg.includes('Invalid admin token')) {
          this.showError('This vault does not exist on the server. Ask your server admin to create it.');
        } else {
          this.showError('Authentication failed. Check vault name and password.');
        }
      } else if (status) {
        this.showError(`Server returned status ${status}. Check the server URL.`);
      } else {
        this.showError('Could not reach the server. Check the URL and your internet connection.');
      }
    } finally {
      btn.setDisabled(false);
      btn.setButtonText('Connect');
    }
  }

  onClose(): void {
    if (this.resolve) {
      this.resolve(null);
      this.resolve = null;
    }
    this.contentEl.empty();
  }
}

import { Modal, App, Setting, requestUrl } from 'obsidian';
import { defaultDeviceName, type VaultCRDTSettings } from './settings';
import { VAULT_NAME_RE, type SetupPrefill } from './setup-link';
import { validateServerUrl, normalizeServerUrl, toHttpBase } from './url-policy';
import { SETUP_COPY, joinTitle, invitedHost, TRUST_NOTICE_TEXT } from './user-facing-copy';
import { FEATURE_INVITE, type ServerFeatureCache } from './server-features';
import { jsonOf } from './protocol';

export interface SetupResult {
  serverUrl: string;
  vaultId: string;
  vaultSecret: string;
  /**
   * Optional one-shot admin token. Only sent with the very first
   * /auth/verify call to register a brand-new vault on the server.
   * NEVER persisted — caller is expected to hand it off to SyncEngine
   * via setOneShotAdminToken() and drop it after the first auth.
   */
  adminToken?: string;
  invite?: string;
  deviceName?: string;
  /** Per-device key returned by /invite/redeem. Empty/absent = secret flow. */
  deviceKey?: string;
}



export class SetupModal extends Modal {
  private resolve: ((result: SetupResult | null) => void) | null = null;
  private serverUrl: string;
  private vaultId: string;
  private vaultSecret: string;
  private adminToken = '';
  private expert = false;
  private deviceName: string;
  private errorEl: HTMLElement | null = null;
  private peerId: string;
  /** undefined = /health not answered yet, true/false = invite feature known. */
  private inviteSupported: boolean | undefined = undefined;
  /** Set after a rejected redeem: reveals the secret field with a reason. */
  private inviteFallbackReason: string | null = null;

  constructor(
    app: App,
    settings: VaultCRDTSettings,
    private prefill?: SetupPrefill,
    private features?: ServerFeatureCache,
  ) {
    super(app);
    this.serverUrl = prefill?.serverUrl ?? settings.serverUrl;
    this.vaultId = prefill?.vaultId ?? settings.vaultId;
    this.vaultSecret = prefill ? '' : settings.vaultSecret;
    this.deviceName = prefill ? defaultDeviceName() : settings.deviceName;
    this.peerId = settings.peerId;
    if (!prefill?.invite || !features) this.inviteSupported = false;
  }

  /** True while the invite redemption path (no secret field) is active. */
  private inviteMode(): boolean {
    return !!this.prefill?.invite && this.inviteSupported !== false && !this.inviteFallbackReason;
  }

  private async loadFeatures(): Promise<void> {
    const list = await this.features!.get(this.serverUrl);
    if (this.inviteSupported !== undefined) return;
    this.inviteSupported = list.includes(FEATURE_INVITE);
    if (this.resolve) this.onOpen();
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

    contentEl.createEl('h2', { text: this.prefill && !this.expert ? joinTitle(this.vaultId) : 'VaultCRDT — Setup' });
    contentEl.createEl('p', {
      text: this.prefill && !this.expert ? invitedHost(new URL(this.serverUrl).host) : 'Enter the details your server admin gave you.',
      cls: 'setting-item-description',
    });

    contentEl.createEl('p', {
      text: TRUST_NOTICE_TEXT,
      cls: 'setting-item-description vcrdt-trust-notice',
    });

    if (this.prefill?.newerVersion) contentEl.createEl('p', { text: SETUP_COPY.update });
    if (this.prefill?.invite && !this.inviteMode()) contentEl.createEl('p', { text: SETUP_COPY.invite });
    if (this.inviteFallbackReason) contentEl.createEl('p', { text: this.inviteFallbackReason, cls: 'setting-item-description' });
    if (this.prefill?.invite && this.features && this.inviteSupported === undefined) void this.loadFeatures();
    if (this.prefill && !this.expert) {
      new Setting(contentEl).setName(SETUP_COPY.server).addText(t => {
        t.setValue(this.serverUrl); t.inputEl.readOnly = true;
      });
      new Setting(contentEl).setName(SETUP_COPY.vault).addText(t => {
        t.setValue(this.vaultId); t.inputEl.readOnly = true;
      });
      const change = contentEl.createEl('a', { text: SETUP_COPY.change, href: '#' });
      change.addEventListener('click', e => { e.preventDefault(); this.expert = true; this.onOpen(); });
      new Setting(contentEl).setName(SETUP_COPY.device).addText(t =>
        t.setValue(this.deviceName).onChange(v => { this.deviceName = v; }));
      if (!this.inviteMode()) {
        new Setting(contentEl).setName(SETUP_COPY.secret).addText(t => {
          t.setValue(this.vaultSecret).onChange(v => { this.vaultSecret = v; });
          t.inputEl.type = 'password';
          new Setting(contentEl).addButton(b => b.setButtonText(SETUP_COPY.paste).onClick(async () => {
            try { this.vaultSecret = await navigator.clipboard.readText(); t.setValue(this.vaultSecret); }
            catch { this.showError(SETUP_COPY.pasteFailed); t.inputEl.focus(); }
          }));
        });
      }
    } else {
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

    // Creating a new vault? — collapsible, default-collapsed so existing
    // users are never confronted with the admin token field unless they
    // actively opt in to registering a new vault.
    const advanced = contentEl.createEl('details');
    advanced.createEl('summary', { text: 'Creating a new vault?' });
    new Setting(advanced)
      .setName('Admin Token')
      .setDesc('Only needed once, when registering a new vault on the server. Ask your server admin.')
      .addText((text) => {
        text
          .setPlaceholder('admin token')
          .setValue('')
          .onChange((v) => { this.adminToken = v.trim(); });
        text.inputEl.type = 'password';
        return text;
      });

    }

    // Error area (hidden by default)
    this.errorEl = contentEl.createEl('p', { cls: 'vcrdt-setup-error vcrdt-hidden' });

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
        btn.setButtonText(this.prefill && !this.expert ? SETUP_COPY.join : 'Connect').setCta().onClick(() => {
          void this.submit(btn);
        })
      );
  }

  private showError(msg: string): void {
    if (!this.errorEl) return;
    this.errorEl.textContent = msg;
    this.errorEl.removeClass('vcrdt-hidden');
  }

  private hideError(): void {
    if (!this.errorEl) return;
    this.errorEl.addClass('vcrdt-hidden');
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
    // Persist the normalised form everywhere downstream so we never store
    // a trailing slash that would later become `//auth/verify` or `//ws`.
    this.serverUrl = normalizeServerUrl(this.serverUrl);
    if (!VAULT_NAME_RE.test(this.vaultId)) {
      this.showError('Vault Name must be lowercase letters, numbers, or hyphens (e.g. my-notes)');
      return;
    }
    const inviteMode = this.inviteMode() && !this.expert;
    if (!inviteMode && !this.vaultSecret) {
      this.showError(this.prefill ? SETUP_COPY.required : 'Password is required');
      return;
    }

    // Verify credentials against server
    btn.setDisabled(true);
    btn.setButtonText('Connecting...');

    const httpBase = toHttpBase(this.serverUrl);

    if (inviteMode) {
      try {
        // The invite token is sent HERE and nowhere else.
        const resp = await requestUrl({
          url: `${httpBase}/invite/redeem`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            invite: this.prefill!.invite,
            peer_id: this.peerId,
            device_name: this.deviceName,
          }),
        });
        const joined = jsonOf<{ device_key: string; vault_id: string }>(resp);
        const deviceKey = joined.device_key;
        if (deviceKey) {
          this.resolve?.({
            serverUrl: this.serverUrl,
            vaultId: joined.vault_id ?? this.vaultId,
            vaultSecret: '',
            deviceKey,
            deviceName: this.deviceName,
          });
          this.resolve = null;
          this.close();
          return;
        }
        this.inviteFallbackReason = SETUP_COPY.inviteHintInvalid;
      } catch (e: unknown) {
        const status = (e as { status?: number })?.status;
        this.inviteFallbackReason = status === 410 ? SETUP_COPY.inviteHintExpired
          : status === 409 ? SETUP_COPY.inviteHintUsed
          : status === 401 ? SETUP_COPY.inviteHintInvalid
          : null;
        if (this.inviteFallbackReason === null) {
          btn.setDisabled(false);
          btn.setButtonText(SETUP_COPY.join);
          this.showError('Could not reach the server. Check the URL and your internet connection.');
          return;
        }
      }
      // Rejected invite: fall back to the secret-paste form with a reason.
      btn.setDisabled(false);
      this.onOpen();
      return;
    }

    // Build body — admin_token is only attached when the user has actually
    // entered one via the collapsible "Creating a new vault?" section.
    // Existing vault logins (the common case) never send the field.
    const body: Record<string, string> = {
      vault_id: this.vaultId,
      api_key: this.vaultSecret,
    };
    if (this.adminToken) body.admin_token = this.adminToken;

    try {
      const resp = await requestUrl({
        url: `${httpBase}/auth/verify`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (jsonOf<{ token: string }>(resp).token) {
        const result: SetupResult = {
          serverUrl: this.serverUrl,
          vaultId: this.vaultId,
          vaultSecret: this.vaultSecret,
        };
        if (this.prefill) result.deviceName = this.deviceName;
        if (this.prefill?.invite) result.invite = this.prefill.invite;
        if (this.adminToken) result.adminToken = this.adminToken;
        this.resolve?.(result);
        this.resolve = null;
        this.close();
        return;
      }

      this.showError('Unexpected server response. Check the server URL.');
    } catch (e: unknown) {
      // requestUrl throws on non-2xx status codes — extract status from error
      const status = (e as { status?: number })?.status;
      if (status === 401) {
        this.showError(
          'Authentication failed. Check vault name and password. ' +
          'If you are registering a NEW vault, expand "Creating a new vault?" and enter the admin token.'
        );
      } else if (status) {
        this.showError(`Server returned status ${status}. Check the server URL.`);
      } else {
        this.showError('Could not reach the server. Check the URL and your internet connection.');
      }
    } finally {
      btn.setDisabled(false);
      btn.setButtonText(this.prefill && !this.expert ? SETUP_COPY.join : 'Connect');
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

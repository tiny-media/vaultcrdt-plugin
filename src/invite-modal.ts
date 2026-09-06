import { App, Modal, Setting } from 'obsidian';
import qrcode from 'qrcode-generator';
import type { VaultCRDTSettings } from './settings';
import { createSetupUri } from './setup-link';
import { PLUGIN_REPO, SETUP_COPY as C } from './user-facing-copy';

export function renderQr(parent: HTMLElement, value: string): void {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(value, 'Byte');
    qr.make();
    const image = parent.createEl('img', { cls: 'vcrdt-qr' });
    image.src = qr.createDataURL(4, 16);
  } catch { parent.createEl('p', { text: C.qrFailed }); }
}
export class InviteModal extends Modal {
  constructor(
    app: App,
    private settings: VaultCRDTSettings,
    /** Mints a one-use invite token from the server (POST /invite), or null
     *  when the server has no invite feature / the call failed. */
    private mintInvite?: () => Promise<{ invite: string; expires_at: string } | null>,
  ) { super(app); }
  async onOpen(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.createEl('h2', { text: C.title });
    let invite: { invite: string; expires_at: string } | null = null;
    if (this.mintInvite) {
      try { invite = await this.mintInvite(); } catch { invite = null; }
    }
    let uri: string;
    try { uri = createSetupUri(this.settings.serverUrl, this.settings.vaultId, invite?.invite); }
    catch { el.createEl('p', { text: C.https }); return; }
    // One compact row per copyable: short label + the value as a wrapping
    // block (a bare <code> overflowed the modal on tablets) + the button.
    const copy = (parent: HTMLElement, label: string, value: string, button = C.copy) => {
      const row = new Setting(parent).setName(label);
      row.descEl.createEl('code', { text: value, cls: 'vcrdt-copy-code' });
      row.addButton(b => b.setButtonText(button).onClick(async () => {
        try { await navigator.clipboard.writeText(value); b.setButtonText(C.copied); }
        catch { b.setButtonText(C.copyFailed); }
      }));
    };
    el.createEl('h3', { text: C.help });
    el.createEl('p', { text: C.step1 });
    el.createEl('p', { text: C.step2 });
    const brat = `obsidian://brat?plugin=${PLUGIN_REPO}`;
    copy(el, C.bratLabel, brat);
    renderQr(el, brat);
    el.createEl('p', { text: C.step3 });
    renderQr(el, uri);
    copy(el, C.uriLabel, uri);
    if (invite) {
      el.createEl('p', { text: C.inviteActive.replace('{minutes}', minutesLeft(invite.expires_at)) });
    } else {
      // Old server or mint failure: honest label + the secret still travels
      // by second channel (design section A, slice-1 fallback).
      el.createEl('p', { text: C.setupLinkOnly });
      el.createEl('p', { text: C.secretAdvice });
      copy(el, C.secretLabel, this.settings.vaultSecret, C.copySecret);
      const secretQr = el.createDiv();
      new Setting(el).setName(C.secretQr).addToggle(t => t.setValue(false).onChange(show => {
        secretQr.empty();
        if (show) renderQr(secretQr, this.settings.vaultSecret);
      }));
    }
  }
  onClose(): void { this.contentEl.empty(); }
}

function minutesLeft(expiresAt: string): string {
  const t = Date.parse(expiresAt.includes('T') ? expiresAt : expiresAt.replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) return '?';
  return String(Math.max(0, Math.round((t - Date.now()) / 60000)));
}

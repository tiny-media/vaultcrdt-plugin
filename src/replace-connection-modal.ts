import { App, Modal, Setting } from 'obsidian';
import { SETUP_COPY as C, replaceConnectionText, TRUST_NOTICE_TEXT } from './user-facing-copy';
export class ReplaceConnectionModal extends Modal {
  private resolve: ((value: boolean) => void) | null = null;
  constructor(app: App, private vaultId: string) { super(app); }
  prompt(): Promise<boolean> { return new Promise(resolve => { this.resolve = resolve; this.open(); }); }
  onOpen(): void {
    this.contentEl.createEl('p', { text: replaceConnectionText(this.vaultId) });
    this.contentEl.createEl('p', { text: TRUST_NOTICE_TEXT, cls: 'setting-item-description vcrdt-trust-notice' });
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText(C.cancel).onClick(() => this.close()))
      .addButton(b => b.setButtonText(C.replace).setWarning().onClick(() => {
        this.resolve?.(true); this.resolve = null; this.close();
      }));
  }
  onClose(): void { this.resolve?.(false); this.resolve = null; this.contentEl.empty(); }
}

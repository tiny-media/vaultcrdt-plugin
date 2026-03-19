import { Modal, App, Setting } from 'obsidian';

export type SyncMode = 'pull' | 'push' | 'merge';

export class OnboardingModal extends Modal {
  private resolve: ((mode: SyncMode) => void) | null = null;
  private serverDocCount: number;
  private localDocCount: number;

  constructor(app: App, serverDocCount: number, localDocCount: number) {
    super(app);
    this.serverDocCount = serverDocCount;
    this.localDocCount = localDocCount;
  }

  /** Show modal and return the chosen sync mode. */
  prompt(): Promise<SyncMode> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vcrdt-onboarding');

    contentEl.createEl('h2', { text: 'VaultCRDT — First Sync' });
    contentEl.createEl('p', {
      text: `Server has ${this.serverDocCount} documents. This vault has ${this.localDocCount} local files.`,
    });
    contentEl.createEl('p', {
      text: 'Choose how to handle the initial sync:',
    });

    new Setting(contentEl)
      .setName('Pull from Server (recommended)')
      .setDesc('Download all server documents. Local-only files will NOT be pushed.')
      .addButton((btn) =>
        btn.setButtonText('Pull').setCta().onClick(() => {
          this.resolve?.('pull');
          this.close();
        })
      );

    new Setting(contentEl)
      .setName('Push to Server')
      .setDesc('Upload all local files to server. Server-only documents will NOT be downloaded.')
      .addButton((btn) =>
        btn.setButtonText('Push').onClick(() => {
          this.resolve?.('push');
          this.close();
        })
      );

    if (this.serverDocCount > 0) {
      const warn = contentEl.createEl('p', {
        cls: 'mod-warning',
        text: 'Warning: Push will skip server documents that don\'t exist locally.',
      });
      warn.style.color = 'var(--text-error)';
      warn.style.fontSize = '0.85em';
    }

    new Setting(contentEl)
      .setName('Merge (bidirectional)')
      .setDesc('Full two-way sync: download server docs AND push local files. May create conflict files.')
      .addButton((btn) =>
        btn.setButtonText('Merge').onClick(() => {
          this.resolve?.('merge');
          this.close();
        })
      );
  }

  onClose(): void {
    // If modal was closed without choosing (e.g. Escape), default to pull
    if (this.resolve) {
      this.resolve('pull');
      this.resolve = null;
    }
    this.contentEl.empty();
  }
}

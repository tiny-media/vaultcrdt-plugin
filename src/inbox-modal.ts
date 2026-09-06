import { App, Modal, Setting, TFile } from 'obsidian';
import type { Inbox, InboxEntry } from './inbox';
import { INBOX_COPY } from './user-facing-copy';

/** Reviewable list of quiet-mode inbox entries (design §E). */
export class InboxModal extends Modal {
  constructor(app: App, private inbox: Inbox, private onChanged?: () => void) { super(app); }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    el.createEl('h2', { text: INBOX_COPY.title });
    const items = this.inbox.list();
    if (items.length === 0) {
      el.createEl('p', { text: INBOX_COPY.empty });
      return;
    }
    for (const entry of [...items]) this.renderEntry(el, entry);
  }

  private renderEntry(parent: HTMLElement, entry: InboxEntry): void {
    const row = parent.createDiv({ cls: 'vcrdt-inbox-entry' });
    const setting = new Setting(row)
      .setName(INBOX_COPY.kind[entry.kind])
      .setDesc(entry.note ?? entry.path);
    if (entry.kind === 'conflict' || entry.kind === 'disjoint-conflict') {
      setting.addButton((b) => b.setButtonText(INBOX_COPY.openBoth).onClick(() => {
        void this.openBoth(entry);
      }));
    }
    setting.addButton((b) => b.setButtonText(INBOX_COPY.dismiss).onClick(() => {
      this.inbox.dismiss(entry.id);
      this.onChanged?.();
      this.render();
    }));
  }

  private async openBoth(entry: InboxEntry): Promise<void> {
    for (const path of [entry.relatedPath, entry.path]) {
      if (!path) continue;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
    }
  }

  onClose(): void { this.contentEl.empty(); }
}

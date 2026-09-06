import { App, Modal, Setting } from 'obsidian';
import { PANEL_COPY, protocolHealthText, relativeTimeText } from './user-facing-copy';

export interface StatusPanelData {
  connected: boolean;
  /** Wall-clock ms of the last server message (0 = none). */
  lastActivityAt: number;
  /** Wall-clock ms of the last completed full sync (0 = none). */
  lastInitialSyncAt: number;
  /** Pushes sent but not confirmed since the last full sync. */
  sentUnacked: number;
  inboxCount: number;
  /** Server protocol version from the cached /health probe. */
  serverProtocolVersion: number | undefined;
  clientProtocolVersion: number;
}

export interface StatusPanelActions {
  syncNow(): void;
  invite(): void;
  openInbox(): void;
  exportDiagnostics(): void;
  openSettings(): void;
}

/**
 * Ribbon status panel (design §E). Mobile has no status bar, so this modal is
 * the only always-reachable surface for connection state and the inbox.
 */
export class StatusPanelModal extends Modal {
  constructor(
    app: App,
    private data: () => StatusPanelData,
    private actions: StatusPanelActions,
    private now: () => number = () => Date.now(),
  ) { super(app); }

  onOpen(): void {
    const d = this.data();
    const el = this.contentEl;
    el.empty();
    el.createEl('h2', { text: PANEL_COPY.title });
    const status = el.createDiv({ cls: 'vcrdt-panel-status' });
    status.createSpan({
      text: d.connected ? '●' : '○',
      cls: d.connected ? 'vcrdt-panel-dot vcrdt-panel-dot-on' : 'vcrdt-panel-dot',
    });
    status.createSpan({ text: ` ${d.connected ? PANEL_COPY.connected : PANEL_COPY.offline}` });

    const lines = el.createDiv({ cls: 'vcrdt-panel-lines' });
    const line = (label: string, value: string): void => {
      lines.createDiv({ text: `${label}: ${value}`, cls: 'vcrdt-panel-line' });
    };
    const t = this.now();
    line(PANEL_COPY.lastActivity, relativeTimeText(d.lastActivityAt, t));
    line(PANEL_COPY.lastSync, relativeTimeText(d.lastInitialSyncAt, t));
    line(PANEL_COPY.unconfirmed, String(d.sentUnacked));
    line(PANEL_COPY.inbox, String(d.inboxCount));
    lines.createDiv({
      text: protocolHealthText(d.serverProtocolVersion, d.clientProtocolVersion),
      cls: 'vcrdt-panel-line',
    });

    const button = (label: string, run: () => void): void => {
      const setting = new Setting(el).addButton((b) => b.setButtonText(label).onClick(() => {
        this.close();
        run();
      }));
      // Touch-target floor for phones/tablets (CSS min-height).
      setting.settingEl.addClass('vcrdt-panel-action');
    };
    button(PANEL_COPY.openInbox, () => this.actions.openInbox());
    button(PANEL_COPY.syncNow, () => this.actions.syncNow());
    button(PANEL_COPY.invite, () => this.actions.invite());
    button(PANEL_COPY.diagnostics, () => this.actions.exportDiagnostics());
    button(PANEL_COPY.settings, () => this.actions.openSettings());
  }

  onClose(): void { this.contentEl.empty(); }
}

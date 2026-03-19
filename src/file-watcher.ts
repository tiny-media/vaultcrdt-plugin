import { App, TFile } from 'obsidian';
import type { SyncEngine } from './sync-engine';

/**
 * Watches for external file changes (git pull, Syncthing, etc.) by comparing
 * disk content against the CRDT state for already-loaded documents.
 *
 * RULE: Never auto-creates documents. Only acts on docs already loaded into
 * the DocumentManager (i.e. known to the sync engine).
 */
export class FileWatcherV2 {
  constructor(
    private app: App,
    private syncEngine: SyncEngine,
  ) {}

  /**
   * Scan all markdown files and push any external changes to the sync engine.
   * Only processes files whose CRDT doc is already loaded — no auto-create.
   */
  async scanForExternalChanges(): Promise<void> {
    const markdownFiles = this.app.vault.getMarkdownFiles() as TFile[];

    for (const file of markdownFiles) {
      const doc = this.syncEngine.getDocument(file.path);
      if (!doc) continue; // not loaded — skip (no auto-create)

      const diskContent = await this.app.vault.read(file);
      const crdtContent = doc.get_text();

      if (diskContent !== crdtContent) {
        // External change detected — feed into CRDT and push snapshot
        this.syncEngine.onFileChangedImmediate(file.path, diskContent);
      }
    }
  }
}

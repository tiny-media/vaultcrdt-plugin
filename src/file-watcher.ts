import { App } from 'obsidian';
import type { SyncEngine } from './sync-engine';

/**
 * Watches for external file changes (git pull, Syncthing, etc.) by comparing
 * disk content against the CRDT state for already-loaded documents.
 *
 * RULE: Never auto-creates documents. Only acts on docs already loaded into
 * the DocumentManager (i.e. known to the sync engine).
 */
export class FileWatcher {
  /**
   * Last-seen file stats keyed by path, so the desktop focus scan can skip the
   * expensive disk read + content compare for files whose mtime/size are
   * unchanged since the previous scan.
   *
   * PURE DESKTOP SKIP HEURISTIC: mtime/size only decide WHETHER the content
   * comparison runs — never the sync direction or the sync content. External
   * changes are still detected via the content compare on any stat change.
   */
  private baseline = new Map<string, { mtime: number; size: number }>();

  constructor(
    private app: App,
    private syncEngine: SyncEngine,
  ) {}

  /**
   * Scan all markdown files and push any external changes to the sync engine.
   * Only processes files whose CRDT doc is already loaded — no auto-create.
   *
   * Files with an unchanged mtime/size since the last scan are skipped without
   * a disk read; the first scan (empty baseline) reads all loaded docs and
   * builds the baseline.
   */
  async scanForExternalChanges(): Promise<void> {
    const markdownFiles = this.app.vault.getMarkdownFiles();
    const seen = new Set<string>();

    for (const file of markdownFiles) {
      seen.add(file.path);

      const doc = this.syncEngine.getDocument(file.path);
      if (!doc) continue; // not loaded — skip (no auto-create)

      const stat = file.stat;
      const prev = this.baseline.get(file.path);
      if (prev && stat && prev.mtime === stat.mtime && prev.size === stat.size) {
        continue; // stat unchanged since last scan — skip the disk read
      }

      const diskContent = await this.app.vault.cachedRead(file);
      const crdtContent = doc.get_text();

      if (diskContent !== crdtContent) {
        // External change detected — feed into CRDT and push snapshot
        this.syncEngine.onFileChangedImmediate(file.path, diskContent);
      }

      if (stat) {
        this.baseline.set(file.path, { mtime: stat.mtime, size: stat.size });
      }
    }

    // Drop baseline entries for renamed/deleted paths (no longer present).
    for (const path of this.baseline.keys()) {
      if (!seen.has(path)) this.baseline.delete(path);
    }
  }
}

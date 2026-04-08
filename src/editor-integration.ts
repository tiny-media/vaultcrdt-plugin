import { App, TFile, MarkdownView } from 'obsidian';
import { log, warn } from './logger';

export class EditorIntegration {
  private updatingEditorFromRemote = new Set<string>();

  constructor(
    private app: App,
    private writingFromRemote: Set<string>,
    private lastRemoteWrite: Map<string, string>,
    private tag: string,
  ) {}

  isUpdatingEditorFromRemote(path: string): boolean {
    return this.updatingEditorFromRemote.has(path);
  }

  /** Return the path of the currently active editor (the doc the user is looking at). */
  getActiveEditorPath(): string | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.file?.path ?? null;
  }

  readCurrentContent(path: string): string | null {
    let content: string | null = null;
    this.app.workspace.iterateAllLeaves((leaf: any) => {
      if (content !== null) return;
      if (!(leaf.view instanceof MarkdownView)) return;
      if (leaf.view.file?.path !== path) return;
      const editor = leaf.view.editor;
      if (editor) content = editor.getValue();
    });
    return content;
  }

  async writeToVault(filePath: string, content: string): Promise<void> {
    log(`${this.tag} writeToVault`, { filePath, contentLen: content.length });
    const existing = this.app.vault.getAbstractFileByPath(filePath);

    // If an open editor already shows the target content, do NOT touch the
    // editor again. On mobile startup the visible buffer may already be the
    // merged truth while the on-disk snapshot is still stale; re-running
    // setValue(content) is redundant and can clobber the user's composition
    // state. We still need to persist the matching text to disk, though.
    const currentEditor = this.readCurrentContent(filePath);
    if (currentEditor === content) {
      this.lastRemoteWrite.set(filePath, content);
      if (existing instanceof TFile) {
        const currentDisk = await this.app.vault.read(existing);
        if (currentDisk === content) return;
        this.writingFromRemote.add(filePath);
        try {
          await this.app.vault.modify(existing, content);
        } finally {
          setTimeout(() => this.writingFromRemote.delete(filePath), 500);
        }
        return;
      }
      // No existing file despite an open editor is unexpected, but fall back
      // to the normal disk-create path below instead of returning early.
    }

    // Skip write if on-disk content is already identical
    if (existing instanceof TFile) {
      const current = await this.app.vault.read(existing);
      if (current === content) return;
    }

    this.lastRemoteWrite.set(filePath, content);

    // Strategy 1: Editor open → update buffer directly (no "externally modified" dialog)
    if (this.applyToEditor(filePath, content)) {
      return; // Obsidian autosave handles disk persistence
    }

    // Strategy 2: No editor open → disk write (fallback)
    this.writingFromRemote.add(filePath);
    try {
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      } else {
        // Ensure parent directories exist (mobile Obsidian doesn't auto-create them)
        const dir = filePath.substring(0, filePath.lastIndexOf('/'));
        if (dir) {
          await this.ensureDir(dir);
        }
        await this.app.vault.create(filePath, content);
      }
    } finally {
      setTimeout(() => this.writingFromRemote.delete(filePath), 500);
    }
  }

  /**
   * Apply a TextDelta diff surgically to open editors for filePath.
   * Uses editor.transaction() so the cursor stays in place automatically.
   * Returns true if at least one editor was updated, false if no editor found.
   */
  applyDiffToEditor(filePath: string, diffJson: string, expectedText: string, skipFallback = false): boolean {
    let ops: Array<{ retain?: number; insert?: string; delete?: number }>;
    try {
      ops = JSON.parse(diffJson);
    } catch {
      return false;
    }
    if (!Array.isArray(ops) || ops.length === 0) return false;

    let applied = false;

    this.app.workspace.iterateAllLeaves((leaf) => {
      if (applied) return; // only apply to first matching editor
      if (!(leaf.view instanceof MarkdownView)) return;
      if (leaf.view.file?.path !== filePath) return;

      const editor = leaf.view.editor;
      if (!editor) return;

      // Build EditorChange array from TextDelta ops
      const changes: Array<{ from: { line: number; ch: number }; to?: { line: number; ch: number }; text: string }> = [];
      let offset = 0;

      for (const op of ops) {
        if (op.retain !== undefined) {
          offset += op.retain;
        } else if (op.insert !== undefined) {
          const from = editor.offsetToPos(offset);
          changes.push({ from, text: op.insert });
        } else if (op.delete !== undefined) {
          const from = editor.offsetToPos(offset);
          const to = editor.offsetToPos(offset + op.delete);
          changes.push({ from, to, text: '' });
          offset += op.delete;
        }
      }

      if (changes.length === 0) return;

      this.updatingEditorFromRemote.add(filePath);
      try {
        editor.transaction({ changes });
      } finally {
        this.updatingEditorFromRemote.delete(filePath);
      }

      // Verification: ensure editor content matches CRDT state
      if (editor.getValue() !== expectedText) {
        if (skipFallback) {
          // During initialSync surgical diff: mismatch is expected from concurrent
          // typing — the diff was applied correctly, extra chars are user keystrokes.
          log(`${this.tag} diff apply mismatch (concurrent typing, no fallback)`, { filePath });
        } else {
          warn(`${this.tag} diff apply mismatch, falling back to setValue`, { filePath });
          this.updatingEditorFromRemote.add(filePath);
          try {
            const cursor = editor.getCursor();
            editor.setValue(expectedText);
            const lastLine = editor.lastLine();
            const line = Math.min(cursor.line, lastLine);
            const maxCh = editor.getLine(line).length;
            editor.setCursor({ line, ch: Math.min(cursor.ch, maxCh) });
          } finally {
            this.updatingEditorFromRemote.delete(filePath);
          }
        }
      }

      applied = true;
    });

    return applied;
  }

  /** Recursively create directories if they don't exist. */
  private async ensureDir(dir: string): Promise<void> {
    if (this.app.vault.getAbstractFileByPath(dir)) return;
    const parent = dir.substring(0, dir.lastIndexOf('/'));
    if (parent) {
      await this.ensureDir(parent);
    }
    try {
      await this.app.vault.createFolder(dir);
    } catch {
      // folder may have been created concurrently
    }
  }

  /**
   * Apply content directly to all open editors for filePath.
   * Returns true if at least one editor was updated, false if no editor found.
   */
  private applyToEditor(filePath: string, content: string): boolean {
    let applied = false;

    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!(leaf.view instanceof MarkdownView)) return;
      if (leaf.view.file?.path !== filePath) return;

      const editor = leaf.view.editor;
      if (!editor) return;

      const cursor = editor.getCursor();
      this.updatingEditorFromRemote.add(filePath);
      try {
        editor.setValue(content);
      } finally {
        this.updatingEditorFromRemote.delete(filePath);
      }

      const lastLine = editor.lastLine();
      const line = Math.min(cursor.line, lastLine);
      const maxCh = editor.getLine(line).length;
      const ch = Math.min(cursor.ch, maxCh);
      editor.setCursor({ line, ch });

      applied = true;
    });

    return applied;
  }
}

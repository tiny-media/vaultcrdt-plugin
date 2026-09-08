import { App, TFile, MarkdownView, WorkspaceLeaf } from 'obsidian';
import { log, warn } from './logger';
import { fnv1aHash64 } from './conflict-utils';

/**
 * Convert a Unicode codepoint offset into a UTF-16 code-unit offset.
 * Loro TextDelta uses codepoints; CodeMirror/Obsidian editors use UTF-16.
 */
export function codepointOffsetToUtf16(text: string, cpOffset: number): number {
  let utf16 = 0;
  let cp = 0;
  while (cp < cpOffset && utf16 < text.length) {
    const code = text.charCodeAt(utf16);
    // Surrogate pair (Non-BMP) = one codepoint, two UTF-16 units
    utf16 += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
    cp++;
  }
  return utf16;
}

/**
 * Narrow, optional hook set (broadcast-scoped opt-in). Absent hook →
 * unchanged legacy behaviour for every other writeToVault caller.
 */
export interface WriteToVaultOptions {
  /**
   * Called with the current DISK text before it would be overwritten, when
   * that text differs from the text about to be written and no editor is
   * open for the path. The callee decides whether the text is unseen user
   * data and, if so, preserves it (conflict copy). Return value is advisory.
   */
  preserveUnseenDiskText?: (
    path: string,
    diskText: string,
  ) => boolean | null | Promise<boolean | null>;
}

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
    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      if (content !== null) return;
      if (!(leaf.view instanceof MarkdownView)) return;
      if (leaf.view.file?.path !== path) return;
      const editor = leaf.view.editor;
      if (editor) content = editor.getValue();
    });
    return content;
  }

  async writeToVault(
    filePath: string,
    content: string,
    opts?: WriteToVaultOptions,
  ): Promise<void> {
    log(`${this.tag} writeToVault`, { filePath, contentLen: content.length });
    const existing = this.app.vault.getAbstractFileByPath(filePath);

    // Opt-in preservation hook (only the sync-engine broadcast flow passes
    // one). Without a hook this method behaves EXACTLY as before. The hook
    // owns the decision AND the conflict copy; we only guarantee it runs
    // BEFORE any disk overwrite, and only when no editor holds the file
    // (an open editor buffer is authoritative — see applyToEditor).
    if (opts?.preserveUnseenDiskText && existing instanceof TFile
      && this.readCurrentContent(filePath) === null) {
      const diskText = await this.app.vault.read(existing);
      if (diskText !== content) {
        await opts.preserveUnseenDiskText(filePath, diskText);
      }
    }

    // If an open editor already shows the target content, do NOT touch the
    // editor again. On mobile startup the visible buffer may already be the
    // merged truth while the on-disk snapshot is still stale; re-running
    // setValue(content) is redundant and can clobber the user's composition
    // state. We still need to persist the matching text to disk, though.
    const currentEditor = this.readCurrentContent(filePath);
    if (currentEditor === content) {
      this.lastRemoteWrite.set(filePath, fnv1aHash64(content));
      if (existing instanceof TFile) {
        const currentDisk = await this.app.vault.read(existing);
        if (currentDisk === content) return;
        this.writingFromRemote.add(filePath);
        try {
          await this.app.vault.modify(existing, content);
        } finally {
          window.setTimeout(() => this.writingFromRemote.delete(filePath), 500);
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

    this.lastRemoteWrite.set(filePath, fnv1aHash64(content));

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
      window.setTimeout(() => this.writingFromRemote.delete(filePath), 500);
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
      ops = JSON.parse(diffJson) as Array<{ retain?: number; insert?: string; delete?: number }>;
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

      // Build EditorChange array from TextDelta ops.
      // Loro TextDelta offsets are Unicode codepoints; CodeMirror uses UTF-16.
      const docText = editor.getValue();
      const changes: Array<{ from: { line: number; ch: number }; to?: { line: number; ch: number }; text: string }> = [];
      let cpOffset = 0;

      for (const op of ops) {
        if (op.retain !== undefined) {
          cpOffset += op.retain;
        } else if (op.insert !== undefined) {
          const utf16 = codepointOffsetToUtf16(docText, cpOffset);
          const from = editor.offsetToPos(utf16);
          changes.push({ from, text: op.insert });
        } else if (op.delete !== undefined) {
          const fromUtf16 = codepointOffsetToUtf16(docText, cpOffset);
          const toUtf16 = codepointOffsetToUtf16(docText, cpOffset + op.delete);
          const from = editor.offsetToPos(fromUtf16);
          const to = editor.offsetToPos(toUtf16);
          changes.push({ from, to, text: '' });
          cpOffset += op.delete;
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
          warn(`${this.tag} diff apply mismatch, falling back to setValue`, {
            filePath,
            lenBefore: editor.getValue().length,
            lenAfter: expectedText.length,
          });
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

import { describe, it, expect } from 'vitest';
import {
  isSyncablePath,
  isAttachmentPath,
  attachmentCap,
  obsidianSyncCategory,
  obsidianSyncCategoryOf,
  OBSIDIAN_CAP,
} from '../path-policy';

describe('isSyncablePath', () => {
  it('accepts normal markdown files', () => {
    expect(isSyncablePath('note.md')).toBe(true);
    expect(isSyncablePath('notes/daily.md')).toBe(true);
    expect(isSyncablePath('a/b/c/deep.md')).toBe(true);
  });

  it('rejects non-markdown files', () => {
    expect(isSyncablePath('image.png')).toBe(false);
    expect(isSyncablePath('data.json')).toBe(false);
    expect(isSyncablePath('style.css')).toBe(false);
    expect(isSyncablePath('notes/file.txt')).toBe(false);
  });

  it('rejects .obsidian paths', () => {
    expect(isSyncablePath('.obsidian/plugins/foo/data.md')).toBe(false);
    expect(isSyncablePath('.obsidian/workspace.md')).toBe(false);
  });

  it('rejects .Obsidian paths case-insensitively', () => {
    expect(isSyncablePath('.Obsidian/x.md')).toBe(false);
    expect(isSyncablePath('.TRASH/old.md')).toBe(false);
  });

  it('rejects .trash paths', () => {
    expect(isSyncablePath('.trash/old-note.md')).toBe(false);
  });

  it('rejects path traversal', () => {
    expect(isSyncablePath('../secret.md')).toBe(false);
    expect(isSyncablePath('notes/../secret.md')).toBe(false);
    expect(isSyncablePath('./note.md')).toBe(false);
  });

  it('rejects absolute paths', () => {
    expect(isSyncablePath('/etc/passwd.md')).toBe(false);
    expect(isSyncablePath('/home/user/note.md')).toBe(false);
  });

  it('rejects empty or invalid input', () => {
    expect(isSyncablePath('')).toBe(false);
    expect(isSyncablePath(null as any)).toBe(false);
    expect(isSyncablePath(undefined as any)).toBe(false);
  });

  it('rejects paths with empty segments (double slashes)', () => {
    expect(isSyncablePath('notes//daily.md')).toBe(false);
  });
});

const ON = { settings: true, styles: true };
const OFF = { settings: false, styles: false };

describe('obsidianSyncCategory', () => {
  it('matches settings and styles on pathCaseKey, independent of toggle via Of',
    () => {
      expect(obsidianSyncCategoryOf('.obsidian/app.json')).toBe('settings');
      expect(obsidianSyncCategoryOf('.OBSIDIAN/APPEARANCE.JSON')).toBe('settings');
      expect(obsidianSyncCategoryOf('.obsidian/snippets/x.css')).toBe('styles');
      expect(obsidianSyncCategoryOf('.obsidian/themes/Nord/theme.css')).toBe('styles');
      expect(obsidianSyncCategoryOf('.obsidian/themes/Nord/manifest.json')).toBe('styles');
      expect(obsidianSyncCategoryOf('.obsidian/themes/Ünïcode/theme.css')).toBe('styles');
    });

  it('never matches workspace, plugins, nested snippets, or root json/css', () => {
    expect(obsidianSyncCategoryOf('.obsidian/workspace.json')).toBeNull();
    expect(obsidianSyncCategoryOf('.obsidian/workspace-mobile.json')).toBeNull();
    expect(obsidianSyncCategoryOf('.obsidian/plugins/vaultcrdt/data.json')).toBeNull();
    expect(obsidianSyncCategoryOf('.obsidian/snippets/a/b.css')).toBeNull();
    expect(obsidianSyncCategoryOf('.obsidian/themes/T/other.json')).toBeNull();
    expect(obsidianSyncCategoryOf('.obsidian/themes/T/sub/x.css')).toBeNull();
    expect(obsidianSyncCategoryOf('foo.json')).toBeNull();
    expect(obsidianSyncCategoryOf('x.css')).toBeNull();
  });

  it('rejects a backslash inside a POSIX segment', () => {
    expect(obsidianSyncCategoryOf('.obsidian/snippets/a\\..\\.css')).toBeNull();
  });

  it('respects per-category toggles', () => {
    expect(obsidianSyncCategory('.obsidian/app.json', OFF)).toBeNull();
    expect(obsidianSyncCategory('.obsidian/app.json', { settings: true, styles: false })).toBe('settings');
    expect(obsidianSyncCategory('.obsidian/snippets/x.css', { settings: true, styles: false })).toBeNull();
    expect(obsidianSyncCategory('.obsidian/snippets/x.css', { settings: false, styles: true })).toBe('styles');
  });
});

describe('isAttachmentPath / attachmentCap for .obsidian',
  () => {
    it('accepts category files only when that toggle is on',
      () => {
        expect(isAttachmentPath('.obsidian/app.json')).toBe(false);
        expect(isAttachmentPath('.obsidian/app.json', ON)).toBe(true);
        expect(isAttachmentPath('.obsidian/snippets/x.css', ON)).toBe(true);
        expect(isAttachmentPath('.obsidian/a.png', ON)).toBe(false);
        expect(isAttachmentPath('foo.json', ON)).toBe(false);
        expect(isAttachmentPath('x.css', ON)).toBe(false);
      });

    it('uses the 2 MiB category cap', () => {
      expect(attachmentCap('.obsidian/app.json')).toBe(OBSIDIAN_CAP);
      expect(OBSIDIAN_CAP).toBe(2 * 1024 * 1024);
      expect(attachmentCap('foo.json')).toBe(0);
      expect(attachmentCap('x.css')).toBe(0);
    });
  });

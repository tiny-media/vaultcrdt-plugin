import { describe, it, expect } from 'vitest';
import { isSyncablePath } from '../path-policy';

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

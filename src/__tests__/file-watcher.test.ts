import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileWatcher } from '../file-watcher';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockDoc = {
  get_text: vi.fn().mockReturnValue('hello world'),
};

const mockSyncEngine = {
  getDocument: vi.fn(),
  onFileChangedImmediate: vi.fn(),
  isWritingFromRemote: vi.fn().mockReturnValue(false),
};

type Stat = { mtime: number; size: number };

const makeFile = (path: string, stat?: Stat) => ({ path, extension: 'md', stat });

const makeApp = (files: Array<{ path: string }>, diskContents: Record<string, string>) => ({
  vault: {
    getMarkdownFiles: vi.fn().mockReturnValue(files),
    cachedRead: vi.fn().mockImplementation((file: { path: string }) =>
      Promise.resolve(diskContents[file.path] ?? ''),
    ),
  },
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('FileWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.get_text.mockReturnValue('hello world');
  });

  it('ignores files whose CRDT doc is not loaded (no auto-create)', async () => {
    mockSyncEngine.getDocument.mockReturnValue(undefined);
    const file = makeFile('notes/unloaded.md');
    const app = makeApp([file], { 'notes/unloaded.md': 'some content' });

    const watcher = new FileWatcher(app as any, mockSyncEngine as any);
    await watcher.scanForExternalChanges();

    expect(mockSyncEngine.onFileChangedImmediate).not.toHaveBeenCalled();
  });

  it('calls onFileChangedImmediate when disk content differs from CRDT text', async () => {
    mockSyncEngine.getDocument.mockReturnValue(mockDoc);
    mockDoc.get_text.mockReturnValue('old content');
    const file = makeFile('notes/changed.md');
    const app = makeApp([file], { 'notes/changed.md': 'new content from disk' });

    const watcher = new FileWatcher(app as any, mockSyncEngine as any);
    await watcher.scanForExternalChanges();

    expect(mockSyncEngine.onFileChangedImmediate).toHaveBeenCalledOnce();
    expect(mockSyncEngine.onFileChangedImmediate).toHaveBeenCalledWith(
      'notes/changed.md',
      'new content from disk',
    );
  });

  it('does nothing when disk content matches CRDT text', async () => {
    mockSyncEngine.getDocument.mockReturnValue(mockDoc);
    mockDoc.get_text.mockReturnValue('hello world');
    const file = makeFile('notes/same.md');
    const app = makeApp([file], { 'notes/same.md': 'hello world' });

    const watcher = new FileWatcher(app as any, mockSyncEngine as any);
    await watcher.scanForExternalChanges();

    expect(mockSyncEngine.onFileChangedImmediate).not.toHaveBeenCalled();
  });

  it('handles multiple files independently', async () => {
    const file1 = makeFile('a.md');
    const file2 = makeFile('b.md');
    const file3 = makeFile('c.md');

    const docA = { get_text: vi.fn().mockReturnValue('same') };
    const docB = { get_text: vi.fn().mockReturnValue('old') };

    mockSyncEngine.getDocument.mockImplementation((path: string) => {
      if (path === 'a.md') return docA;
      if (path === 'b.md') return docB;
      return undefined; // c.md not loaded
    });

    const app = makeApp([file1, file2, file3], {
      'a.md': 'same',
      'b.md': 'new content',
      'c.md': 'ignored',
    });

    const watcher = new FileWatcher(app as any, mockSyncEngine as any);
    await watcher.scanForExternalChanges();

    expect(mockSyncEngine.onFileChangedImmediate).toHaveBeenCalledOnce();
    expect(mockSyncEngine.onFileChangedImmediate).toHaveBeenCalledWith('b.md', 'new content');
  });

  // ── stat skip heuristic ───────────────────────────────────────────────────

  it('skips the disk read when mtime/size are unchanged since the last scan', async () => {
    mockSyncEngine.getDocument.mockReturnValue(mockDoc);
    mockDoc.get_text.mockReturnValue('hello world');
    const file = makeFile('notes/stable.md', { mtime: 1000, size: 11 });
    const app = makeApp([file], { 'notes/stable.md': 'hello world' });

    const watcher = new FileWatcher(app as any, mockSyncEngine as any);
    await watcher.scanForExternalChanges(); // first scan reads + builds baseline
    await watcher.scanForExternalChanges(); // stat unchanged → must skip read

    expect(app.vault.cachedRead).toHaveBeenCalledOnce();
    expect(mockSyncEngine.onFileChangedImmediate).not.toHaveBeenCalled();
  });

  it('re-reads and pushes when mtime changes and content differs', async () => {
    mockSyncEngine.getDocument.mockReturnValue(mockDoc);
    mockDoc.get_text.mockReturnValue('hello world');
    const file = makeFile('notes/edited.md', { mtime: 1000, size: 11 });
    const diskContents: Record<string, string> = { 'notes/edited.md': 'hello world' };
    const app = makeApp([file], diskContents);

    const watcher = new FileWatcher(app as any, mockSyncEngine as any);
    await watcher.scanForExternalChanges(); // baseline, content matches → no push
    expect(mockSyncEngine.onFileChangedImmediate).not.toHaveBeenCalled();

    // External edit: bump mtime/size and change disk content.
    file.stat = { mtime: 2000, size: 20 };
    diskContents['notes/edited.md'] = 'externally edited';
    await watcher.scanForExternalChanges();

    expect(app.vault.cachedRead).toHaveBeenCalledTimes(2);
    expect(mockSyncEngine.onFileChangedImmediate).toHaveBeenCalledOnce();
    expect(mockSyncEngine.onFileChangedImmediate).toHaveBeenCalledWith(
      'notes/edited.md',
      'externally edited',
    );
  });

  it('re-reads on mtime change but does not push when content still matches', async () => {
    mockSyncEngine.getDocument.mockReturnValue(mockDoc);
    mockDoc.get_text.mockReturnValue('hello world');
    const file = makeFile('notes/touched.md', { mtime: 1000, size: 11 });
    const app = makeApp([file], { 'notes/touched.md': 'hello world' });

    const watcher = new FileWatcher(app as any, mockSyncEngine as any);
    await watcher.scanForExternalChanges(); // baseline

    // Touch only bumps mtime; content identical (e.g. Syncthing metadata write).
    file.stat = { mtime: 2000, size: 11 };
    await watcher.scanForExternalChanges();

    expect(app.vault.cachedRead).toHaveBeenCalledTimes(2); // read happened
    expect(mockSyncEngine.onFileChangedImmediate).not.toHaveBeenCalled(); // but no push
  });

  it('does not skip an unloaded doc even when its stat is unchanged', async () => {
    mockSyncEngine.getDocument.mockReturnValue(undefined);
    const file = makeFile('notes/unloaded.md', { mtime: 1000, size: 5 });
    const app = makeApp([file], { 'notes/unloaded.md': 'stuff' });

    const watcher = new FileWatcher(app as any, mockSyncEngine as any);
    await watcher.scanForExternalChanges();
    await watcher.scanForExternalChanges();

    expect(app.vault.cachedRead).not.toHaveBeenCalled();
    expect(mockSyncEngine.onFileChangedImmediate).not.toHaveBeenCalled();
  });
});

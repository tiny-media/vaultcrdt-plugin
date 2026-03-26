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

const makeFile = (path: string) => ({ path, extension: 'md' });

const makeApp = (files: Array<{ path: string }>, diskContents: Record<string, string>) => ({
  vault: {
    getMarkdownFiles: vi.fn().mockReturnValue(files),
    read: vi.fn().mockImplementation((file: { path: string }) =>
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
});

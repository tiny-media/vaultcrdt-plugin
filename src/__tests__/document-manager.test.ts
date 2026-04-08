import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockCreateDocument, mockDocInstance, mockStorageInstance } = vi.hoisted(() => {
  const mockDocInstance = {
    insert_text: vi.fn(),
    delete_text: vi.fn(),
    get_text: vi.fn().mockReturnValue(''),
    version: vi.fn().mockReturnValue(0),
    sync_from_disk: vi.fn(),
    export_snapshot: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
    import_snapshot: vi.fn(),
    export_vv_json: vi.fn().mockReturnValue('{}'),
    export_delta_since_vv_json: vi.fn().mockReturnValue(new Uint8Array(0)),
    text_matches: vi.fn().mockReturnValue(false),
    import_and_diff: vi.fn().mockReturnValue(''),
  };
  const mockCreateDocument = vi.fn(() => mockDocInstance);
  const mockStorageInstance = {
    load: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    sizes: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
  };
  return { mockCreateDocument, mockDocInstance, mockStorageInstance };
});

vi.mock('../wasm-bridge', () => ({
  createDocument: mockCreateDocument,
}));

vi.mock('../state-storage', () => ({
  StateStorage: function() { return mockStorageInstance; },
}));

vi.mock('../logger', () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { DocumentManager } from '../document-manager';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DocumentManager', () => {
  let dm: DocumentManager;

  beforeEach(() => {
    vi.clearAllMocks();
    dm = new DocumentManager({} as any, 'test-peer-id');
  });

  describe('getOrLoad', () => {
    it('creates a new doc and caches it', async () => {
      const doc = await dm.getOrLoad('notes/test.md');
      expect(mockCreateDocument).toHaveBeenCalledTimes(1);
      expect(doc).toBe(mockDocInstance);
      expect(dm.has('notes/test.md')).toBe(true);
    });

    it('returns cached doc on second call', async () => {
      const first = await dm.getOrLoad('notes/test.md');
      const second = await dm.getOrLoad('notes/test.md');
      expect(mockCreateDocument).toHaveBeenCalledTimes(1);
      expect(first).toBe(second);
    });

    it('restores persisted snapshot when available', async () => {
      const snapshot = new Uint8Array([10, 20, 30]);
      mockStorageInstance.load.mockResolvedValueOnce(snapshot);

      await dm.getOrLoad('persisted.md');
      expect(mockDocInstance.import_snapshot).toHaveBeenCalledWith(snapshot);
    });

    it('does not import snapshot when none persisted', async () => {
      mockStorageInstance.load.mockResolvedValueOnce(null);

      await dm.getOrLoad('fresh.md');
      expect(mockDocInstance.import_snapshot).not.toHaveBeenCalled();
    });
  });

  describe('persist', () => {
    it('exports snapshot and saves to storage', async () => {
      await dm.getOrLoad('notes/save.md');
      await dm.persist('notes/save.md');

      expect(mockDocInstance.export_snapshot).toHaveBeenCalled();
      expect(mockStorageInstance.save).toHaveBeenCalledWith(
        'notes/save.md',
        new Uint8Array([1, 2, 3]),
      );
    });

    it('is a no-op for unknown file path', async () => {
      await dm.persist('unknown.md');
      expect(mockDocInstance.export_snapshot).not.toHaveBeenCalled();
      expect(mockStorageInstance.save).not.toHaveBeenCalled();
    });
  });

  describe('removeAndClean', () => {
    it('removes from memory and storage', async () => {
      await dm.getOrLoad('notes/cleanup.md');
      expect(dm.has('notes/cleanup.md')).toBe(true);

      await dm.removeAndClean('notes/cleanup.md');
      expect(dm.has('notes/cleanup.md')).toBe(false);
      expect(mockStorageInstance.remove).toHaveBeenCalledWith('notes/cleanup.md');
    });
  });

  describe('basic operations', () => {
    it('has() returns false for unknown paths', () => {
      expect(dm.has('nope.md')).toBe(false);
    });

    it('has() returns true after loading', async () => {
      await dm.getOrLoad('exists.md');
      expect(dm.has('exists.md')).toBe(true);
    });

    it('remove() deletes from memory', async () => {
      await dm.getOrLoad('to-remove.md');
      dm.remove('to-remove.md');
      expect(dm.has('to-remove.md')).toBe(false);
    });

    it('size() reflects number of loaded documents', async () => {
      expect(dm.size()).toBe(0);
      await dm.getOrLoad('a.md');
      expect(dm.size()).toBe(1);
      await dm.getOrLoad('b.md');
      expect(dm.size()).toBe(2);
    });

    it('paths() returns all loaded file paths', async () => {
      await dm.getOrLoad('alpha.md');
      await dm.getOrLoad('beta.md');
      expect(dm.paths()).toEqual(expect.arrayContaining(['alpha.md', 'beta.md']));
      expect(dm.paths()).toHaveLength(2);
    });
  });
});

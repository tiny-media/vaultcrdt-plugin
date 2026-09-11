import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { freshDoc, mockCreateDocument, mockDocInstance, mockStorageInstance } = vi.hoisted(() => {
  const freshDoc = () => ({
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
  });
  const mockDocInstance = freshDoc();
  const mockCreateDocument = vi.fn(() => mockDocInstance);
  const mockStorageInstance = {
    load: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    sizes: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
  };
  return { freshDoc, mockCreateDocument, mockDocInstance, mockStorageInstance };
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

  describe('getOrLoad single-flight', () => {
    function deferred() {
      let resolve!: (value: Uint8Array | null) => void;
      let reject!: (reason: Error) => void;
      const promise = new Promise<Uint8Array | null>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    beforeEach(() => {
      mockCreateDocument.mockImplementation(freshDoc);
    });

    afterEach(() => {
      mockCreateDocument.mockReset().mockImplementation(() => mockDocInstance);
      mockStorageInstance.load.mockReset().mockResolvedValue(null);
    });

    it('shares a concurrent cold load and caches the same instance', async () => {
      const load = deferred();
      const snapshot = new Uint8Array([10, 20, 30]);
      mockStorageInstance.load.mockReturnValue(load.promise);

      const p1 = dm.getOrLoad('shared.md');
      const p2 = dm.getOrLoad('shared.md');
      load.resolve(snapshot);
      const [first, second] = await Promise.all([p1, p2]);

      expect(mockCreateDocument).toHaveBeenCalledTimes(1);
      expect(mockStorageInstance.load).toHaveBeenCalledTimes(1);
      expect(first).toBe(second);
      expect(first.import_snapshot).toHaveBeenCalledExactlyOnceWith(snapshot);
      expect(dm.get('shared.md')).toBe(first);
      expect(await dm.getOrLoad('shared.md')).toBe(first);
      expect(mockCreateDocument).toHaveBeenCalledTimes(1);
      expect(mockStorageInstance.load).toHaveBeenCalledTimes(1);
    });

    it.each(['construction', 'load', 'import'] as const)(
      'shares %s failure, leaves no cache entry, and allows retry',
      async (stage) => {
        const load = deferred();
        const failure = new Error(`${stage} failed`);
        mockStorageInstance.load.mockReturnValue(load.promise);
        if (stage === 'construction') {
          mockCreateDocument.mockImplementation(() => { throw failure; });
        } else if (stage === 'import') {
          mockCreateDocument.mockImplementation(() => {
            const doc = freshDoc();
            doc.import_snapshot.mockImplementation(() => { throw failure; });
            return doc;
          });
        }

        const p1 = dm.getOrLoad('retry.md');
        const p2 = dm.getOrLoad('retry.md');
        const results = Promise.allSettled([p1, p2]);
        // Construction fails before storage is reached; the callers still join.
        if (stage === 'load') load.reject(failure);
        else load.resolve(new Uint8Array([10]));
        expect(await results).toEqual([
          { status: 'rejected', reason: failure },
          { status: 'rejected', reason: failure },
        ]);
        expect(mockCreateDocument).toHaveBeenCalledTimes(1);
        expect(mockStorageInstance.load).toHaveBeenCalledTimes(stage === 'construction' ? 0 : 1);
        expect(dm.get('retry.md')).toBeUndefined();

        mockCreateDocument.mockImplementation(freshDoc);
        mockStorageInstance.load.mockResolvedValue(null);
        const retried = await dm.getOrLoad('retry.md');
        expect(dm.get('retry.md')).toBe(retried);
        expect(await dm.getOrLoad('retry.md')).toBe(retried);
        expect(mockCreateDocument).toHaveBeenCalledTimes(2);
        expect(mockStorageInstance.load).toHaveBeenCalledTimes(stage === 'construction' ? 1 : 2);
      },
    );
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

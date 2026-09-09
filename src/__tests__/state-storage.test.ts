import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StateStorage } from '../state-storage';
import { BlobIndex } from '../blob-index';

// ── Mock Obsidian adapter ─────────────────────────────────────────────────────

const makeAdapter = (
  initialBinaryFiles: Map<string, ArrayBuffer> = new Map(),
  initialTextFiles: Map<string, string> = new Map(),
) => {
  const binaryFiles = new Map(initialBinaryFiles);
  const textFiles = new Map(initialTextFiles);
  return {
    // Returns true for files AND for directories (any stored path starts with dir/)
    exists: vi.fn(async (path: string) =>
      binaryFiles.has(path) ||
      textFiles.has(path) ||
      [...binaryFiles.keys(), ...textFiles.keys()].some((k) => k.startsWith(path + '/'))
    ),
    read: vi.fn(async (path: string) => {
      const text = textFiles.get(path);
      if (text === undefined) throw new Error(`not found: ${path}`);
      return text;
    }),
    write: vi.fn(async (path: string, content: string) => {
      textFiles.set(path, content);
    }),
    readBinary: vi.fn(async (path: string) => {
      const buf = binaryFiles.get(path);
      if (!buf) throw new Error(`not found: ${path}`);
      return buf;
    }),
    writeBinary: vi.fn(async (path: string, buf: ArrayBuffer) => {
      binaryFiles.set(path, buf);
    }),
    mkdir: vi.fn(async () => {}),
    remove: vi.fn(async (path: string) => {
      binaryFiles.delete(path);
      textFiles.delete(path);
    }),
    list: vi.fn(async (dir: string) => ({
      files: [...binaryFiles.keys(), ...textFiles.keys()].filter((k) => k.startsWith(dir + '/')),
      folders: [],
    })),
    _binaryFiles: binaryFiles,
    _textFiles: textFiles,
  };
};

const makeApp = (adapter = makeAdapter()) =>
  ({ vault: { adapter } }) as any;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('StateStorage', () => {
  let adapter: ReturnType<typeof makeAdapter>;
  let storage: StateStorage;

  beforeEach(() => {
    adapter = makeAdapter();
    storage = new StateStorage(makeApp(adapter));
  });

  it('raw methods preserve bytes, create the directory, and distinguish absence from read errors', async () => {
    expect(await storage.existsRaw('blob-index.json')).toBe(false);
    expect(await storage.readRaw('blob-index.json')).toBeNull();
    await storage.writeRaw('blob-index.json', '{ broken bytes');
    expect(adapter.mkdir).toHaveBeenCalledWith('.obsidian/plugins/vaultcrdt/state');
    expect(await storage.existsRaw('blob-index.json')).toBe(true);
    expect(await storage.readRaw('blob-index.json')).toBe('{ broken bytes');
    adapter.read.mockRejectedValueOnce(new Error('read denied'));
    await expect(storage.readRaw('blob-index.json')).rejects.toThrow('read denied');
    adapter.exists.mockRejectedValueOnce(new Error('exists denied'));
    await expect(storage.readRaw('blob-index.json')).rejects.toThrow('exists denied');
    adapter.write.mockRejectedValueOnce(new Error('write denied'));
    await expect(storage.writeRaw('blob-index.json', '{}')).rejects.toThrow('write denied');
  });

  it.each([false, true])('cleanup preserves all three index files across startup/restart (poisoned=%s)', async poisoned => {
    const names = ['blob-index.json', 'blob-index.bak', 'blob-index.corrupt.json'];
    for (const name of names) await storage.writeRaw(name, poisoned ? '{' : '{"v":1,"maxSeq":7,"paths":{}}');
    await storage.save('orphan.md', new Uint8Array([1]));
    await storage.save('kept.md', new Uint8Array([2]));
    const first = new BlobIndex(storage);
    const restarted = new BlobIndex(storage);
    try {
      expect((await first.load(async () => {})).outcome).toBe(poisoned ? 'poisoned' : 'ok');
      expect(await storage.cleanOrphans(new Set(['kept.md']))).toBe(1);
      for (const name of names) expect(await storage.existsRaw(name)).toBe(true);
      expect((await restarted.load(async () => {})).outcome).toBe(poisoned ? 'poisoned' : 'ok');
      expect(restarted.poisoned()).toBe(poisoned);
      expect(restarted.maxSeq()).toBe(poisoned ? 0 : 7);
    } finally { first.dispose(); restarted.dispose(); }
  });

  it('save and load roundtrip', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    await storage.save('notes/daily.md', data);
    const loaded = await storage.load('notes/daily.md');
    expect(loaded).not.toBeNull();
    expect(Array.from(loaded!)).toEqual([1, 2, 3, 4, 5]);
  });

  it('load returns null for missing state', async () => {
    const result = await storage.load('nonexistent.md');
    expect(result).toBeNull();
  });

  it('remove deletes state', async () => {
    const data = new Uint8Array([10, 20]);
    await storage.save('to-delete.md', data);
    expect(await storage.load('to-delete.md')).not.toBeNull();

    await storage.remove('to-delete.md');
    expect(await storage.load('to-delete.md')).toBeNull();
  });

  it('list returns saved keys', async () => {
    await storage.save('a.md', new Uint8Array([1]));
    await storage.save('b.md', new Uint8Array([2]));
    const keys = await storage.list();
    expect(keys).toContain(storage.stateKey('a.md'));
    expect(keys).toContain(storage.stateKey('b.md'));
  });

  it('clear removes all', async () => {
    await storage.save('x.md', new Uint8Array([1]));
    await storage.save('y.md', new Uint8Array([2]));
    await storage.clear();
    expect(await storage.load('x.md')).toBeNull();
    expect(await storage.load('y.md')).toBeNull();
  });

  it('path encoding uses URI encoding', () => {
    expect(storage.stateKey('notes/daily/2026-03-16.md')).toBe(
      'notes%2Fdaily%2F2026-03-16.md.loro'
    );
    expect(storage.stateKey('simple.md')).toBe('simple.md.loro');
    expect(storage.stateKey('a/b/c.md')).toBe('a%2Fb%2Fc.md.loro');
  });

  it('path encoding avoids collisions between slash and underscore', () => {
    expect(storage.stateKey('notes/daily.md')).not.toBe(
      storage.stateKey('notes_daily.md')
    );
  });

  it('path encoding avoids old __ collision', () => {
    // Old encoding: a/b.md and a__b.md both mapped to a__b.loro
    expect(storage.stateKey('a/b.md')).not.toBe(
      storage.stateKey('a__b.md')
    );
  });

  it('loadVVCache reads current v5 schema with 64-bit hex hashes', async () => {
    adapter.read.mockResolvedValueOnce(JSON.stringify({
      _version: 5,
      'note.md': { vv: '{"p":1}', contentHash: 'af63dc4c8601ec8c' },
    }));
    adapter.exists.mockResolvedValueOnce(true);

    const cache = await storage.loadVVCache();
    expect(cache?.get('note.md')).toEqual({ vv: '{"p":1}', contentHash: 'af63dc4c8601ec8c' });
  });

  it('loadVVCache rejects a legacy v3 cache (32-bit hashes) → full re-sync', async () => {
    adapter.read.mockResolvedValueOnce(JSON.stringify({
      _version: 3,
      'note.md': { vv: '{"p":1}', contentHash: 123 },
    }));
    adapter.exists.mockResolvedValueOnce(true);

    expect(await storage.loadVVCache()).toBeNull();
  });

  it('loadVVCache rejects a legacy v4 cache (32-bit hashes) → full re-sync', async () => {
    adapter.read.mockResolvedValueOnce(JSON.stringify({
      _version: 4,
      'note.md': { vv: '{"p":1}', contentHash: 123, dirty: true },
    }));
    adapter.exists.mockResolvedValueOnce(true);

    expect(await storage.loadVVCache()).toBeNull();
  });

  it('saveVVCache writes shared v5 entries without dirty bit', async () => {
    await storage.saveVVCache(new Map([
      ['note.md', { vv: '{"p":2}', contentHash: 'af63dc4c8601ec8c' }],
    ]));

    const raw = await adapter.read('.obsidian/plugins/vaultcrdt/state/vv-cache.json');
    expect(JSON.parse(raw)).toEqual({
      _version: 5,
      'note.md': { vv: '{"p":2}', contentHash: 'af63dc4c8601ec8c' },
    });
  });

  it('saveVVCache creates STATE_DIR when missing on first sync', async () => {
    // Fresh adapter: nothing exists yet (including the state directory).
    adapter.exists.mockResolvedValue(false);
    await storage.saveVVCache(new Map([
      ['a.md', { vv: '{}', contentHash: '0000000000000000' }],
    ]));
    expect(adapter.mkdir).toHaveBeenCalledWith('.obsidian/plugins/vaultcrdt/state');
    expect(adapter.write).toHaveBeenCalledWith(
      '.obsidian/plugins/vaultcrdt/state/vv-cache.json',
      expect.any(String),
    );
  });

  it('saveDeleteJournal writes v2 entries with acked flags', async () => {
    await storage.saveDeleteJournal([
      { path: 'a.md', acked: false },
      { path: 'b.md', acked: true },
    ]);
    const raw = await adapter.read('.obsidian/plugins/vaultcrdt/state/delete-journal.json');
    expect(JSON.parse(raw)).toEqual({
      _version: 2,
      entries: [
        { path: 'a.md', acked: false },
        { path: 'b.md', acked: true },
      ],
    });
  });

  it('loadDeleteJournal reads v2 entries', async () => {
    adapter.write.mockImplementation(async () => {});
    const textFiles = (adapter as any)._textFiles as Map<string, string>;
    textFiles.set(
      '.obsidian/plugins/vaultcrdt/state/delete-journal.json',
      JSON.stringify({
        _version: 2,
        entries: [{ path: 'kept.md', acked: true }],
      }),
    );
    expect(await storage.loadDeleteJournal()).toEqual([{ path: 'kept.md', acked: true }]);
  });

  it('loadDeleteJournal treats v1 paths as unacked', async () => {
    const textFiles = (adapter as any)._textFiles as Map<string, string>;
    textFiles.set(
      '.obsidian/plugins/vaultcrdt/state/delete-journal.json',
      JSON.stringify({ _version: 1, paths: ['old.md'] }),
    );
    expect(await storage.loadDeleteJournal()).toEqual([{ path: 'old.md', acked: false }]);
  });
});

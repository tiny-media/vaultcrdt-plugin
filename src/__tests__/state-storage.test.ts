import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StateStorage } from '../state-storage';

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

  it('loadVVCache ignores legacy schemas during dev resets', async () => {
    adapter.read.mockResolvedValueOnce(JSON.stringify({
      _version: 3,
      'note.md': { vv: '{"p":1}', contentHash: 123 },
    }));
    adapter.exists.mockResolvedValueOnce(true);

    const cache = await storage.loadVVCache();
    expect(cache).toBeNull();
  });

  it('saveVVCache writes v4 entries with dirty bit', async () => {
    await storage.saveVVCache(new Map([
      ['note.md', { vv: '{"p":2}', contentHash: 456, dirty: false }],
    ]));

    const raw = await adapter.read('.obsidian/plugins/vaultcrdt/state/vv-cache.json');
    expect(JSON.parse(raw)).toEqual({
      _version: 4,
      'note.md': { vv: '{"p":2}', contentHash: 456, dirty: false },
    });
  });
});

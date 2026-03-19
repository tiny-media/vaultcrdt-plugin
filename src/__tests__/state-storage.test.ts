import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StateStorage } from '../state-storage';

// ── Mock Obsidian adapter ─────────────────────────────────────────────────────

const makeAdapter = (initialFiles: Map<string, ArrayBuffer> = new Map()) => {
  const files = new Map(initialFiles);
  return {
    // Returns true for files AND for directories (any stored path starts with dir/)
    exists: vi.fn(async (path: string) =>
      files.has(path) || [...files.keys()].some((k) => k.startsWith(path + '/'))
    ),
    readBinary: vi.fn(async (path: string) => {
      const buf = files.get(path);
      if (!buf) throw new Error(`not found: ${path}`);
      return buf;
    }),
    writeBinary: vi.fn(async (path: string, buf: ArrayBuffer) => {
      files.set(path, buf);
    }),
    mkdir: vi.fn(async () => {}),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
    }),
    list: vi.fn(async (dir: string) => ({
      files: [...files.keys()].filter((k) => k.startsWith(dir + '/')),
      folders: [],
    })),
    _files: files,
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

  it('path encoding handles slashes and dots', () => {
    expect(storage.stateKey('notes/daily/2026-03-16.md')).toBe(
      'notes_daily_2026-03-16.loro'
    );
    expect(storage.stateKey('simple.md')).toBe('simple.loro');
    expect(storage.stateKey('a/b/c.md')).toBe('a_b_c.loro');
  });
});

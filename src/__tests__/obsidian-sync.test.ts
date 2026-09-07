import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizePath } from 'obsidian';
import initWasmModule, { blake3_hex } from '../../wasm/vaultcrdt_wasm';
import { BlobIndex } from '../blob-index';
import { BlobUploader } from '../blob-uploader';
import { ObsidianSync, vaultRelativeRawPath, joinListed, listObsidianCategoryFiles } from '../obsidian-sync';
import type { BlobDownloader } from '../blob-downloader';
import type { ObsidianSyncEnabled } from '../path-policy';

const ON: ObsidianSyncEnabled = { settings: true, styles: true };
const APP = '.obsidian/app.json';
const SNIP = '.obsidian/snippets/x.css';
const THEME = '.obsidian/themes/Nord/theme.css';
const MANIFEST = '.obsidian/themes/Nord/manifest.json';

function memStorage() {
  const files = new Map<string, unknown>();
  return {
    loadJson: async <T,>(name: string) => (files.get(name) ?? null) as T | null,
    saveJson: async (name: string, value: unknown) => { files.set(name, value); },
  };
}

function idleDownloader(hydrateOne: BlobDownloader['hydrateOne'] = vi.fn()): BlobDownloader {
  return {
    hydrateOne,
    whenIdle: async () => undefined,
  } as unknown as BlobDownloader;
}

function bufOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

beforeAll(async () => {
  const bytes = readFileSync(new URL('../../wasm/vaultcrdt_wasm_bg.wasm', import.meta.url));
  await initWasmModule({ module_or_path: bytes });
});

describe('vaultRelativeRawPath',
  () => {
    it('normalizes Windows separators before the allowlist',
      () => {
        expect(normalizePath('.obsidian\\snippets\\x.css')).toBe('.obsidian/snippets/x.css');
        expect(vaultRelativeRawPath('.obsidian\\snippets\\x.css', '')).toBe('.obsidian/snippets/x.css');
      });

    it('strips an absolute vault base path',
      () => {
        expect(vaultRelativeRawPath(
          'C:\\Users\\me\\vault\\.obsidian\\app.json',
          'C:\\Users\\me\\vault',
        )).toBe(APP);
      });

    it('keeps an already vault-relative path',
      () => {
        expect(vaultRelativeRawPath(APP, '/vault')).toBe(APP);
      });
  });

describe('joinListed', () => {
  it('joins a bare name and keeps a full vault-relative entry', () => {
    expect(joinListed('.obsidian', 'app.json')).toBe(APP);
    expect(joinListed('.obsidian', APP)).toBe(APP);
  });
});

describe('ObsidianSync raw debounce', () => {
  it('coalesces raw events after debounce and ignores plugins paths', async () => {
    let release!: () => void;
    const sleep = () => new Promise<void>((r) => { release = r; });
    const onFileChanged = vi.fn();
    const index = new BlobIndex(memStorage());
    const sync = new ObsidianSync({
      index,
      downloader: idleDownloader(),
      enabled: () => ON,
      vaultBasePath: () => '/vault',
      list: async () => ({ files: [], folders: [] }),
      stat: async () => null,
      readBinary: async () => new ArrayBuffer(0),
      onFileChanged,
      onFileDeleted: async () => undefined,
      sleep,
    });

    sync.onRaw('/vault/.obsidian/app.json');
    sync.onRaw('/vault/.obsidian/app.json');
    sync.onRaw('/vault/.obsidian/plugins/vaultcrdt/data.json');
    expect(onFileChanged).not.toHaveBeenCalled();
    release();
    await sync.flush();
    expect(onFileChanged).toHaveBeenCalledTimes(1);
    expect(onFileChanged).toHaveBeenCalledWith(APP);
  });
});

describe('listObsidianCategoryFiles + sweep', () => {
  const listing: Record<string, { files: string[]; folders: string[] }> = {
    '.obsidian': { files: ['app.json', 'workspace.json'], folders: ['snippets', 'themes'] },
    '.obsidian/snippets': { files: ['x.css'], folders: [] },
    '.obsidian/themes': { files: [], folders: ['Nord'] },
    '.obsidian/themes/Nord': { files: ['theme.css', 'manifest.json', 'other.json'], folders: [] },
  };

  it('lists allowlisted files only', async () => {
    const files = await listObsidianCategoryFiles(
      async (dir) => listing[dir] ?? { files: [], folders: [] },
      ON,
    );
    expect(files.sort()).toEqual([APP, SNIP, MANIFEST, THEME].sort());
  });

  it('new/changed/deleted: upload vs onFileDeleted; unhydrated is not gone', async () => {
    const onFileChanged = vi.fn((path: string) => path);
    const onFileDeleted = vi.fn(async (_path: string) => undefined);
    const index = new BlobIndex(memStorage());
    const stats: Record<string, { size: number; mtime: number }> = {
      [APP]: { size: 10, mtime: 100 },
      [SNIP]: { size: 20, mtime: 200 },
      [THEME]: { size: 30, mtime: 300 },
      [MANIFEST]: { size: 5, mtime: 50 },
    };
    index.update(APP, { hash: 'h', size: 10, mtime: 100, hydrated: true, skipped: false });
    index.update(SNIP, { hash: 'h', size: 99, mtime: 1, hydrated: true, skipped: false });
    index.update('.obsidian/appearance.json', {
      hash: 'h', size: 1, hydrated: true, skipped: false,
    });
    index.update('.obsidian/themes/Gone/theme.css', {
      hash: 'h', size: 1, hydrated: false, skipped: false,
    });

    const sync = new ObsidianSync({
      index,
      downloader: idleDownloader(),
      enabled: () => ON,
      vaultBasePath: () => '',
      list: async (dir) => listing[dir] ?? { files: [], folders: [] },
      stat: async (path) => stats[path] ?? null,
      readBinary: async () => new ArrayBuffer(0),
      onFileChanged,
      onFileDeleted,
    });

    await sync.sweep();

    const uploaded = onFileChanged.mock.calls.map((c) => c[0] as string).sort();
    expect(uploaded).toEqual([MANIFEST, SNIP, THEME].sort());
    expect(onFileDeleted).toHaveBeenCalledTimes(1);
    expect(onFileDeleted).toHaveBeenCalledWith('.obsidian/appearance.json');
    expect(onFileDeleted.mock.calls.some((c) => c[0] === '.obsidian/themes/Gone/theme.css')).toBe(false);
  });
});

describe('toggle-ON hydrate-then-sweep',
  () => {
    it('hydrates skipped entries before the sweep upload pass', async () => {
      const order: string[] = [];
      const index = new BlobIndex(memStorage());
      index.update(APP, {
        hash: 'abc', size: 3, seq: 4, generation: 1,
        skipped: true, hydrated: false, lastRemoteHash: null,
      });
      const hydrateOne = vi.fn(async (path: string) => { order.push(`hydrate:${path}`); });
      const onFileChanged = vi.fn((path: string) => { order.push(`upload:${path}`); });
      const sync = new ObsidianSync({
        index,
        downloader: idleDownloader(hydrateOne),
        enabled: () => ON,
        vaultBasePath: () => '',
        list: async (dir) => {
          order.push(`list:${dir}`);
          if (dir === '.obsidian') return { files: ['app.json'], folders: [] };
          return { files: [], folders: [] };
        },
        stat: async () => {
          order.push('stat');
          return { size: 3, mtime: 1 };
        },
        readBinary: async () => new ArrayBuffer(0),
        onFileChanged,
        onFileDeleted: async () => undefined,
      });

      await sync.onCategoryEnabled('settings');
      expect(index.get(APP)?.skipped).toBeFalsy();
      expect(hydrateOne).toHaveBeenCalledWith(APP);
      const firstHydrate = order.findIndex((s) => s.startsWith('hydrate:'));
      const firstList = order.findIndex((s) => s.startsWith('list:'));
      expect(firstHydrate).toBeGreaterThanOrEqual(0);
      expect(firstList).toBeGreaterThan(firstHydrate);
    });
  });

describe('sweep fail-closed / reentrancy / skipped / mtime',
  () => {
    it('adapter.list reject aborts the sweep: zero tombstones, index unchanged',
      async () => {
        const index = new BlobIndex(memStorage());
        index.update('.obsidian/appearance.json', {
          hash: 'h', size: 1, hydrated: true, skipped: false,
        });
        const uploader = new BlobUploader({
          index,
          serverUrl: () => 'https://s.example.com',
          peerId: () => 'peer-1',
          getJwt: async () => 'jwt-1',
          blobsEnabled: async () => true,
          stat: async () => null,
          readBinary: async () => new ArrayBuffer(0),
          writeBinary: async () => undefined,
          notify: vi.fn(),
          isMobile: false,
          sleep: async () => undefined,
        });
        const postPath = vi.spyOn(
          uploader as unknown as { postPath: (...args: unknown[]) => Promise<unknown> },
          'postPath',
        ).mockResolvedValue({
          status: 200, json: { accepted: true }, arrayBuffer: new ArrayBuffer(0), headers: {},
        });
        const before = JSON.stringify(index.entries());
        const sync = new ObsidianSync({
          index,
          downloader: idleDownloader(),
          enabled: () => ON,
          vaultBasePath: () => '',
          list: async () => { throw new Error('EIO'); },
          stat: async () => ({ size: 1, mtime: 1 }),
          readBinary: async () => new ArrayBuffer(0),
          onFileChanged: vi.fn(),
          onFileDeleted: (path) => uploader.onFileDeleted(path),
        });

        await sync.sweep();

        expect(postPath).not.toHaveBeenCalled();
        expect(JSON.stringify(index.entries())).toBe(before);
        expect(index.get('.obsidian/appearance.json')?.hydrated).toBe(true);
      });

    it('two concurrent sweep calls share one logical run',
      async () => {
        let entered = 0;
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const index = new BlobIndex(memStorage());
        index.update(APP, { hash: 'h', size: 3, mtime: 1, hydrated: true, skipped: false });
        const sync = new ObsidianSync({
          index,
          downloader: idleDownloader(),
          enabled: () => ON,
          vaultBasePath: () => '',
          list: async (dir) => {
            if (dir === '.obsidian') {
              entered += 1;
              await gate;
              return { files: ['app.json'], folders: [] };
            }
            return { files: [], folders: [] };
          },
          stat: async () => ({ size: 3, mtime: 1 }),
          readBinary: async () => new ArrayBuffer(0),
          onFileChanged: vi.fn(),
          onFileDeleted: async () => undefined,
        });

        const first = sync.sweep();
        await vi.waitFor(() => expect(entered).toBe(1));
        const second = sync.sweep();
        release();
        await Promise.all([first, second]);
        expect(entered).toBe(1);
      });

    it('skipped over-cap file present is enqueued once, not on the next sweep',
      async () => {
        const onFileChanged = vi.fn();
        const index = new BlobIndex(memStorage());
        index.update(APP, {
          hash: 'h', size: 10, mtime: 1, hydrated: false, skipped: true,
        });
        const sync = new ObsidianSync({
          index,
          downloader: idleDownloader(),
          enabled: () => ON,
          vaultBasePath: () => '',
          list: async (dir) => {
            if (dir === '.obsidian') return { files: ['app.json'], folders: [] };
            return { files: [], folders: [] };
          },
          stat: async () => ({ size: 10, mtime: 1 }),
          readBinary: async () => new ArrayBuffer(0),
          onFileChanged,
          onFileDeleted: async () => undefined,
        });

        onFileChanged(APP);
        await sync.sweep();
        await sync.sweep();
        expect(onFileChanged).toHaveBeenCalledTimes(1);
        expect(onFileChanged).toHaveBeenCalledWith(APP);
      });

    it('mtime-missing: same size, different content is detected via blake3',
      async () => {
        const oldBytes = new Uint8Array([1, 1, 1, 1]);
        const newBytes = new Uint8Array([2, 2, 2, 2]);
        const onFileChanged = vi.fn();
        const index = new BlobIndex(memStorage());
        index.update(APP, {
          hash: blake3_hex(oldBytes), size: 4, hydrated: true, skipped: false,
        });
        const sync = new ObsidianSync({
          index,
          downloader: idleDownloader(),
          enabled: () => ON,
          vaultBasePath: () => '',
          list: async (dir) => {
            if (dir === '.obsidian') return { files: ['app.json'], folders: [] };
            return { files: [], folders: [] };
          },
          stat: async () => ({ size: 4 }),
          readBinary: async () => bufOf(newBytes),
          onFileChanged,
          onFileDeleted: async () => undefined,
        });

        await sync.sweep();
        expect(onFileChanged).toHaveBeenCalledTimes(1);
        expect(onFileChanged).toHaveBeenCalledWith(APP);
      });
  });

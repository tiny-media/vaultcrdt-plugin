import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { TFile } from 'obsidian';
import type { App } from 'obsidian';

const { mockRequestUrl } = vi.hoisted(() => ({ mockRequestUrl: vi.fn() }));
vi.mock('obsidian', async () => {
  const base = await vi.importActual<Record<string, unknown>>('../__mocks__/obsidian');
  return { ...base, requestUrl: mockRequestUrl };
});

import initWasmModule, { blake3_hex, blob_path_key } from '../../wasm/vaultcrdt_wasm';
import { BlobIndex } from '../blob-index';
import { BlobDownloader } from '../blob-downloader';
import { AUDIO_CAP } from '../path-policy';
import { BlobUploader } from '../blob-uploader';
import { ObsidianSync } from '../obsidian-sync';

const PATH = 'Bilder/photo.png';
const OTHER = 'Bilder/other.png';
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const REMOTE = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9]);
const MIB = 1024 * 1024;

interface Call { url: string; method: string; headers?: Record<string, string>; body?: unknown }
const calls = (): Call[] => mockRequestUrl.mock.calls.map((c) => c[0] as Call);
const blobGets = () => calls().filter((c) => c.method === 'GET' && c.url.includes('/vault/blobs/'));
const puts = () => calls().filter((c) => c.method === 'PUT');

function memStorage() {
  const files = new Map<string, unknown>();
  return {
    loadJson: async <T,>(name: string) => (files.get(name) ?? null) as T | null,
    saveJson: async (name: string, value: unknown) => { files.set(name, value); },
  };
}

function rangeOf(headers?: Record<string, string>): string {
  return headers?.Range ?? headers?.range ?? '';
}

function serveRange(bytes: Uint8Array, opts: Call) {
  const m = /bytes=(\d+)-(\d+)/.exec(rangeOf(opts.headers));
  const from = Number(m?.[1] ?? 0);
  const to = Number(m?.[2] ?? bytes.length - 1);
  const slice = bytes.slice(from, Math.min(to + 1, bytes.length));
  const buf = new ArrayBuffer(slice.byteLength);
  new Uint8Array(buf).set(slice);
  const end = from + slice.byteLength - 1;
  return {
    status: 206,
    arrayBuffer: buf,
    headers: { 'Content-Range': `bytes ${from}-${end}/${bytes.length}` },
    json: {},
  };
}

function catchUpLive(path: string, bytes: Uint8Array, extra: Record<string, unknown> = {}) {
  return {
    status: 200,
    json: {
      states: [{
        path_key: blob_path_key(path),
        display_path: path,
        state: 'live',
        content_hash: blake3_hex(bytes),
        size: bytes.length,
        generation: 2,
        seq: 15,
        ...extra,
      }],
      max_seq: 15,
    },
  };
}

function makeVault() {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  return {
    files,
    exists: async (p: string) => files.has(p) || dirs.has(p),
    mkdir: async (p: string) => { dirs.add(p); },
    writeBinary: async (p: string, data: ArrayBuffer) => {
      files.set(p, new Uint8Array(data.slice(0)));
    },
    readBinary: async (p: string) => {
      const b = files.get(p);
      if (!b) throw new Error(`missing ${p}`);
      return b.slice().buffer;
    },
    stat: async (p: string) => {
      const b = files.get(p);
      return b ? { size: b.byteLength } : null;
    },
  };
}

function makeApp(files: Map<string, Uint8Array>): App {
  return {
    vault: {
      getAbstractFileByPath: (p: string) => (files.has(p) ? { path: p } : null),
    },
  } as App;
}

function makePair(opts: {
  isMobile?: boolean;
  cache?: { embeds?: { link: string }[]; links?: { link: string }[] } | null;
  cacheFor?: (file: TFile) => { embeds?: { link: string }[]; links?: { link: string }[] } | null;
  enabled?: { settings: boolean; styles: boolean };
  hydrateActiveFile?: () => void;
} = {}) {
  const vault = makeVault();
  const index = new BlobIndex(memStorage());
  const enqueue = vi.fn();
  const downloader = new BlobDownloader({
    index,
    serverUrl: () => 'https://s.example.com',
    getJwt: async () => 'jwt-1',
    blobsEnabled: async () => true,
    exists: vault.exists,
    mkdir: vault.mkdir,
    writeBinary: (p, data) => vault.writeBinary(p, data),
    readBinary: vault.readBinary,
    enqueueUpload: enqueue,
    app: makeApp(vault.files),
    isMobile: opts.isMobile ?? false,
    getFileCache: (file) => (opts.cacheFor ? opts.cacheFor(file) : opts.cache ?? null),
  });
  const uploader = new BlobUploader({
    index,
    serverUrl: () => 'https://s.example.com',
    peerId: () => 'peer-1',
    getJwt: async () => 'jwt-1',
    blobsEnabled: async () => true,
    stat: vault.stat,
    readBinary: vault.readBinary,
    writeBinary: (p, data) => vault.writeBinary(p, data),
    notify: vi.fn(),
    isMobile: opts.isMobile ?? false,
    sleep: async () => undefined,
    now: () => 0,
    hydratePending: () => downloader.hydratePending(),
    obsidianSyncEnabled: () => opts.enabled ?? { settings: false, styles: false },
    hydrateActiveFile: opts.hydrateActiveFile,
  });
  return { vault, index, downloader, uploader, enqueue };
}

beforeAll(async () => {
  const bytes = readFileSync(new URL('../../wasm/vaultcrdt_wasm_bg.wasm', import.meta.url));
  await initWasmModule({ module_or_path: bytes });
});
beforeEach(() => {
  mockRequestUrl.mockReset();
});

describe('BlobDownloader (hydration S3)', () => {
  it('1. happy path: 206 segments assemble, index gets hash+seq+generation, create is echo, second catchUp does not loop', async () => {
    const { vault, index, uploader } = makePair();
    mockRequestUrl.mockImplementation(async (opts: Call) => {
      if (opts.method === 'GET' && opts.url.includes('/vault/blob-paths')) {
        return catchUpLive(PATH, BYTES);
      }
      if (opts.method === 'GET' && opts.url.includes('/vault/blobs/')) {
        return serveRange(BYTES, opts);
      }
      throw new Error(`unexpected ${opts.method} ${opts.url}`);
    });

    await uploader.catchUp();

    const entry = index.get(PATH)!;
    expect(entry.hydrated).toBe(true);
    expect(entry.hash).toBe(blake3_hex(BYTES));
    expect(entry.lastRemoteHash).toBe(blake3_hex(BYTES));
    expect(entry.seq).toBe(15);
    expect(entry.generation).toBe(2);
    expect(entry.size).toBe(BYTES.length);
    expect(vault.files.get(PATH)).toEqual(BYTES);
    expect(blobGets().length).toBeGreaterThan(0);

    mockRequestUrl.mockClear();
    uploader.onFileChanged(PATH);
    await uploader.flush();
    expect(puts()).toEqual([]);
    expect(calls().filter((c) => c.url.includes('/vault/blobs/uploads'))).toEqual([]);

    mockRequestUrl.mockImplementation(async (opts: Call) => {
      if (opts.method === 'GET' && opts.url.includes('/vault/blob-paths')) {
        return catchUpLive(PATH, BYTES);
      }
      throw new Error(`unexpected ${opts.method} ${opts.url}`);
    });
    await uploader.catchUp();
    expect(index.get(PATH)!.hydrated).toBe(true);
    expect(blobGets()).toEqual([]);
  });

  it('2. corrupted segment: nothing written, hydrated stays false, retried on next catchUp', async () => {
    const { vault, index, uploader } = makePair();
    const bad = new Uint8Array(BYTES.length).fill(7);
    let corrupt = true;
    mockRequestUrl.mockImplementation(async (opts: Call) => {
      if (opts.method === 'GET' && opts.url.includes('/vault/blob-paths')) {
        return catchUpLive(PATH, BYTES);
      }
      if (opts.method === 'GET' && opts.url.includes('/vault/blobs/')) {
        return serveRange(corrupt ? bad : BYTES, opts);
      }
      throw new Error(`unexpected ${opts.method} ${opts.url}`);
    });

    await uploader.catchUp();
    expect(index.get(PATH)!.hydrated).toBe(false);
    expect(vault.files.has(PATH)).toBe(false);

    corrupt = false;
    mockRequestUrl.mockClear();
    await uploader.catchUp();
    expect(index.get(PATH)!.hydrated).toBe(true);
    expect(vault.files.get(PATH)).toEqual(BYTES);
    expect(blobGets().length).toBeGreaterThan(0);
  });

  it('3. desktop eager order: 1, 3, 5 MiB (smallest first), concurrency ≤ 2', async () => {
    const { index, downloader } = makePair();
    const payloads: Record<string, Uint8Array> = {
      'a.jpg': new Uint8Array(1).fill(1),
      'c.jpg': new Uint8Array(3).fill(3),
      'b.jpg': new Uint8Array(5).fill(5),
    };
    // Sizes must match the served bodies (receive-side cap check, #8); the
    // ordering assertion below is what this test pins.
    index.update('a.jpg', { hash: blake3_hex(payloads['a.jpg']), size: 1, hydrated: false, seq: 1, generation: 1 });
    index.update('c.jpg', { hash: blake3_hex(payloads['c.jpg']), size: 3, hydrated: false, seq: 2, generation: 1 });
    index.update('b.jpg', { hash: blake3_hex(payloads['b.jpg']), size: 5, hydrated: false, seq: 3, generation: 1 });

    const byHash = new Map(Object.entries(payloads).map(([p, b]) => [blake3_hex(b), { path: p, bytes: b }]));
    const started: string[] = [];
    const seen = new Set<string>();
    let inFlight = 0;
    let maxInFlight = 0;
    const waiting: Array<() => void> = [];

    mockRequestUrl.mockImplementation(async (opts: Call) => {
      const hash = opts.url.split('/').pop() ?? '';
      const item = byHash.get(hash);
      if (!item) throw new Error(`unknown hash ${hash}`);
      if (!seen.has(hash)) {
        seen.add(hash);
        started.push(item.path);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (inFlight < 2 && started.length < 3) {
          await new Promise<void>((r) => { waiting.push(r); });
        } else {
          for (const r of waiting.splice(0)) r();
        }
        inFlight -= 1;
      }
      return serveRange(item.bytes, opts);
    });

    await downloader.hydratePending();
    expect(started).toEqual(['a.jpg', 'c.jpg', 'b.jpg']);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBe(2);
    expect(index.get('a.jpg')!.hydrated).toBe(true);
    expect(index.get('c.jpg')!.hydrated).toBe(true);
    expect(index.get('b.jpg')!.hydrated).toBe(true);
  });

  it('4. mobile lazy: file-open hydrates the embed path; ambiguous basename hydrates neither', async () => {
    const cache = { embeds: [{ link: 'Bilder/5.jpg' }] };
    const { index, downloader } = makePair({ isMobile: true, cache });
    const wanted = new Uint8Array([5, 5, 5]);
    const other = new Uint8Array([8, 8, 8]);
    index.update('Bilder/5.jpg', {
      hash: blake3_hex(wanted), size: wanted.length, hydrated: false, seq: 1, generation: 1,
    });
    index.update(OTHER, {
      hash: blake3_hex(other), size: other.length, hydrated: false, seq: 2, generation: 1,
    });

    mockRequestUrl.mockImplementation(async (opts: Call) => {
      if (!opts.url.includes('/vault/blobs/')) throw new Error(`unexpected ${opts.url}`);
      const hash = opts.url.split('/').pop() ?? '';
      if (hash === blake3_hex(wanted)) return serveRange(wanted, opts);
      throw new Error(`hydrated unexpected hash ${hash}`);
    });

    const note = new TFile();
    note.path = 'note.md';
    await downloader.hydrateForOpenFile(note);
    expect(index.get('Bilder/5.jpg')!.hydrated).toBe(true);
    expect(index.get(OTHER)!.hydrated).toBe(false);

    const mobile = makePair({
      isMobile: true,
      cache: { embeds: [{ link: '5.jpg' }] },
    });
    const one = new Uint8Array([1]);
    const two = new Uint8Array([2]);
    mobile.index.update('Bilder/5.jpg', {
      hash: blake3_hex(one), size: 1, hydrated: false, seq: 1, generation: 1,
    });
    mobile.index.update('Other/5.jpg', {
      hash: blake3_hex(two), size: 1, hydrated: false, seq: 2, generation: 1,
    });
    mockRequestUrl.mockImplementation(async () => {
      throw new Error('ambiguous basename must not hydrate');
    });
    const note2 = new TFile();
    note2.path = 'note.md';
    await mobile.downloader.hydrateForOpenFile(note2);
    expect(mobile.index.get('Bilder/5.jpg')!.hydrated).toBe(false);
    expect(mobile.index.get('Other/5.jpg')!.hydrated).toBe(false);
  });

  it('writeBinary failure rolls back hydrated so a later catchUp retries', async () => {
    const { vault, index, uploader } = makePair();
    const innerWrite = vault.writeBinary;
    let failWrite = true;
    vault.writeBinary = async (p: string, data: ArrayBuffer) => {
      if (failWrite) throw new Error('disk full');
      return innerWrite(p, data);
    };
    mockRequestUrl.mockImplementation(async (opts: Call) => {
      if (opts.method === 'GET' && opts.url.includes('/vault/blob-paths')) {
        return catchUpLive(PATH, BYTES);
      }
      if (opts.method === 'GET' && opts.url.includes('/vault/blobs/')) {
        return serveRange(BYTES, opts);
      }
      throw new Error(`unexpected ${opts.method} ${opts.url}`);
    });

    await uploader.catchUp();
    expect(index.get(PATH)!.hydrated).toBe(false);
    expect(index.get(PATH)!.lastRemoteHash).toBeNull();
    expect(vault.files.has(PATH)).toBe(false);

    failWrite = false;
    mockRequestUrl.mockClear();
    await uploader.catchUp();
    expect(index.get(PATH)!.hydrated).toBe(true);
    expect(vault.files.get(PATH)).toEqual(BYTES);
    expect(blobGets().length).toBeGreaterThan(0);
  });

  it('8. hydration over locally-modified file copies to conflict path and enqueues the copy', async () => {
    const { vault, index, downloader, enqueue } = makePair();
    const local = new Uint8Array([1, 1, 1, 1, 1]);
    vault.files.set(PATH, local);
    index.update(PATH, {
      hash: blake3_hex(REMOTE),
      size: REMOTE.length,
      generation: 3,
      seq: 9,
      hydrated: false,
      lastRemoteHash: blake3_hex(BYTES),
    });

    mockRequestUrl.mockImplementation(async (opts: Call) => serveRange(REMOTE, opts));
    await downloader.hydratePending();

    const copies = [...vault.files.keys()].filter((p) => p !== PATH);
    expect(copies).toHaveLength(1);
    expect(vault.files.get(copies[0])).toEqual(local);
    expect(vault.files.get(PATH)).toEqual(REMOTE);
    expect(index.get(PATH)!.hydrated).toBe(true);
    expect(index.get(PATH)!.hash).toBe(blake3_hex(REMOTE));
    expect(enqueue).toHaveBeenCalledWith(copies[0]);
    expect(copies[0]).toContain('(conflict ');
  });
});

const CFG = '.obsidian/app.json';
const ALL_ON = { settings: true, styles: true };

describe('.obsidian category hydration',
  () => {
    it('exempts category files from maybeConflictCopy and does not enqueue a copy', async () => {
      const { vault, index, downloader, enqueue } = makePair({ enabled: ALL_ON });
      const local = new Uint8Array([1, 1, 1, 1, 1]);
      vault.files.set(CFG, local);
      index.update(CFG, {
        hash: blake3_hex(REMOTE),
        size: REMOTE.length,
        generation: 3,
        seq: 9,
        hydrated: false,
        lastRemoteHash: blake3_hex(BYTES),
      });
      mockRequestUrl.mockImplementation(async (opts: Call) => serveRange(REMOTE, opts));
      await downloader.hydratePending();

      expect([...vault.files.keys()].filter((p) => p !== CFG)).toEqual([]);
      expect(vault.files.get(CFG)).toEqual(REMOTE);
      expect(index.get(CFG)!.hydrated).toBe(true);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('hydrates category files eagerly on mobile; attachments stay lazy', async () => {
      const { index, downloader, vault } = makePair({ isMobile: true, enabled: ALL_ON });
      const cfg = new Uint8Array([1, 2, 3]);
      const png = new Uint8Array([4, 5, 6]);
      index.update(CFG, {
        hash: blake3_hex(cfg), size: cfg.length, hydrated: false, seq: 1, generation: 1,
      });
      index.update(PATH, {
        hash: blake3_hex(png), size: png.length, hydrated: false, seq: 2, generation: 1,
      });
      mockRequestUrl.mockImplementation(async (opts: Call) => {
        const hash = opts.url.split('/').pop() ?? '';
        if (hash === blake3_hex(cfg)) return serveRange(cfg, opts);
        if (hash === blake3_hex(png)) return serveRange(png, opts);
        throw new Error(`unexpected hash ${hash}`);
      });
      await downloader.hydratePending();
      expect(index.get(CFG)!.hydrated).toBe(true);
      expect(index.get(PATH)!.hydrated).toBe(false);
      expect(vault.files.has(CFG)).toBe(true);
      expect(vault.files.has(PATH)).toBe(false);
    });

    it('mobile catchUp hydrates category files (uploader gate)', async () => {
      const { index, uploader } = makePair({ isMobile: true, enabled: ALL_ON });
      mockRequestUrl.mockImplementation(async (opts: Call) => {
        if (opts.method === 'GET' && opts.url.includes('/vault/blob-paths')) {
          return catchUpLive(CFG, BYTES);
        }
        if (opts.method === 'GET' && opts.url.includes('/vault/blobs/')) {
          return serveRange(BYTES, opts);
        }
        throw new Error(`unexpected ${opts.method} ${opts.url}`);
      });
      await uploader.catchUp();
      expect(index.get(CFG)!.hydrated).toBe(true);
      expect(index.get(CFG)!.lastRemoteHash).toBe(blake3_hex(BYTES));
    });

    it('echo suppression is index-based after adapter write (no vault events)', async () => {
      const { index, uploader } = makePair({ enabled: ALL_ON });
      mockRequestUrl.mockImplementation(async (opts: Call) => {
        if (opts.method === 'GET' && opts.url.includes('/vault/blob-paths')) {
          return catchUpLive(CFG, BYTES);
        }
        if (opts.method === 'GET' && opts.url.includes('/vault/blobs/')) {
          return serveRange(BYTES, opts);
        }
        throw new Error(`unexpected ${opts.method} ${opts.url}`);
      });
      await uploader.catchUp();
      expect(index.get(CFG)!.lastRemoteHash).toBe(blake3_hex(BYTES));
      mockRequestUrl.mockClear();
      uploader.onFileChanged(CFG);
      await uploader.flush();
      expect(puts()).toEqual([]);
      expect(calls().filter((c) => c.url.includes('/vault/blobs/uploads'))).toEqual([]);
    });
  });

describe('hydration vs sweep (data-loss class)', () => {
  it('sweep waits for an in-flight hydrate pass and does not tombstone that entry', async () => {
    const { vault, index, downloader } = makePair({ enabled: ALL_ON });
    const cfg = new Uint8Array([1, 2, 3]);
    index.update(CFG, {
      hash: blake3_hex(cfg), size: cfg.length, hydrated: false, seq: 1, generation: 1,
      lastRemoteHash: null,
    });

    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((r) => { releaseWrite = r; });
    let hitWrite!: () => void;
    const atWrite = new Promise<void>((r) => { hitWrite = r; });
    const order: string[] = [];
    const origWrite = vault.writeBinary;
    vault.writeBinary = async (p, data) => {
      order.push('write-wait');
      hitWrite();
      await writeGate;
      await origWrite(p, data);
      order.push('write-done');
    };

    mockRequestUrl.mockImplementation(async (opts: Call) => serveRange(cfg, opts));

    const hydrateP = downloader.hydratePending().then(() => { order.push('hydrate-done'); });
    await atWrite;

    const onFileDeleted = vi.fn(async () => { order.push('tombstone'); });
    const sync = new ObsidianSync({
      index,
      downloader,
      enabled: () => ALL_ON,
      vaultBasePath: () => '',
      list: async (dir) => {
        order.push(`list:${dir}`);
        if (dir === '.obsidian') {
          expect(index.get(CFG)!.hydrated).toBe(true);
          expect(vault.files.has(CFG)).toBe(true);
          return { files: ['app.json'], folders: [] };
        }
        return { files: [], folders: [] };
      },
      stat: async (path) => {
        const b = vault.files.get(path);
        return b ? { size: b.byteLength, mtime: 1 } : null;
      },
      readBinary: vault.readBinary,
      onFileChanged: vi.fn(),
      onFileDeleted,
    });

    const sweepP = sync.sweep().then(() => { order.push('sweep-done'); });
    await Promise.resolve();
    expect(order.filter((s) => s.startsWith('list:'))).toEqual([]);

    releaseWrite();
    await Promise.all([hydrateP, sweepP]);

    expect(onFileDeleted).not.toHaveBeenCalled();
    const firstList = order.findIndex((s) => s.startsWith('list:'));
    expect(firstList).toBeGreaterThan(order.indexOf('write-done'));
    expect(index.get(CFG)!.hydrated).toBe(true);
  });

  it('failing writeBinary leaves hydrated:false (no sweep tombstone); success flips it', async () => {
    const { vault, index, downloader } = makePair({ enabled: ALL_ON });
    const origWrite = vault.writeBinary;
    let failWrite = true;
    let hydratedDuringWrite: boolean | undefined;
    let lastRemoteDuringWrite: string | null | undefined;
    vault.writeBinary = async (p, data) => {
      hydratedDuringWrite = index.get(p)?.hydrated;
      lastRemoteDuringWrite = index.get(p)?.lastRemoteHash ?? null;
      if (failWrite) throw new Error('disk full');
      return origWrite(p, data);
    };
    mockRequestUrl.mockImplementation(async (opts: Call) => serveRange(BYTES, opts));
    index.update(CFG, {
      hash: blake3_hex(BYTES), size: BYTES.length, hydrated: false, seq: 1, generation: 1,
      lastRemoteHash: null,
    });

    await downloader.hydratePending();
    expect(hydratedDuringWrite).toBe(false);
    expect(lastRemoteDuringWrite).toBe(blake3_hex(BYTES));
    expect(index.get(CFG)!.hydrated).toBe(false);
    expect(index.get(CFG)!.lastRemoteHash).toBeNull();
    expect(vault.files.has(CFG)).toBe(false);

    const onFileDeleted = vi.fn(async () => undefined);
    const sync = new ObsidianSync({
      index,
      downloader,
      enabled: () => ALL_ON,
      vaultBasePath: () => '',
      list: async (dir) => {
        if (dir === '.obsidian') return { files: [], folders: [] };
        return { files: [], folders: [] };
      },
      stat: async () => null,
      readBinary: vault.readBinary,
      onFileChanged: vi.fn(),
      onFileDeleted,
    });
    await sync.sweep();
    expect(onFileDeleted).not.toHaveBeenCalled();
    expect(index.get(CFG)!.hydrated).toBe(false);

    failWrite = false;
    await downloader.hydratePending();
    expect(index.get(CFG)!.hydrated).toBe(true);
    expect(vault.files.get(CFG)).toEqual(BYTES);
  });
});

describe('BlobDownloader busy-pass re-arm (mobile)', () => {
  it('a request during a running pass is re-armed once and then stops', async () => {
    const first = new Uint8Array([1, 1, 1]);
    const second = new Uint8Array([2, 2, 2]);
    const noteA = new TFile();
    noteA.path = 'a.md';
    const noteB = new TFile();
    noteB.path = 'b.md';
    const { index, downloader, uploader, vault } = makePair({
      isMobile: true,
      cacheFor: (f) => (f.path === 'a.md'
        ? { embeds: [{ link: 'first.png' }] }
        : { embeds: [{ link: 'second.png' }] }),
    });
    index.update('Bilder/first.png', {
      hash: blake3_hex(first), size: first.length, hydrated: false, seq: 1, generation: 1,
    });
    index.update('Bilder/second.png', {
      hash: blake3_hex(second), size: second.length, hydrated: false, seq: 2, generation: 1,
    });

    let release!: () => void;
    const blocked = new Promise<void>((r) => { release = r; });
    mockRequestUrl.mockImplementation(async (opts: Call) => {
      const hash = opts.url.split('/').pop() ?? '';
      if (hash === blake3_hex(first)) {
        await blocked;
        return serveRange(first, opts);
      }
      if (hash === blake3_hex(second)) return serveRange(second, opts);
      throw new Error(`unexpected hash ${hash}`);
    });

    const pass = downloader.hydrateForOpenFile(noteA);
    await Promise.resolve();
    await Promise.resolve();
    // Accepted as pending while the first pass is blocked (old code dropped it).
    await downloader.hydrateForOpenFile(noteB);
    expect(index.get('Bilder/second.png')!.hydrated).toBe(false);

    release();
    await pass;
    await downloader.whenIdle();
    await downloader.whenIdle();
    expect(index.get('Bilder/first.png')!.hydrated).toBe(true);
    expect(index.get('Bilder/second.png')!.hydrated).toBe(true);

    // No perpetual re-arm: the follow-up pass issues no further GETs.
    mockRequestUrl.mockClear();
    await downloader.whenIdle();
    expect(blobGets()).toEqual([]);

    // Echo: the vault 'create' from the re-arm write uploads nothing.
    expect(vault.files.get('Bilder/second.png')).toEqual(second);
    uploader.onFileChanged('Bilder/second.png');
    await uploader.flush();
    expect(puts()).toEqual([]);
    expect(calls().filter((c) => c.url.includes('/vault/blobs/uploads'))).toEqual([]);
  });
});

describe('post-catch-up active-file hydration', () => {
  it('mobile: runs once after catch-up applied new server states', async () => {
    const hydrateActiveFile = vi.fn();
    const { uploader } = makePair({ isMobile: true, hydrateActiveFile });
    mockRequestUrl.mockImplementation(async (opts: Call) => {
      if (opts.method === 'GET' && opts.url.includes('/vault/blob-paths')) {
        return catchUpLive(PATH, BYTES);
      }
      throw new Error(`unexpected ${opts.method} ${opts.url}`);
    });
    await uploader.catchUp();
    expect(hydrateActiveFile).toHaveBeenCalledTimes(1);
  });

  it('desktop invariance: never called', async () => {
    const hydrateActiveFile = vi.fn();
    const { uploader } = makePair({ isMobile: false, hydrateActiveFile });
    mockRequestUrl.mockImplementation(async (opts: Call) => {
      if (opts.method === 'GET' && opts.url.includes('/vault/blob-paths')) {
        return catchUpLive(PATH, BYTES);
      }
      if (opts.method === 'GET' && opts.url.includes('/vault/blobs/')) {
        return serveRange(BYTES, opts);
      }
      throw new Error(`unexpected ${opts.method} ${opts.url}`);
    });
    await uploader.catchUp();
    expect(hydrateActiveFile).not.toHaveBeenCalled();
  });
});

describe('receive-side allocation cap (#8)', () => {
  const CAPPED = 'Bilder/big.mp3';

  function armEntry(index: BlobIndex, bytes: Uint8Array, size: number, path = CAPPED) {
    index.update(path, {
      hash: blake3_hex(bytes), size, hydrated: false, seq: 1, generation: 1,
    });
  }

  it('proceeds when the claimed total equals the index size and is within the cap', async () => {
    const { index, downloader, vault } = makePair();
    armEntry(index, BYTES, BYTES.length);
    mockRequestUrl.mockImplementation(async (opts: Call) => serveRange(BYTES, opts));
    await downloader.hydratePending();
    expect(vault.files.get(CAPPED)).toEqual(BYTES);
  });

  it('rejects a Content-Range total above AUDIO_CAP before allocating segments', async () => {
    const { index, downloader, vault } = makePair();
    armEntry(index, BYTES, AUDIO_CAP + 1);
    mockRequestUrl.mockImplementation(async (opts: Call) => ({
      status: 206,
      arrayBuffer: new ArrayBuffer(1),
      headers: { 'Content-Range': `bytes 0-0/${AUDIO_CAP + 1}` },
      json: {},
    }));
    await downloader.hydratePending();
    expect(vault.files.has(CAPPED)).toBe(false);
    // Only the 1-byte probe was issued; no range follow-ups.
    expect(blobGets().length).toBe(1);
  });

  it('rejects when the claimed total differs from the index entry size', async () => {
    const { index, downloader, vault } = makePair();
    armEntry(index, BYTES, BYTES.length);
    mockRequestUrl.mockImplementation(async () => ({
      status: 206,
      arrayBuffer: new ArrayBuffer(1),
      headers: { 'Content-Range': `bytes 0-0/${BYTES.length + 7}` },
      json: {},
    }));
    await downloader.hydratePending();
    expect(vault.files.has(CAPPED)).toBe(false);
    expect(blobGets().length).toBe(1);
  });

  it('rejects an HTTP 200 full body that exceeds the cap', async () => {
    const { index, downloader, vault } = makePair();
    armEntry(index, BYTES, AUDIO_CAP + 1);
    mockRequestUrl.mockImplementation(async () => ({
      status: 200,
      arrayBuffer: new ArrayBuffer(AUDIO_CAP + 1),
      headers: {},
      json: {},
    }));
    await downloader.hydratePending();
    expect(vault.files.has(CAPPED)).toBe(false);
  });

  it('rejects a 206 body without a parseable Content-Range that exceeds the cap', async () => {
    const { index, downloader, vault } = makePair();
    armEntry(index, BYTES, AUDIO_CAP + 1);
    mockRequestUrl.mockImplementation(async () => ({
      status: 206,
      arrayBuffer: new ArrayBuffer(AUDIO_CAP + 1),
      headers: {},
      json: {},
    }));
    await downloader.hydratePending();
    expect(vault.files.has(CAPPED)).toBe(false);
  });

  it('keeps the zero-total short-circuit (empty file)', async () => {
    const { index, downloader, vault } = makePair();
    const empty = new Uint8Array(0);
    armEntry(index, empty, 0);
    mockRequestUrl.mockImplementation(async () => ({
      status: 206,
      arrayBuffer: new ArrayBuffer(0),
      headers: { 'Content-Range': 'bytes 0-0/0' },
      json: {},
    }));
    await downloader.hydratePending();
    expect(vault.files.get(CAPPED)).toEqual(empty);
  });
});

describe('receiver-side SVG sanitize (#6)', () => {
  const SVG_PATH = 'Bilder/icon.svg';
  const RAW_SVG = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>',
  );

  function arm(index: BlobIndex, bytes: Uint8Array, path = SVG_PATH) {
    index.update(path, {
      hash: blake3_hex(bytes), size: bytes.length, hydrated: false, seq: 1, generation: 1,
    });
  }

  it('writes sanitized bytes and records them as the index/echo baseline', async () => {
    const { index, downloader, vault, uploader } = makePair();
    arm(index, RAW_SVG);
    mockRequestUrl.mockImplementation(async (opts: Call) => serveRange(RAW_SVG, opts));
    await downloader.hydratePending();

    const written = vault.files.get(SVG_PATH)!;
    expect(written).not.toEqual(RAW_SVG);
    expect(new TextDecoder().decode(written)).not.toContain('<script');
    const entry = index.get(SVG_PATH)!;
    expect(entry.hydrated).toBe(true);
    expect(entry.hash).toBe(blake3_hex(written));
    expect(entry.size).toBe(written.byteLength);
    expect(entry.lastRemoteHash).toBe(blake3_hex(written));

    // No re-upload churn: the local change check sees the sanitized baseline.
    mockRequestUrl.mockClear();
    uploader.onFileChanged(SVG_PATH);
    await uploader.flush();
    expect(puts()).toEqual([]);
  });

  it('writes nothing when sanitize throws on an unparseable SVG', async () => {
    const { index, downloader, vault } = makePair();
    const broken = new TextEncoder().encode('not an svg at all');
    arm(index, broken);
    mockRequestUrl.mockImplementation(async (opts: Call) => serveRange(broken, opts));
    await downloader.hydratePending();
    expect(vault.files.has(SVG_PATH)).toBe(false);
    expect(index.get(SVG_PATH)!.hydrated).toBe(false);
  });

  it('bypasses sanitize for non-SVG paths (bytes written verbatim)', async () => {
    const { index, downloader, vault } = makePair();
    arm(index, RAW_SVG, PATH);
    mockRequestUrl.mockImplementation(async (opts: Call) => serveRange(RAW_SVG, opts));
    await downloader.hydratePending();
    expect(vault.files.get(PATH)).toEqual(RAW_SVG);
  });
});

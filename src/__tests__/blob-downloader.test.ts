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
import { BlobUploader } from '../blob-uploader';

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

function makePair(opts: { isMobile?: boolean; cache?: { embeds?: { link: string }[]; links?: { link: string }[] } | null } = {}) {
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
    getFileCache: () => opts.cache ?? null,
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
      'a.jpg': new Uint8Array([1]),
      'c.jpg': new Uint8Array([3]),
      'b.jpg': new Uint8Array([5]),
    };
    index.update('a.jpg', { hash: blake3_hex(payloads['a.jpg']), size: 1 * MIB, hydrated: false, seq: 1, generation: 1 });
    index.update('c.jpg', { hash: blake3_hex(payloads['c.jpg']), size: 3 * MIB, hydrated: false, seq: 2, generation: 1 });
    index.update('b.jpg', { hash: blake3_hex(payloads['b.jpg']), size: 5 * MIB, hydrated: false, seq: 3, generation: 1 });

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

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const { mockRequestUrl } = vi.hoisted(() => ({ mockRequestUrl: vi.fn() }));
vi.mock('obsidian', async () => {
  const base = await vi.importActual<Record<string, unknown>>('../__mocks__/obsidian');
  return { ...base, requestUrl: mockRequestUrl };
});

import initWasmModule, { blake3_hex, blob_path_key } from '../../wasm/vaultcrdt_wasm';
import { BlobIndex } from '../blob-index';
import { BlobDownloader } from '../blob-downloader';
import { BlobUploader } from '../blob-uploader';
import { ObsidianSync } from '../obsidian-sync';
import type { ObsidianSyncEnabled } from '../path-policy';

const CFG = '.obsidian/app.json';
const PNG = 'Bilder/photo.png';
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const ON: ObsidianSyncEnabled = { settings: true, styles: true };
const OFF: ObsidianSyncEnabled = { settings: false, styles: false };

interface Call { url: string; method: string; headers?: Record<string, string>; body?: unknown }
const calls = (): Call[] => mockRequestUrl.mock.calls.map((c) => c[0] as Call);
const posts = () => calls().filter((c) => c.method === 'POST');
const puts = () => calls().filter((c) => c.method === 'PUT');
const bodyOf = (c: Call): Record<string, unknown> =>
  JSON.parse(typeof c.body === 'string' ? c.body : '{}') as Record<string, unknown>;

function memStorage() {
  const files = new Map<string, unknown>();
  return {
    existsRaw: async (name: string) => files.has(name),
    readRaw: async (name: string) => files.has(name) ? JSON.stringify(files.get(name)) : null,
    writeRaw: async (name: string, text: string) => { files.set(name, JSON.parse(text)); },
    loadJson: async <T,>(name: string) => (files.get(name) ?? null) as T | null,
    saveJson: async (name: string, value: unknown) => { files.set(name, value); },
  };
}

function serveRange(bytes: Uint8Array, opts: Call) {
  const m = /bytes=(\d+)-(\d+)/.exec(opts.headers?.Range ?? '');
  const from = Number(m?.[1] ?? 0);
  const to = Number(m?.[2] ?? bytes.length - 1);
  const slice = bytes.slice(from, Math.min(to + 1, bytes.length));
  const buf = new ArrayBuffer(slice.byteLength);
  new Uint8Array(buf).set(slice);
  return {
    status: 206,
    arrayBuffer: buf,
    headers: { 'Content-Range': `bytes ${from}-${from + slice.byteLength - 1}/${bytes.length}` },
    json: {},
  };
}

/** Mutable toggle state shared by downloader, uploader and .obsidian sync. */
function toggles(initial: ObsidianSyncEnabled) {
  const state = { ...initial };
  return {
    get: (): ObsidianSyncEnabled => ({ ...state }),
    set(next: ObsidianSyncEnabled) { state.settings = next.settings; state.styles = next.styles; },
  };
}

function makeRig(opts: {
  initial?: ObsidianSyncEnabled;
  files?: Record<string, Uint8Array>;
  sleep?: () => Promise<void>;
  trashIfPresent?: (path: string) => Promise<void>;
  removeFile?: (path: string) => Promise<void>;
} = {}) {
  const flags = toggles(opts.initial ?? OFF);
  const files = new Map<string, Uint8Array>(Object.entries(opts.files ?? {}));
  const dirs = new Set<string>();
  const index = new BlobIndex(memStorage());
  const writeBinary = vi.fn(async (p: string, data: ArrayBuffer) => {
    files.set(p, new Uint8Array(data.slice(0)));
  });
  const readBinary = async (p: string) => {
    const b = files.get(p);
    if (!b) throw new Error(`missing ${p}`);
    return b.slice().buffer;
  };
  const stat = async (p: string) => {
    const b = files.get(p);
    return b ? { size: b.byteLength, mtime: 1 } : null;
  };
  const downloader = new BlobDownloader({
    index,
    serverUrl: () => 'https://s.example.com',
    getJwt: async () => 'jwt-1',
    blobsEnabled: async () => true,
    exists: async (p: string) => files.has(p) || dirs.has(p),
    mkdir: async (p: string) => { dirs.add(p); },
    writeBinary,
    readBinary,
    enqueueUpload: vi.fn(),
    categoryEnabled: flags.get,
    app: { vault: { getAbstractFileByPath: () => null } } as never,
    isMobile: false,
    getFileCache: () => null,
  });
  const trashIfPresent = opts.trashIfPresent ?? vi.fn(async () => undefined);
  const removeFile = opts.removeFile ?? vi.fn(async () => undefined);
  const uploader = new BlobUploader({
    index,
    serverUrl: () => 'https://s.example.com',
    peerId: () => 'peer-1',
    getJwt: async () => 'jwt-1',
    blobsEnabled: async () => true,
    stat,
    readBinary,
    writeBinary,
    notify: vi.fn(),
    isMobile: false,
    now: () => 0,
    sleep: opts.sleep ?? (async () => undefined),
    trashIfPresent,
    removeFile,
    obsidianSyncEnabled: flags.get,
  });
  return { flags, files, index, downloader, uploader, writeBinary, trashIfPresent, removeFile };
}

function uploadServer(segmentBytes = 1024 * 1024) {
  return async (opts: Call) => {
    if (opts.method === 'POST' && opts.url.includes('/vault/blobs/uploads')) {
      return { status: 200, json: { upload_id: 'u1', segment_bytes: segmentBytes, next_offset: 0 }, arrayBuffer: new ArrayBuffer(0), headers: {} };
    }
    if (opts.method === 'PUT') {
      const m = /bytes (\d+)-(\d+)\//.exec(opts.headers?.['Content-Range'] ?? '');
      return { status: 202, json: { next_offset: Number(m?.[2] ?? 0) + 1 }, arrayBuffer: new ArrayBuffer(0), headers: {} };
    }
    if (opts.method === 'POST' && opts.url.includes('/vault/blob-paths')) {
      return { status: 200, json: { accepted: true, seq: 42 }, arrayBuffer: new ArrayBuffer(0), headers: {} };
    }
    throw new Error(`unexpected ${opts.method} ${opts.url}`);
  };
}

function tombstoneCatchUp(path: string, hash: string) {
  return {
    status: 200,
    json: {
      states: [{
        path_key: blob_path_key(path), display_path: path, state: 'deleted',
        content_hash: hash, generation: 3, seq: 20,
      }],
      max_seq: 20,
    },
    arrayBuffer: new ArrayBuffer(0),
    headers: {},
  };
}

beforeAll(async () => {
  const bytes = readFileSync(new URL('../../wasm/vaultcrdt_wasm_bg.wasm', import.meta.url));
  await initWasmModule({ module_or_path: bytes });
});
beforeEach(() => {
  mockRequestUrl.mockReset();
});

describe('N15 — hydrate write gate', () => {
  it('category toggle OFF: no writeBinary, entry parked as skipped', async () => {
    const { index, downloader, files, writeBinary } = makeRig({ initial: OFF });
    index.update(CFG, {
      hash: blake3_hex(BYTES), size: BYTES.length, hydrated: false, seq: 1, generation: 1,
    });
    mockRequestUrl.mockImplementation(async (opts: Call) => serveRange(BYTES, opts));

    await downloader.hydrateOne(CFG);

    expect(writeBinary).not.toHaveBeenCalled();
    expect(files.has(CFG)).toBe(false);
    const entry = index.get(CFG)!;
    expect(entry.skipped).toBe(true);
    expect(entry.hydrated).toBe(false);
  });

  it('toggle flips OFF mid-download: nothing is written', async () => {
    const { index, downloader, flags, writeBinary } = makeRig({ initial: ON });
    index.update(CFG, {
      hash: blake3_hex(BYTES), size: BYTES.length, hydrated: false, seq: 1, generation: 1,
    });
    mockRequestUrl.mockImplementation(async (opts: Call) => {
      flags.set(OFF);
      return serveRange(BYTES, opts);
    });

    await downloader.hydrateOne(CFG);
    expect(writeBinary).not.toHaveBeenCalled();
    expect(index.get(CFG)!.skipped).toBe(true);
  });

  it('ordinary attachments are never gated by the category toggle', async () => {
    const { index, downloader, files } = makeRig({ initial: OFF });
    index.update(PNG, {
      hash: blake3_hex(BYTES), size: BYTES.length, hydrated: false, seq: 1, generation: 1,
    });
    mockRequestUrl.mockImplementation(async (opts: Call) => serveRange(BYTES, opts));
    await downloader.hydrateOne(PNG);
    expect(files.get(PNG)).toEqual(BYTES);
    expect(index.get(PNG)!.hydrated).toBe(true);
  });
});

describe('N16 — remote tombstone gate', () => {
  it('synced (not skipped) category entry + OFF: no trash, no adapter.remove, index entry dropped', async () => {
    const hash = blake3_hex(BYTES);
    const { index, uploader, trashIfPresent, removeFile, files } =
      makeRig({ initial: OFF, files: { [CFG]: BYTES } });
    index.update(CFG, {
      hash, size: BYTES.length, generation: 2, seq: 5, lastRemoteHash: hash, hydrated: true,
    });
    mockRequestUrl.mockResolvedValueOnce(tombstoneCatchUp(CFG, hash));

    await uploader.catchUp();

    expect(trashIfPresent).not.toHaveBeenCalled();
    expect(removeFile).not.toHaveBeenCalled();
    expect(index.get(CFG)).toBeUndefined();
    expect(files.get(CFG)).toEqual(BYTES);
    expect(posts()).toEqual([]);
  });

  it('locally modified category file + OFF: no republish POST', async () => {
    const hash = blake3_hex(BYTES);
    const local = new Uint8Array([7, 7, 7]);
    const { index, uploader, trashIfPresent, removeFile } =
      makeRig({ initial: OFF, files: { [CFG]: local } });
    index.update(CFG, {
      hash, size: BYTES.length, generation: 2, seq: 5, lastRemoteHash: hash, hydrated: true,
    });
    mockRequestUrl.mockResolvedValueOnce(tombstoneCatchUp(CFG, hash));

    await uploader.catchUp();

    expect(posts()).toEqual([]);
    expect(puts()).toEqual([]);
    expect(trashIfPresent).not.toHaveBeenCalled();
    expect(removeFile).not.toHaveBeenCalled();
    expect(index.get(CFG)).toBeUndefined();
  });
});

describe('N17 — upload / delete / rename effect gates', () => {
  it('upload started under ON, toggle OFF before the POST: no request, entry skipped', async () => {
    let flip: (() => void) | null = null;
    const rig = makeRig({
      initial: ON,
      files: { [CFG]: BYTES },
      sleep: async () => { flip?.(); },
    });
    flip = () => rig.flags.set(OFF);
    mockRequestUrl.mockImplementation(uploadServer());

    rig.uploader.onFileChanged(CFG);
    await rig.uploader.flush();

    expect(calls()).toEqual([]);
    expect(rig.index.get(CFG)!.skipped).toBe(true);
  });

  it('toggle flips OFF between segment PUTs: no further PUT, no reference POST', async () => {
    const big = new Uint8Array(10).fill(3);
    const rig = makeRig({ initial: ON, files: { [CFG]: big } });
    const serve = uploadServer(4);
    mockRequestUrl.mockImplementation(async (opts: Call) => {
      const res = await serve(opts);
      if (opts.method === 'PUT') rig.flags.set(OFF);
      return res;
    });

    rig.uploader.onFileChanged(CFG);
    await rig.uploader.flush();

    expect(puts()).toHaveLength(1);
    expect(posts().filter((c) => c.url.includes('/vault/blob-paths'))).toEqual([]);
    expect(rig.index.get(CFG)!.skipped).toBe(true);
  });

  it('local delete of a category file under OFF fires no tombstone POST', async () => {
    const hash = blake3_hex(BYTES);
    const rig = makeRig({ initial: OFF, files: { [CFG]: BYTES } });
    rig.index.update(CFG, {
      hash, size: BYTES.length, generation: 1, seq: 3, lastRemoteHash: hash, hydrated: true,
    });
    mockRequestUrl.mockImplementation(uploadServer());

    await rig.uploader.onFileDeleted(CFG);

    expect(calls()).toEqual([]);
    expect(rig.index.get(CFG)).toBeUndefined();
  });

  it('rename of a category file under OFF fires no POST', async () => {
    const hash = blake3_hex(BYTES);
    const OTHER_CSS = '.obsidian/snippets/a.css';
    const RENAMED = '.obsidian/snippets/b.css';
    const rig = makeRig({ initial: OFF, files: { [RENAMED]: BYTES } });
    rig.index.update(OTHER_CSS, {
      hash, size: BYTES.length, generation: 1, seq: 3, lastRemoteHash: hash, hydrated: true,
    });
    mockRequestUrl.mockImplementation(uploadServer());

    await rig.uploader.onFileRenamed(OTHER_CSS, RENAMED);

    expect(calls()).toEqual([]);
    expect(rig.index.get(OTHER_CSS)).toBeUndefined();
    expect(rig.index.get(RENAMED)!.skipped).toBe(true);
  });

  it('sweep: toggle flips OFF after the listing snapshot — no per-item effects', async () => {
    const rig = makeRig({ initial: ON, files: { [CFG]: BYTES } });
    const onFileChanged = vi.fn();
    const onFileDeleted = vi.fn(async () => undefined);
    rig.index.update('.obsidian/snippets/gone.css', {
      hash: blake3_hex(BYTES), size: BYTES.length, generation: 1, seq: 2, hydrated: true,
    });
    const sync = new ObsidianSync({
      index: rig.index,
      downloader: rig.downloader,
      enabled: rig.flags.get,
      vaultBasePath: () => '',
      list: async (dir) => {
        rig.flags.set(OFF);
        return dir === '.obsidian' ? { files: ['app.json'], folders: [] } : { files: [], folders: [] };
      },
      stat: async (p) => {
        const b = rig.files.get(p);
        return b ? { size: b.byteLength, mtime: 1 } : null;
      },
      readBinary: async (p) => rig.files.get(p)!.slice().buffer,
      onFileChanged,
      onFileDeleted,
    });

    await sync.sweep();

    expect(onFileChanged).not.toHaveBeenCalled();
    expect(onFileDeleted).not.toHaveBeenCalled();
  });
});

describe('OFF → ON resume semantics', () => {
  it('entries skipped by the hydrate gate re-hydrate on toggle ON', async () => {
    const rig = makeRig({ initial: OFF });
    rig.index.update(CFG, {
      hash: blake3_hex(BYTES), size: BYTES.length, hydrated: false, seq: 1, generation: 1,
    });
    mockRequestUrl.mockImplementation(async (opts: Call) => serveRange(BYTES, opts));

    await rig.downloader.hydrateOne(CFG);
    expect(rig.index.get(CFG)!.skipped).toBe(true);

    rig.flags.set(ON);
    const sync = new ObsidianSync({
      index: rig.index,
      downloader: rig.downloader,
      enabled: rig.flags.get,
      vaultBasePath: () => '',
      list: async () => ({ files: [], folders: [] }),
      stat: async () => null,
      readBinary: async (p) => rig.files.get(p)!.slice().buffer,
      onFileChanged: vi.fn(),
      onFileDeleted: vi.fn(async () => undefined),
    });
    await sync.onCategoryEnabled('settings');

    expect(rig.files.get(CFG)).toEqual(BYTES);
    expect(rig.index.get(CFG)!.hydrated).toBe(true);
    expect(rig.index.get(CFG)!.skipped).toBe(false);
  });

  it('upload skipped mid-flight then edited locally: the resumed upload carries the CURRENT bytes', async () => {
    const first = new Uint8Array([1, 1, 1]);
    const edited = new Uint8Array([2, 2, 2, 2]);
    let flip: (() => void) | null = null;
    const rig = makeRig({
      initial: ON,
      files: { [CFG]: first },
      sleep: async () => { flip?.(); },
    });
    flip = () => rig.flags.set(OFF);
    mockRequestUrl.mockImplementation(uploadServer());

    rig.uploader.onFileChanged(CFG);
    await rig.uploader.flush();
    expect(calls()).toEqual([]);

    // Local edit while the category was OFF, then the user turns it back on.
    rig.files.set(CFG, edited);
    flip = null;
    rig.flags.set(ON);
    rig.uploader.onFileChanged(CFG);
    await rig.uploader.flush();

    const reference = posts().find((c) => c.url.includes('/vault/blob-paths'))!;
    expect(bodyOf(reference).content_hash).toBe(blake3_hex(edited));
    expect(bodyOf(reference).size).toBe(edited.byteLength);
    expect(rig.index.get(CFG)!.skipped).toBe(false);
  });
});

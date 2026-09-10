import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { App } from 'obsidian';
import { PathEffects } from '../path-effects';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('obsidian', async () => ({
  ...await vi.importActual<Record<string, unknown>>('../__mocks__/obsidian'),
  requestUrl: request,
}));
import initWasmModule, { blake3_hex, blob_path_key } from '../../wasm/vaultcrdt_wasm';
import { BlobIndex } from '../blob-index';
import { BlobDownloader } from '../blob-downloader';

const ready = async () => {
  const bytes = readFileSync(new URL('../../wasm/vaultcrdt_wasm_bg.wasm', import.meta.url));
  await initWasmModule({ module_or_path: bytes });
};
beforeAll(ready);

function storage(raw: unknown) {
  const bytes = JSON.stringify(raw);
  const read = vi.fn(() => JSON.parse(bytes) as unknown);
  return {
    bytes, read,
    existsRaw: async (name: string) => name === 'blob-index.json',
    readRaw: async (name: string) => name === 'blob-index.json' ? JSON.stringify(read()) : null,
    writeRaw: vi.fn(async () => undefined),
    loadJson: async <T,>() => read() as T,
    saveJson: vi.fn(async () => undefined),
  };
}

const valid = [
  'vcrdt-t-images/U\u0308bersicht.PNG', 'vcrdt-t-Straße.pdf',
  '.obsidian/app.json', '.obsidian/appearance.json',
  '.obsidian/snippets/vcrdt-t-style.css',
  '.obsidian/themes/vcrdt-t-theme/theme.css',
  '.obsidian/themes/vcrdt-t-theme/manifest.json',
  'C:/vcrdt-t-image.png', '__proto__/vcrdt-t-image.png',
];
const invalid = [
  '', '/vcrdt-t-image.png', '../vcrdt-t-image.png', './vcrdt-t-image.png',
  'vcrdt-t-dir/../image.png', 'vcrdt-t-dir//image.png', 'vcrdt-t-dir\\image.png',
  'vcrdt-t-dir./image.png', 'vcrdt-t-dir /image.png', 'vcrdt-t-image.png ',
  '.trash/vcrdt-t-image.png', '.obsidian/vcrdt-t-image.png',
  '.obsidian/plugins/vcrdt-t-plugin/main.js', '.obsidian/snippets/vcrdt-t-dir/style.css',
  'vcrdt-t-note.md', 'vcrdt-t-file.json', 'vcrdt-t-style.css',
  '__proto__', 'constructor', 'toString', `vcrdt-t-${'a'.repeat(1024)}.png`,
];

describe('persisted BlobIndex admission with real WASM and downloader', () => {
  it.each([false, true])('admits valid-only snapshots; mixed corruption poisons before effects (mixed=%s)', async (mixed) => {
    const bytes = new Uint8Array([1, 2, 3]);
    const hash = blake3_hex(bytes);
    const entry = { hash, size: 3, hydrated: false, seq: 17 };
    const paths = Object.fromEntries([
      ...valid.map((p) => [p, { ...entry, key: blob_path_key(p) }]),
      ...(mixed ? [
        ...invalid.map((p) => [p, { ...entry, key: 'vcrdt-t-safe.png' }]),
        ['vcrdt-t-mismatch.png', { ...entry, key: 'vcrdt-t-other.png' }],
        ['vcrdt-t-uppercase.PNG', { ...entry, key: 'vcrdt-t-uppercase.PNG' }],
        ['vcrdt-t-bad.png', null],
      ] : []),
    ]);
    const store = storage({ v: 1, maxSeq: 5, paths });
    const index = new BlobIndex(store);
    await index.load(ready);
    const first = index.entries();
    await index.load(ready); // Existing real initializer is idempotent.
    expect(index.entries()).toEqual(first);
    request.mockReset().mockResolvedValue({
      status: 206, arrayBuffer: bytes.buffer,
      headers: { 'Content-Range': 'bytes 0-2/3' }, json: {},
    });
    const exists = vi.fn(async () => false);
    const mkdir = vi.fn(async () => undefined);
    const writeBinary = vi.fn<(path: string, data: ArrayBuffer) => Promise<void>>(async () => undefined);
    const readBinary = vi.fn(async () => new ArrayBuffer(0));
    const downloader = new BlobDownloader({
      pathEffects: new PathEffects(index, async () => { throw new Error('Unexpected compensation'); }),
      index, serverUrl: () => 'https://vcrdt-t.example', getJwt: async () => 'vcrdt-t-jwt',
      blobsEnabled: async () => true, exists, mkdir, writeBinary, readBinary,
      enqueueUpload: vi.fn(), categoryEnabled: () => ({ settings: true, styles: true }),
      app: { vault: { getAbstractFileByPath: () => null } } as unknown as App,
      isMobile: false, getFileCache: () => null,
    });
    for (const path of [...invalid, 'vcrdt-t-mismatch.png', 'vcrdt-t-uppercase.PNG']) {
      await downloader.hydrateOne(path);
    }
    expect(writeBinary, 'rejected persisted paths must not reach the adapter write').not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(readBinary).not.toHaveBeenCalled();
    expect(first.map(([p]) => p)).toEqual(mixed ? [] : valid);
    expect(index.poisoned()).toBe(mixed);
    expect(index.cursor()).toBe(0); // v1 maxSeq is never a certified cursor.
    expect(store.saveJson).not.toHaveBeenCalled();
    expect(store.read).toHaveBeenCalledTimes(2);
    await downloader.hydratePending();
    expect(request).toHaveBeenCalledTimes(mixed ? 0 : valid.length * 2); // Probe + range per admitted path.
    expect(writeBinary.mock.calls.map(([p]) => p).sort()).toEqual(mixed ? [] : [...valid].sort());
    index.dispose();
  });

  it('preserves empty hashes, skipped/unhydrated metadata and existing numeric states without new bounds', async () => {
    const p = 'vcrdt-t-skipped.png';
    const entry = { key: p, hash: '', size: -1, generation: -2, seq: 100,
      hydrated: false, lastRemoteHash: null, skipped: true, mtime: -3 };
    const store = storage({ v: 1, maxSeq: -7, paths: { [p]: entry,
      'vcrdt-t-default.png': { key: 'vcrdt-t-default.png', hash: '' } } });
    const index = new BlobIndex(store);
    await index.load(ready);
    expect(index.get(p)).toEqual(entry);
    expect(index.get('vcrdt-t-default.png')).toEqual({ key: 'vcrdt-t-default.png', hash: '',
      size: 0, generation: 0, seq: 0, hydrated: true, lastRemoteHash: '' });
    expect(index.cursor()).toBe(0);
    expect(store.saveJson).not.toHaveBeenCalled();
  });

  it('never exposes prototype-derived entries, before or after load', async () => {
    const store = storage({ v: 1, maxSeq: 0, paths: {} });
    const index = new BlobIndex(store);
    for (const phase of [0, 1]) {
      if (phase) await index.load(ready);
      for (const p of ['__proto__', 'constructor', 'toString']) {
        expect(index.get(p)).toBeUndefined();
        expect(index.move(p, 'vcrdt-t-target.png')).toBeNull();
        index.remove(p);
      }
    }
    await index.flush();
    expect(index.entries()).toEqual([]);
    expect(store.saveJson).not.toHaveBeenCalled();
  });
});

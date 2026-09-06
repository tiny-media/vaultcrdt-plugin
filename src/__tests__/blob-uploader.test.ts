import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const { mockRequestUrl } = vi.hoisted(() => ({ mockRequestUrl: vi.fn() }));
vi.mock('obsidian', async () => {
  const base = await vi.importActual<Record<string, unknown>>('../__mocks__/obsidian');
  return { ...base, requestUrl: mockRequestUrl };
});

import initWasmModule, { blake3_hex } from '../../wasm/vaultcrdt_wasm';
import { BlobIndex } from '../blob-index';
import { BlobUploader } from '../blob-uploader';

const PATH = 'Bilder/photo.png';
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

interface Call { url: string; method: string; headers?: Record<string, string>; body?: unknown }
const calls = (): Call[] => mockRequestUrl.mock.calls.map((c) => c[0] as Call);
const urls = () => calls().map((c) => `${c.method} ${c.url.replace('https://s.example.com', '')}`);
const ranges = () => calls().filter((c) => c.method === 'PUT').map((c) => c.headers?.['Content-Range']);

function memStorage() {
  const files = new Map<string, unknown>();
  return {
    files,
    loadJson: async <T,>(name: string) => (files.get(name) ?? null) as T | null,
    saveJson: async (name: string, value: unknown) => { files.set(name, value); },
  };
}

function makeUploader(opts: {
  blobs?: boolean;
  size?: number;
  readBinary?: ((path: string) => Promise<ArrayBuffer>) & { mock?: unknown };
  now?: () => number;
} = {}) {
  const index = new BlobIndex(memStorage());
  const notify = vi.fn();
  const readBinary: (path: string) => Promise<ArrayBuffer> =
    opts.readBinary ?? (async () => BYTES.slice().buffer);
  const uploader = new BlobUploader({
    index,
    serverUrl: () => 'https://s.example.com',
    peerId: () => 'peer-1',
    getJwt: async () => 'jwt-1',
    blobsEnabled: async () => opts.blobs !== false,
    stat: async () => ({ size: opts.size ?? BYTES.length }),
    readBinary,
    notify,
    isMobile: false,
    sleep: async () => undefined,
    now: opts.now ?? (() => 0),
  });
  return { uploader, index, notify, readBinary };
}

const resp = (status: number, json: Record<string, unknown> = {}) => ({ status, json });

beforeAll(async () => {
  const bytes = readFileSync(new URL('../../wasm/vaultcrdt_wasm_bg.wasm', import.meta.url));
  await initWasmModule({ module_or_path: bytes });
});
beforeEach(() => { mockRequestUrl.mockReset(); });

describe('BlobUploader (attachment lane S2)', () => {
  it('uploads before it references, and never references a failed transfer', async () => {
    const { uploader, index } = makeUploader();
    mockRequestUrl
      .mockResolvedValueOnce(resp(201, { upload_id: 'u1', next_offset: 0, segment_bytes: 4 }))
      .mockResolvedValueOnce(resp(202, { next_offset: 4 }))
      .mockResolvedValueOnce(resp(202, { next_offset: 8 }))
      .mockResolvedValueOnce(resp(201, { hash: blake3_hex(BYTES) }))
      .mockResolvedValueOnce(resp(200, { accepted: true, seq: 7 }));

    uploader.onFileChanged(PATH);
    await uploader.flush();

    expect(urls()).toEqual([
      'POST /vault/blobs/uploads',
      'PUT /vault/blobs/uploads/u1',
      'PUT /vault/blobs/uploads/u1',
      'PUT /vault/blobs/uploads/u1',
      'POST /vault/blob-paths',
    ]);
    expect(ranges()).toEqual(['bytes 0-3/10', 'bytes 4-7/10', 'bytes 8-9/10']);
    const entry = index.get(PATH)!;
    expect(entry.lastRemoteHash).toBe(blake3_hex(BYTES));
    expect(entry.seq).toBe(7);
    expect(entry.generation).toBe(1);
    expect(index.maxSeq()).toBe(7);
  });

  it('never calls blob-paths when a segment keeps failing', async () => {
    const { uploader, index } = makeUploader();
    mockRequestUrl
      .mockResolvedValueOnce(resp(201, { upload_id: 'u1', next_offset: 0, segment_bytes: 4 }))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(resp(200, { next_offset: 4 })) // resume probe
      .mockRejectedValueOnce(new Error('network again'));

    uploader.onFileChanged(PATH);
    await uploader.flush();

    expect(urls()).toEqual([
      'POST /vault/blobs/uploads',
      'PUT /vault/blobs/uploads/u1',
      'GET /vault/blobs/uploads/u1',
      'PUT /vault/blobs/uploads/u1',
    ]);
    expect(index.get(PATH)).toBeUndefined();
  });

  it('short-circuits on dedup: no PUT, one blob-paths', async () => {
    const { uploader } = makeUploader();
    mockRequestUrl
      .mockResolvedValueOnce(resp(200, { exists: true }))
      .mockResolvedValueOnce(resp(200, { accepted: true, seq: 3 }));

    uploader.onFileChanged(PATH);
    await uploader.flush();

    expect(urls()).toEqual(['POST /vault/blobs/uploads', 'POST /vault/blob-paths']);
  });

  it('suppresses echo when lastRemoteHash matches the recomputed hash', async () => {
    const { uploader, index } = makeUploader();
    index.update(PATH, { hash: blake3_hex(BYTES), lastRemoteHash: blake3_hex(BYTES) });

    uploader.onFileChanged(PATH);
    await uploader.flush();

    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('skips oversized files before reading, and notices only once per path', async () => {
    const readBinary = vi.fn(async (_path: string) => new ArrayBuffer(0));
    const { uploader, index, notify } = makeUploader({ size: 11 * 1024 * 1024, readBinary });

    uploader.onFileChanged(PATH);
    await uploader.flush();
    uploader.onFileChanged(PATH);
    await uploader.flush();

    expect(readBinary).not.toHaveBeenCalled();
    expect(mockRequestUrl).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(index.get(PATH)!.skipped).toBe(true);
  });

  it('resumes at the offset a 409 reports', async () => {
    const { uploader } = makeUploader();
    mockRequestUrl
      .mockResolvedValueOnce(resp(201, { upload_id: 'u1', next_offset: 0, segment_bytes: 4 }))
      .mockResolvedValueOnce(resp(409, { next_offset: 8 }))
      .mockResolvedValueOnce(resp(201, { hash: blake3_hex(BYTES) }))
      .mockResolvedValueOnce(resp(200, { accepted: true, seq: 1 }));

    uploader.onFileChanged(PATH);
    await uploader.flush();

    expect(ranges()).toEqual(['bytes 0-3/10', 'bytes 8-9/10']);
  });

  it('re-uploads once on 412 and then fails without touching the index', async () => {
    const { uploader, index } = makeUploader();
    const segments = () => [
      resp(201, { upload_id: 'u1', next_offset: 0, segment_bytes: 16 }),
      resp(201, { hash: blake3_hex(BYTES) }),
    ];
    for (const r of segments()) mockRequestUrl.mockResolvedValueOnce(r);
    mockRequestUrl.mockResolvedValueOnce(resp(412, {}));
    for (const r of segments()) mockRequestUrl.mockResolvedValueOnce(r);
    mockRequestUrl.mockResolvedValueOnce(resp(412, {}));

    uploader.onFileChanged(PATH);
    await uploader.flush();

    expect(urls()).toEqual([
      'POST /vault/blobs/uploads', 'PUT /vault/blobs/uploads/u1', 'POST /vault/blob-paths',
      'POST /vault/blobs/uploads', 'PUT /vault/blobs/uploads/u1', 'POST /vault/blob-paths',
    ]);
    expect(index.get(PATH)).toBeUndefined();
  });

  it('catch-up records hydrated:false for changed hashes and advances max_seq', async () => {
    const { uploader, index } = makeUploader();
    const entry = index.update(PATH, { hash: 'aaa', seq: 4, lastRemoteHash: 'aaa' })!;
    mockRequestUrl.mockResolvedValueOnce(resp(200, {
      states: [
        { path_key: entry.key, state: 'live', content_hash: 'bbb', seq: 9 },
        { path_key: 'unknown-key', state: 'live', content_hash: 'ccc', seq: 11 },
      ],
      max_seq: 11,
    }));

    await uploader.catchUp();

    expect(urls()).toEqual(['GET /vault/blob-paths?since_seq=4&limit=1000']);
    expect(index.get(PATH)!.hydrated).toBe(false);
    expect(index.maxSeq()).toBe(11);
  });

  it('is fully dormant without the blobs feature', async () => {
    const { uploader } = makeUploader({ blobs: false });
    uploader.onFileChanged(PATH);
    await uploader.flush();
    await uploader.catchUp();
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });
});
